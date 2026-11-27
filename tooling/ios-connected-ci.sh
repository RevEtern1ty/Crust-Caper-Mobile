#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z $1 ]]; then
  printf 'Usage: bash tooling/ios-connected-ci.sh EVIDENCE_DIR\n' >&2
  exit 2
fi
if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  printf 'An Apple silicon runner is required for the connected iOS smoke.\n' >&2
  exit 1
fi

mkdir -p -- "$1"
evidence_dir=$(cd -- "$1" && pwd -P)
simulator_evidence="$evidence_dir/simulator"
checkout_smoke=${CRUSTCAPER_IOS_ORDER_SMOKE:-0}
if [[ -e "$evidence_dir/connected.txt" || -e "$evidence_dir/connected-failure.txt" ]] \
  || ! mkdir -- "$simulator_evidence"; then
  printf 'Use a fresh connected iOS evidence directory.\n' >&2
  exit 2
fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."

phase='Verify the build host'
scratch_dir=''
pg_data=''
api_pid=''
access_log=''

finish() {
  local result=$? cleanup_failed=false logfile
  trap - EXIT
  trap '' INT TERM
  set +e
  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null
    for ((attempt = 0; attempt < 15; attempt++)); do
      kill -0 "$api_pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$api_pid" 2>/dev/null; then
      kill -KILL "$api_pid" 2>/dev/null || cleanup_failed=true
    fi
  fi
  if [[ -n "$api_pid" ]] && ! $cleanup_failed; then wait "$api_pid" 2>/dev/null; fi
  if [[ -n "$pg_data" && -f "$pg_data/postmaster.pid" ]]; then
    "$pg_bin/pg_ctl" -D "$pg_data" -m fast -w -t 15 stop \
      || "$pg_bin/pg_ctl" -D "$pg_data" -m immediate -w -t 10 stop \
      || cleanup_failed=true
  fi
  if (( result != 0 )) || $cleanup_failed; then
    printf 'Phase: %s\nExit code: %s\n' "$phase" "$result" > "$evidence_dir/connected-failure.txt"
    if [[ -n "$scratch_dir" ]]; then
      for logfile in gradle.log postgres.log api.log; do
        if [[ -f "$scratch_dir/$logfile" ]]; then cp "$scratch_dir/$logfile" "$evidence_dir/"; fi
      done
    fi
    if [[ -n "$access_log" && -f "$access_log" ]]; then
      grep -E '^GET (/actuator/health/readiness +|/api/v1/stores/kigali/menu \?channel=(web|mobile) )[1-5][0-9]{2}$' \
        "$access_log" > "$evidence_dir/fixture-access.txt"
    fi
  fi
  if [[ -n "$scratch_dir" ]] && ! $cleanup_failed; then
    rm -rf -- "$scratch_dir" || cleanup_failed=true
  fi
  if $cleanup_failed; then
    printf 'Fixture cleanup failed. Scratch: %s\n' "$scratch_dir" \
      | tee -a "$evidence_dir/connected-failure.txt" >&2
    exit 1
  fi
  if (( result == 0 )); then
    printf 'Fixture cleanup: API process and temporary PostgreSQL stopped.\n' >> "$evidence_dir/connected.txt"
  else
    printf 'Connected iOS smoke failed during %s.\n' "$phase" >&2
  fi
  exit "$result"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

await_menu_request() {
  local expected=$1 attempt
  for ((attempt = 0; attempt < 12; attempt++)); do
    kill -0 "$api_pid" 2>/dev/null || break
    if [[ -f "$access_log" ]] && grep -Fxq "$expected" "$access_log"; then return 0; fi
    sleep 0.25
  done
  printf 'The running fixture access log did not contain %s.\n' "$expected" >&2
  return 1
}

checkout_counts() {
  env -i PATH="$PATH" PGPASSWORD="$db_password" PGCONNECT_TIMEOUT=3 \
    PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000' \
    "$pg_bin/psql" -XAtqw -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$pg_port" -U crustcaper -d crustcaper_dev -F '|' <<'SQL'
WITH paid AS (
    SELECT id FROM public.orders
    WHERE store_id = 'kigali' AND checkout_channel = 'mobile'
      AND status = 'accepted' AND payment_status = 'paid' AND accepted_at IS NOT NULL
)
SELECT (SELECT count(*) FROM public.orders),
       (SELECT count(*) FROM paid),
       (SELECT count(*) FROM public.payment_attempts),
       (SELECT count(*) FROM public.payment_attempts attempt JOIN paid ON paid.id = attempt.order_id
        WHERE attempt.status = 'paid' AND attempt.verified_at IS NOT NULL
          AND attempt.provider_transaction_id = 'local-' || attempt.id::text);
SQL
}

if [[ -e ios || -L ios ]]; then
  printf 'Run the connected smoke in a fresh checkout without a generated ios project.\n' >&2
  exit 2
fi
source_sha=$(git rev-parse HEAD)
java_bin=$(command -v java)
java_version=$("$java_bin" -version 2>&1)
if [[ ! $java_version =~ version\ \"21[.\"] ]]; then
  printf 'Java 21 is required to build and run the Spring Boot fixture.\n' >&2
  exit 1
fi
pg_bin="$(brew --prefix postgresql@17)/bin"
pg_version=$("$pg_bin/postgres" --version)
if [[ $pg_version != 'postgres (PostgreSQL) 17.'* ]]; then
  printf 'The fixture requires PostgreSQL 17.\n' >&2
  exit 1
fi

api_port=18080
pg_port=55432
for port in "$api_port" "$pg_port"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN; then
    printf 'Fixture port %s is already in use.\n' "$port" >&2
    exit 1
  fi
done
scratch_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/crustcaper-ios-fixture.XXXXXX")

phase='Build the Spring Boot fixture'
printf '\n%s\n' "$phase"
(cd server && bash ./gradlew --no-daemon clean bootJar) > "$scratch_dir/gradle.log" 2>&1
jar="$PWD/server/build/libs/crustcaper-api.jar"
test -s "$jar"
jar_sha=$(shasum -a 256 "$jar" | cut -d ' ' -f 1)

phase='Start a fresh PostgreSQL fixture'
printf '\n%s\n' "$phase"
pg_data="$scratch_dir/postgres"
password_file="$scratch_dir/pg-password"
db_password=$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')
(umask 077; printf '%s\n' "$db_password" > "$password_file")
"$pg_bin/initdb" -D "$pg_data" --username=crustcaper --auth=scram-sha-256 \
  --pwfile="$password_file" --no-locale --encoding=UTF8 > "$scratch_dir/postgres.log" 2>&1
rm -- "$password_file"
"$pg_bin/pg_ctl" -D "$pg_data" -w -t 30 -l "$scratch_dir/postgres.log" \
  -o "-h 127.0.0.1 -p $pg_port -c unix_socket_directories=''" start
PGPASSWORD="$db_password" PGCONNECT_TIMEOUT=3 "$pg_bin/createdb" \
  -h 127.0.0.1 -p "$pg_port" -U crustcaper crustcaper_dev

phase='Start the local API and wait for readiness'
printf '\n%s\n' "$phase"
origin="http://127.0.0.1:$api_port"
access_log="$scratch_dir/menu-access.log"
receipt_provider=''
if [[ ${CRUSTCAPER_IOS_RECEIPT_SMOKE:-0} == 1 ]]; then
  receipt_provider=CRUSTCAPER_ORDER_ACCESS_PROVIDER=local
fi
env -i PATH="$PATH" CRUSTCAPER_PORT="$api_port" \
  CRUSTCAPER_DB_URL="jdbc:postgresql://127.0.0.1:$pg_port/crustcaper_dev" \
  CRUSTCAPER_DB_USER=crustcaper CRUSTCAPER_DB_PASSWORD="$db_password" \
  ${receipt_provider:+"$receipt_provider"} \
  "$java_bin" -jar "$jar" --spring.profiles.active=local \
  --server.address=127.0.0.1 --crustcaper.payment.provider=local --crustcaper.push.provider=disabled \
  --server.tomcat.accesslog.enabled=true --server.tomcat.accesslog.buffered=false \
  --server.tomcat.accesslog.rotate=false --server.tomcat.accesslog.directory="$scratch_dir" \
  --server.tomcat.accesslog.prefix=menu-access --server.tomcat.accesslog.suffix=.log \
  '--server.tomcat.accesslog.pattern=%m %U %q %s' > "$scratch_dir/api.log" 2>&1 &
api_pid=$!
if [[ "$checkout_smoke" != 1 ]]; then unset db_password; fi
ready=false
for ((attempt = 0; attempt < 45; attempt++)); do
  kill -0 "$api_pid" 2>/dev/null || break
  if curl --noproxy '*' --fail --silent --max-time 1 "$origin/actuator/health/readiness" >/dev/null \
    && lsof -nP -a -p "$api_pid" -iTCP@127.0.0.1:"$api_port" -sTCP:LISTEN >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if ! $ready; then
  printf 'The local API did not become ready on %s.\n' "$origin" >&2
  exit 1
fi

phase='Verify the menu and access logging before the iOS build'
printf '\n%s\n' "$phase"
curl --noproxy '*' --fail --silent --show-error --max-time 5 "$origin/api/v1/stores/kigali/menu?channel=web" >/dev/null
await_menu_request 'GET /api/v1/stores/kigali/menu ?channel=web 200'

if [[ "$checkout_smoke" == 1 ]]; then
  phase='Verify the checkout fixture starts without orders or attempts'
  printf '\n%s\n' "$phase"
  before_checkout=$(checkout_counts)
  if [[ "$before_checkout" != '0|0|0|0' ]]; then
    printf 'Unexpected initial checkout counts: %s\n' "$before_checkout" >&2
    exit 1
  fi
fi

phase='Run the local Release on the iPhone simulator'
printf '\n%s\n' "$phase"
CRUSTCAPER_API_BASE_URL="$origin/api/v1" CRUSTCAPER_STORE_ID=kigali \
  bash tooling/ios-simulator-smoke.sh "$simulator_evidence" local 2>&1 | tee "$simulator_evidence/smoke.log"

phase='Verify the simulator fetched the menu from the local API'
printf '\n%s\n' "$phase"
menu_request='GET /api/v1/stores/kigali/menu ?channel=mobile 200'
await_menu_request "$menu_request"
if [[ "$checkout_smoke" == 1 ]]; then
  phase='Verify one accepted order and one verified payment attempt'
  printf '\n%s\n' "$phase"
  after_checkout=$(checkout_counts)
  unset db_password
  printf 'Columns: orders | accepted paid mobile orders in Kigali | payment attempts | matching verified attempts\nBefore: %s\nAfter: %s\nPayment provider: local\n' \
    "$before_checkout" "$after_checkout" | tee "$evidence_dir/checkout-persistence.txt"
  test "$after_checkout" = '1|1|1|1'
  printf 'Result: passed\n' >> "$evidence_dir/checkout-persistence.txt"
fi
printf 'Source SHA: %s\nAPI JAR SHA-256: %s\nDatabase: %s\nAPI readiness: UP at %s\nMobile request: %s\nScope: iOS Release simulator boot and HTTP menu retrieval from the Spring Boot/PostgreSQL fixture.\n' \
  "$source_sha" "$jar_sha" "$pg_version" "$origin" "$menu_request" | tee "$evidence_dir/connected.txt"
