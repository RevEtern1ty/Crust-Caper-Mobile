# Sourced by the backup and restore entry points before any database command.
require_postgres_connection() {
  local database=$1
  local ca=${PGSSLROOTCERT:-}
  if [[ -n ${PGSERVICE:-} || "$PGHOST${PGHOSTADDR:-}${PGPORT:-}" == *,* ||
    $database == *=* || $database == postgres://* || $database == postgresql://* ]]; then
    printf 'Use a plain database name and a single explicit PostgreSQL endpoint.\n' >&2
    return 2
  fi

  if [[ $PGHOST == /* && -z ${PGHOSTADDR:-} ]]; then
    return
  fi
  if [[ $PGHOST == /* || $PGHOST == @* || ${PGSSLMODE:-} != verify-full ||
    $ca != /* || ! -f $ca || ! -s $ca || ! -r $ca ]]; then
    printf 'Network PostgreSQL requires PGSSLMODE=verify-full and an absolute readable PGSSLROOTCERT file.\n' >&2
    return 2
  fi
  # libpq otherwise prefers GSS encryption when available, even in verify-full mode.
  export PGGSSENCMODE=disable
}
