#!/usr/bin/env bash
set -euo pipefail

# Compose gives the caller's environment precedence over --env-file.
for variable in "${!CRUSTCAPER_@}"; do
  unset "$variable"
done

exec docker compose "$@"
