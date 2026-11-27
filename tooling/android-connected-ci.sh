#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || -z $1 || -z $2 ]]; then
  printf 'Usage: bash tooling/android-connected-ci.sh APK EVIDENCE_DIR\n' >&2
  exit 2
fi

umask 077
mkdir -p -- "$2"
evidence_dir=$(cd -- "$2" && pwd -P)
receipt="$evidence_dir/connected-api.txt"
failure_receipt="$evidence_dir/connected-api-failure.txt"
if [[ -e "$receipt" || -e "$failure_receipt" || -e "$evidence_dir/runner.txt" || -e "$evidence_dir/checkout" ]]; then
  printf 'Use a fresh connected Android evidence directory.\n' >&2
  exit 2
fi

phase='Verify the connected Android build host'
scratch=''
api_pid=''
database_owned=false

finish() {
  local result=$? cleanup_failed=false log attempt
  trap - EXIT
  trap '' INT TERM
  set +e
  if [[ -n "$api_pid" ]]; then
    if kill -0 "$api_pid" 2>/dev/null; then
      kill "$api_pid" 2>/dev/null
      for ((attempt = 0; attempt < 15; attempt++)); do
        kill -0 "$api_pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$api_pid" 2>/dev/null; then kill -KILL "$api_pid" 2>/dev/null || cleanup_failed=true; fi
    fi
    if ! $cleanup_failed; then wait "$api_pid" 2>/dev/null; fi
  fi
  if $database_owned; then
    timeout --kill-after=5s 35s "${compose[@]}" down --volumes --timeout 12 >"$scratch/cleanup.log" 2>&1 \
      || cleanup_failed=true
  fi
  if (( result != 0 )) || $cleanup_failed; then
    for log in gradle postgres api cleanup; do
      if [[ -n "$scratch" && -f "$scratch/$log.log" ]]; then
        tail -n 100 "$scratch/$log.log" >"$evidence_dir/connected-$log.log"
      fi
    done
  fi
  if [[ -n "$scratch" ]]; then rm -rf -- "$scratch" || cleanup_failed=true; fi
  if $cleanup_failed; then
    if (( result == 0 )); then phase='Clean up the connected Android fixture'; result=1; fi
    printf 'Fixture cleanup: failed\n' >> "$receipt"
  else
    printf 'Fixture cleanup: complete\n' >> "$receipt"
  fi
  if (( result == 0 )); then
    printf 'Result: passed\n' >> "$receipt"
  else
    printf 'Result: failed\nPhase: %s\nExit code: %s\n' "$phase" "$result" | tee "$failure_receipt" >&2
  fi
  exit "$result"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Scope: Local Release checkout on Android 9 with synthetic payment and a disposable database.\n' > "$receipt"

test "$(uname -sm)" = 'Linux x86_64'
apk=$(realpath -- "$1")
test -s "$apk"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source_sha=$(git rev-parse HEAD)
test "$source_sha" = "${GITHUB_SHA:?Set GITHUB_SHA to the checkout revision}"
server_status=$(git status --porcelain -- server)
test -z "$server_status"
java_bin=$(command -v java)
java_version=$(env -i PATH="$PATH" "$java_bin" -version 2>&1)
[[ $java_version =~ version\ \"21[.\"] ]] || { printf 'Java 21 is required.\n' >&2; exit 1; }
apk_sha=$(sha256sum "$apk" | cut -d ' ' -f 1)
printf 'Source SHA: %s\nAPK SHA-256: %s\n' "$source_sha" "$apk_sha" >> "$receipt"

for port in 18080 55432; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Fixture port %s is already in use.\n' "$port" >&2
    exit 1
  fi
done
scratch=$(mktemp -d "${RUNNER_TEMP:-/tmp}/crustcaper-android-fixture.XXXXXXXX")
project="crustcaper-android28-$(printf '%s' "${scratch##*.}" | tr '[:upper:]' '[:lower:]')"
compose=(docker --context default compose --env-file /dev/null --project-name "$project" --file "$PWD/server/compose.local.yml")

phase='Build the Spring Boot fixture'
printf '\n%s\n' "$phase"
( cd server && env -u JAVA_TOOL_OPTIONS -u JDK_JAVA_OPTIONS -u _JAVA_OPTIONS -u GRADLE_OPTS \
  bash ./gradlew --no-daemon clean bootJar ) >"$scratch/gradle.log" 2>&1
jar="$PWD/server/build/libs/crustcaper-api.jar"
test -s "$jar"
jar_sha=$(sha256sum "$jar" | cut -d ' ' -f 1)
printf 'API JAR SHA-256: %s\n' "$jar_sha" >> "$receipt"

phase='Start the disposable PostgreSQL fixture'
printf '\n%s\n' "$phase"
database_owned=true
timeout --kill-after=5s 4m "${compose[@]}" up -d --wait --wait-timeout 60 >"$scratch/postgres.log" 2>&1
database_version=$(timeout --kill-after=2s 10s "${compose[@]}" exec -T postgres postgres --version 2>>"$scratch/postgres.log")
[[ $database_version =~ ^postgres\ \(PostgreSQL\)\ 17\.[0-9]+$ ]]
printf 'Database: %s\n' "$database_version" >> "$receipt"

phase='Start the local API and confirm loopback readiness'
printf '\n%s\n' "$phase"
origin='http://127.0.0.1:18080'
env -i PATH="$PATH" CRUSTCAPER_PORT=18080 \
  CRUSTCAPER_DB_URL='jdbc:postgresql://127.0.0.1:55432/crustcaper_dev' \
  CRUSTCAPER_DB_USER=crustcaper CRUSTCAPER_DB_PASSWORD=crustcaper-local \
  CRUSTCAPER_ORDER_ACCESS_PROVIDER=local CRUSTCAPER_ORDER_ACCESS_NEGATIVE_DELAY=PT0S \
  "$java_bin" -jar "$jar" --spring.config.location=classpath:/ --spring.profiles.active=local \
  --server.address=127.0.0.1 --crustcaper.payment.provider=local --crustcaper.push.provider=disabled \
  >"$scratch/api.log" 2>&1 &
api_pid=$!
ready=false
for ((attempt = 0; attempt < 45; attempt++)); do
  kill -0 "$api_pid" 2>/dev/null || break
  if lsof -nP -a -p "$api_pid" -iTCP@127.0.0.1:18080 -sTCP:LISTEN >/dev/null 2>&1 \
    && curl --noproxy '*' --fail --silent --max-time 1 "$origin/actuator/health/readiness" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
$ready || { printf 'The task-owned API did not become ready on loopback.\n' >&2; exit 1; }
printf 'API readiness: UP at %s\n' "$origin" >> "$receipt"

phase='Run the connected Release checkout on Android 9'
printf '\n%s\n' "$phase"
bash tooling/run-android-emulator-ci.sh "$apk" local "$evidence_dir" 28

phase='Verify the Android 9 checkout receipt and candidate APK'
for fact in "source_sha=$source_sha" profile=local runtime_api=28 smoke_exit_status=0; do
  grep -Fxq -- "$fact" "$evidence_dir/runner.txt"
done
python3 - "$evidence_dir/checkout/evidence.json" "$apk_sha" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as evidence:
    checkout = json.load(evidence)
if checkout.get("result") != "passed" or checkout.get("profile") != "local" or checkout.get("androidApi") != 28 \
        or checkout.get("apkSha256") != sys.argv[2]:
    sys.exit("Checkout evidence did not verify the exact APK on Android API 28.")
PY
printf 'Android runtime API: 28\nVerified checkout: local profile and matching APK hash.\n' >> "$receipt"
