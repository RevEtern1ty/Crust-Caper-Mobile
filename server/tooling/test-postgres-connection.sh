#!/usr/bin/env bash
set -euo pipefail

# Record calls to the PostgreSQL commands without opening a connection.
tooling_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export CC_TEST_PG_CALLS="$scratch/calls"
export PGHOST=db.example.test PGUSER=fixture PGDATABASE=fixture PGPORT=5432
unset PGHOSTADDR PGSERVICE PGSSLMODE PGSSLROOTCERT PGGSSENCMODE
mkdir -- "$scratch/bin"
cat > "$scratch/bin/pg_dump" <<'SH'
#!/usr/bin/env bash
printf '%s:%s\n' "${0##*/}" "${PGGSSENCMODE:-unset}" >> "$CC_TEST_PG_CALLS"
for arg; do
  if [[ $arg == --file=* ]]; then printf 'test archive\n' > "${arg#--file=}"; fi
done
SH
cat > "$scratch/bin/pg_restore" <<'SH'
#!/usr/bin/env bash
printf '%s:%s\n' "${0##*/}" "${PGGSSENCMODE:-unset}" >> "$CC_TEST_PG_CALLS"
SH
cp -- "$scratch/bin/pg_restore" "$scratch/bin/createdb"
chmod 700 "$scratch/bin/"*
export PATH="$scratch/bin:$PATH"
printf 'test archive\n' > "$scratch/input.dump"
printf 'mock CA contents\n' > "$scratch/ca.pem"
digest=$(sha256sum < "$scratch/input.dump")

expect_rejection() {
  : > "$CC_TEST_PG_CALLS"
  local status=0
  "$@" > "$scratch/rejected.log" 2>&1 || status=$?
  if [[ $status != 2 || -s $CC_TEST_PG_CALLS ]]; then
    printf 'Unexpected result for the connection preflight (status %s).\n' "$status" >&2
    exit 1
  fi
}

expect_rejection bash "$tooling_dir/backup-postgres.sh" "$scratch/no-policy.dump"
expect_rejection env PGSSLMODE=require PGSSLROOTCERT="$scratch/ca.pem" \
  bash "$tooling_dir/restore-postgres.sh" "$scratch/input.dump" restored "${digest%% *}"
expect_rejection env PGSSLMODE=verify-full PGSSLROOTCERT="$scratch/missing.pem" \
  bash "$tooling_dir/backup-postgres.sh" "$scratch/no-ca.dump"
expect_rejection env PGSSLMODE=verify-full PGSSLROOTCERT="$scratch/ca.pem" PGDATABASE='dbname=fixture' \
  bash "$tooling_dir/backup-postgres.sh" "$scratch/connection-string.dump"
expect_rejection env PGSERVICE=alternate PGSSLMODE=verify-full PGSSLROOTCERT="$scratch/ca.pem" \
  bash "$tooling_dir/backup-postgres.sh" "$scratch/service.dump"
expect_rejection env PGHOST=/var/run/postgresql PGHOSTADDR=127.0.0.1 \
  bash "$tooling_dir/backup-postgres.sh" "$scratch/socket-address.dump"

: > "$CC_TEST_PG_CALLS"
env PGSSLMODE=verify-full PGSSLROOTCERT="$scratch/ca.pem" PGGSSENCMODE=prefer \
  bash "$tooling_dir/backup-postgres.sh" "$scratch/verified.dump" >/dev/null
env PGSSLMODE=verify-full PGSSLROOTCERT="$scratch/ca.pem" \
  bash "$tooling_dir/restore-postgres.sh" "$scratch/verified.dump" restored "${digest%% *}" >/dev/null
grep -Fxq 'pg_dump:disable' "$CC_TEST_PG_CALLS"
grep -Fxq 'createdb:disable' "$CC_TEST_PG_CALLS"
grep -Fxq 'pg_restore:disable' "$CC_TEST_PG_CALLS"

: > "$CC_TEST_PG_CALLS"
env PGHOST=/var/run/postgresql bash "$tooling_dir/backup-postgres.sh" "$scratch/socket.dump" >/dev/null
grep -Fxq 'pg_dump:unset' "$CC_TEST_PG_CALLS"
printf 'PostgreSQL backup and restore verified connection policy passed.\n'
