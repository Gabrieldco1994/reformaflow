#!/bin/bash
set -eu

helper=apps/api/dist/imports/import-session/vault/vault-startup.js
# The helper alone interprets the flag/configuration. FD9 is launcher policy, not sizing.
export IMPORT_VAULT_LOCK_FD="${IMPORT_VAULT_LOCK_FD-9}"
mode=$(node "$helper" prepare)
case "$mode" in
  OFF) ;;
  ON)
    if ! command -v flock >/dev/null 2>&1; then
      echo 'vault_startup:FLOCK_MISSING' >&2
      exit 1
    fi
    # Read-only open: never creates/truncates/replaces a disappeared lock.
    if ! { exec 9< /data/import-vault/.lock; } 2>/dev/null; then
      echo 'vault_startup:LOCK_OPEN_FAILED' >&2
      exit 1
    fi
    if ! flock --exclusive --nonblock 9; then
      echo 'vault_startup:LOCK_COLLISION' >&2
      exit 1
    fi
    node "$helper" verify
    ;;
  *) echo 'vault_startup:BAD_STARTUP_MODE' >&2; exit 1 ;;
esac

# Preserve OFF compatibility and committed migration semantics.
mkdir -p /data/uploads
npx prisma migrate deploy --schema=prisma/schema.prisma
# Same open-file description survives shell -> PID1 API, including the complete drain.
exec node apps/api/dist/main.js
