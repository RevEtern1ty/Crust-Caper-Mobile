#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 || ! $2 =~ ^[a-z_][a-z0-9_]{0,62}$ || ! $3 =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Usage: bash restore-postgres.sh ARCHIVE NEW_DATABASE SHA256\n' >&2
  exit 2
fi
: "${PGHOST:?Set the isolated PostgreSQL recovery host}"
: "${PGUSER:?Set the PostgreSQL recovery role}"

archive=$1
database=$2
expected_checksum=$3
maintenance_db=${PGDATABASE:-postgres}
if [[ ! $maintenance_db =~ ^[a-z_][a-z0-9_]{0,62}$ ||
  -n ${PGSERVICE:-} || "$PGHOST${PGHOSTADDR:-}${PGPORT:-}" == *,* ]]; then
  printf 'Use a plain maintenance database name and a single PostgreSQL endpoint for recovery.\n' >&2
  exit 2
fi
if [[ ! -f "$archive" || ! -s "$archive" ]]; then
  printf 'Provide a nonempty PostgreSQL archive file.\n' >&2
  exit 1
fi
umask 077
scratch=$(mktemp -d)
snapshot="$scratch/backup.dump"
cleanup() {
  rm -f -- "$snapshot"
  rmdir -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Verify and restore the same bytes even if a backup sync replaces the input file.
cat -- "$archive" > "$snapshot"
checksum=$(sha256sum < "$snapshot")
if [[ ${checksum%% *} != "$expected_checksum" ]]; then
  printf 'The archive SHA-256 does not match the backup receipt.\n' >&2
  exit 1
fi
pg_restore --list -- "$snapshot" > /dev/null

createdb --no-password --template=template0 --maintenance-db="$maintenance_db" -- "$database"
if ! pg_restore --no-password --exit-on-error --single-transaction \
  --no-owner --no-privileges --no-tablespaces --dbname="$database" -- "$snapshot"; then
  printf 'Restore failed after creating %s. Keep it out of service and inspect the error before retrying with a new name.\n' "$database" >&2
  exit 1
fi
printf 'Restored database %s. Verify the application and reconcile payments before cutover.\n' "$database"
