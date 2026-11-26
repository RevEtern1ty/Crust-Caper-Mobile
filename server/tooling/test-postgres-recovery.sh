#!/usr/bin/env bash
set -euo pipefail

# Run against the disposable PostgreSQL used by the connected browser suite after the API exits.
: "${PGHOST:?Set the synthetic PostgreSQL host}"
: "${PGUSER:?Set the synthetic PostgreSQL user}"
: "${PGDATABASE:?Set the browser suite database}"

tooling_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_db=$PGDATABASE
test_prefix="crustcaper_recovery_${BASHPID}_${RANDOM}_${RANDOM}"
restored_db="${test_prefix}_restored"
checksum_db="${test_prefix}_checksum"
invalid_db="${test_prefix}_invalid"
incomplete_db="${test_prefix}_incomplete"
missing_db="${test_prefix}_missing"

umask 077
scratch=$(mktemp -d)
cleanup_databases=false

psql_db() {
  local database=$1
  shift
  psql --no-psqlrc --no-password --set ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
    --dbname="$database" "$@"
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

assert_absent_database() {
  local found
  found=$(psql_db postgres --set database="$1" \
    <<< "SELECT EXISTS (SELECT FROM pg_database WHERE datname = :'database');")
  [[ $found == f ]] || die "Unexpected database exists: $1"
}

cleanup() {
  local status=$?
  trap - EXIT
  if "$cleanup_databases"; then
    for database in "$restored_db" "$checksum_db" "$invalid_db" "$incomplete_db"; do
      dropdb --if-exists --no-password --maintenance-db=postgres -- "$database" >> "$scratch/cleanup.log" 2>&1 \
        || status=1
    done
  fi
  rm -rf -- "$scratch" || status=1
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for database in "$restored_db" "$checksum_db" "$invalid_db" "$incomplete_db" "$missing_db"; do
  assert_absent_database "$database"
done
cleanup_databases=true

check_fixture() {
  local passed
  passed=$(psql_db "$1" <<'SQL'
SELECT EXISTS (
    SELECT FROM orders AS o
    JOIN payment_attempts AS attempt ON attempt.order_id = o.id AND attempt.status = 'paid'
    JOIN fiscal_receipts AS receipt ON receipt.order_id = o.id AND receipt.total_rwf = o.total
    JOIN operator_order_events AS event ON event.order_id = o.id AND event.requested_status = 'collected'
    WHERE o.status = 'collected' AND o.payment_status = 'paid'
      AND o.receipt_status = 'issued' AND receipt.sha256 = sha256(receipt.document)
) AND EXISTS (
    SELECT FROM orders AS o
    JOIN payment_attempts AS attempt ON attempt.order_id = o.id AND attempt.status = 'paid'
    JOIN payment_exceptions AS exception ON exception.attempt_id = attempt.id
      AND exception.provider_transaction_id = attempt.provider_transaction_id
    JOIN operator_order_events AS event ON event.order_id = o.id
      AND event.requested_status = 'cancelled' AND event.outcome = 'changed'
    WHERE o.status = 'cancelled' AND o.payment_status = 'refund_pending'
      AND exception.reason = 'restaurant_cancelled'
) AND EXISTS (
    SELECT FROM operator_availability_events WHERE action = 'slot_capacity'
) AND EXISTS (
    SELECT FROM flyway_schema_history WHERE success AND version = '13'
) AND NOT EXISTS (
    SELECT FROM flyway_schema_history WHERE NOT success
);
SQL
)
  [[ $passed == t ]] || die 'The synthetic paid receipt, cancelled payment, slot change or migration fixture is missing.'
}

schema_snapshot() {
  pg_dump --no-password --schema-only --no-owner --no-privileges --no-tablespaces --dbname="$1" \
    | sed -E '/^\\(un)?restrict [[:alnum:]]+$/d'
}

data_snapshot() {
  # Compare every public row and sequence while keeping row values out of the transcript.
  PGTZ=UTC PGDATESTYLE='ISO, MDY' psql_db "$1" <<'SQL'
SELECT format($query$
    SELECT %L, count(*), encode(sha256(convert_to(coalesce(string_agg(digest, '' ORDER BY digest), ''), 'UTF8')), 'hex')
    FROM (
        SELECT encode(sha256(convert_to(to_jsonb(row_data)::text, 'UTF8')), 'hex') AS digest
        FROM %I.%I AS row_data
    ) AS fingerprints;
$query$, tablename, schemaname, tablename)
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename COLLATE "C"
\gexec

SELECT format('SELECT %L, last_value, is_called FROM %I.%I;', sequencename, schemaname, sequencename)
FROM pg_sequences
WHERE schemaname = 'public'
ORDER BY sequencename COLLATE "C"
\gexec
SQL
}

checksum() {
  local digest
  digest=$(sha256sum < "$1")
  printf '%s\n' "${digest%% *}"
}

expect_failure() {
  local description=$1
  shift
  if "$@" > "$scratch/rejected.log" 2>&1; then
    die "Unexpected success: $description"
  fi
  printf 'Rejected %s\n' "$description"
}

restore() {
  PGDATABASE=postgres bash "$tooling_dir/restore-postgres.sh" "$@"
}

check_fixture "$source_db"
schema_snapshot "$source_db" > "$scratch/source-schema.sql"
data_snapshot "$source_db" > "$scratch/source-data.txt"

SECONDS=0
archive="$scratch/commerce.pgcustom"
archive_checksum=$(bash "$tooling_dir/backup-postgres.sh" "$archive")
backup_seconds=$SECONDS
[[ $archive_checksum =~ ^[a-f0-9]{64}$ && $(checksum "$archive") == "$archive_checksum" ]] \
  || die 'The backup receipt does not match the archive.'

expect_failure 'a duplicate archive path' bash "$tooling_dir/backup-postgres.sh" "$archive"
[[ $(checksum "$archive") == "$archive_checksum" ]] || die 'A duplicate backup changed the archive.'
expect_failure 'a nonexistent source database' env PGDATABASE="$missing_db" \
  bash "$tooling_dir/backup-postgres.sh" "$scratch/missing.pgcustom"
[[ ! -e "$scratch/missing.pgcustom" ]] || die 'A failed backup published an archive.'
shopt -s nullglob
partials=("$scratch"/.crustcaper-backup.*)
(( ${#partials[@]} == 0 )) || die 'A backup left temporary files behind.'

SECONDS=0
restore "$archive" "$restored_db" "$archive_checksum"
restore_seconds=$SECONDS
check_fixture "$restored_db"
schema_snapshot "$restored_db" > "$scratch/restored-schema.sql"
data_snapshot "$restored_db" > "$scratch/restored-data.txt"
cmp -s "$scratch/source-schema.sql" "$scratch/restored-schema.sql" || die 'Restored schema differs from source.'
cmp -s "$scratch/source-data.txt" "$scratch/restored-data.txt" || die 'Restored row or sequence state differs from source.'

psql_db "$restored_db" <<< 'CREATE TABLE public.recovery_drill_canary (id integer PRIMARY KEY);
INSERT INTO public.recovery_drill_canary VALUES (42);'
expect_failure 'an existing target database' restore "$archive" "$restored_db" "$archive_checksum"
canary=$(psql_db "$restored_db" <<< 'SELECT id FROM public.recovery_drill_canary;')
[[ $canary == 42 ]] || die 'The occupied target database was changed.'

expect_failure 'a maintenance database connection string' env PGDATABASE="dbname=postgres" \
  bash "$tooling_dir/restore-postgres.sh" "$archive" "$invalid_db" "$archive_checksum"
assert_absent_database "$invalid_db"

printf 'not a PostgreSQL archive\n' > "$scratch/invalid.pgcustom"
invalid_checksum=$(checksum "$scratch/invalid.pgcustom")
expect_failure 'a mismatched archive checksum' restore "$scratch/invalid.pgcustom" "$checksum_db" "$archive_checksum"
assert_absent_database "$checksum_db"
expect_failure 'an invalid archive with a valid checksum' restore "$scratch/invalid.pgcustom" "$invalid_db" "$invalid_checksum"
assert_absent_database "$invalid_db"

# Remove the tail data while preserving the archive header and table of contents.
archive_bytes=$(wc -c < "$archive")
head -c "$((archive_bytes - 31))" "$archive" > "$scratch/incomplete.pgcustom"
pg_restore --list "$scratch/incomplete.pgcustom" > /dev/null
incomplete_checksum=$(checksum "$scratch/incomplete.pgcustom")
expect_failure 'an archive truncated after its table of contents' \
  restore "$scratch/incomplete.pgcustom" "$incomplete_db" "$incomplete_checksum"
partial_tables=$(psql_db "$incomplete_db" <<< "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';")
[[ $partial_tables == 0 ]] || die 'A failed restore left partially restored tables.'

printf 'Recovered the synthetic commerce schema, data and sequences (%s archive bytes, backup %ss, restore %ss).\n' \
  "$archive_bytes" "$backup_seconds" "$restore_seconds"
