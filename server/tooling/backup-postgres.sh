#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z $1 ]]; then
  printf 'Usage: bash backup-postgres.sh NEW_ARCHIVE\n' >&2
  exit 2
fi
: "${PGHOST:?Set the PostgreSQL source host}"
: "${PGUSER:?Set the PostgreSQL backup role}"
: "${PGDATABASE:?Set the PostgreSQL source database}"
source "$(dirname -- "${BASH_SOURCE[0]}")/postgres-connection.sh"
require_postgres_connection "$PGDATABASE"

archive=$1
if [[ -e "$archive" || -L "$archive" ]]; then
  printf 'The output archive already exists. Use a new path.\n' >&2
  exit 1
fi

umask 077
partial=$(mktemp -- "$(dirname -- "$archive")/.crustcaper-backup.XXXXXXXX")
trap 'rm -f -- "$partial"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pg_dump --no-password --format=custom --lock-wait-timeout=10s --file="$partial"
pg_restore --list -- "$partial" > /dev/null
checksum=$(sha256sum < "$partial")
# Link only a complete archive. -T prevents a competing directory from becoming the destination.
ln -T -- "$partial" "$archive"
printf '%s\n' "${checksum%% *}"
