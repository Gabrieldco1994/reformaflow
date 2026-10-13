#!/bin/sh
set -eu

readonly AUDITOR='/app/audit-vault-fk-baseline.mjs'
readonly AUDITOR_SHA256='cbe10b80dec7cf1a2600987551253ac64aee3973e31c167f84b5e5fdcf23170b'
readonly DATABASE='/data/dev.db'
readonly MANIFEST='/data/vault-fk-baseline.private.json'
readonly AUTHORIZATION='/data/vault-fk-baseline.authorization.json'
readonly MOUNT_ROOT='/data'

if [ "$#" -ne 1 ]; then
  echo 'vault FK baseline launcher: invalid arguments' >&2
  exit 64
fi

case "$1" in
  capture|compare) readonly MODE="$1" ;;
  *)
    echo 'vault FK baseline launcher: invalid mode' >&2
    exit 64
    ;;
esac

if [ -z "${VAULT_FK_RELEASE_SHA:-}" ] ||
  [ -z "${VAULT_FK_RELEASE_ID:-}" ] ||
  [ -z "${VAULT_FK_IMAGE_DIGEST:-}" ] ||
  [ -z "${VAULT_FK_AUTHORIZATION_SHA256:-}" ] ||
  [ -z "${VAULT_FK_WINDOW_ID:-}" ] ||
  [ -z "${VAULT_FK_WINDOW_START:-}" ] ||
  [ -z "${VAULT_FK_WINDOW_END:-}" ]
then
  echo 'vault FK baseline launcher: incomplete authorization' >&2
  exit 64
fi

if [ ! -f "$AUDITOR" ] || [ -L "$AUDITOR" ]; then
  echo 'vault FK baseline launcher: auditor unavailable' >&2
  exit 1
fi

if [ ! -f "$DATABASE" ] || [ -L "$DATABASE" ] ||
  [ "$(stat -c '%h' "$DATABASE" 2>/dev/null || true)" != '1' ]
then
  echo 'vault FK baseline launcher: database identity rejected' >&2
  exit 1
fi

mount_record="$(findmnt -rn -T "$MOUNT_ROOT" -o TARGET,FSTYPE,OPTIONS 2>/dev/null || true)"
mount_target="$(printf '%s\n' "$mount_record" | awk 'NR == 1 { print $1 }')"
mount_type="$(printf '%s\n' "$mount_record" | awk 'NR == 1 { print $2 }')"
mount_options="$(printf '%s\n' "$mount_record" | awk 'NR == 1 { print $3 }')"
if [ "$(printf '%s\n' "$mount_record" | wc -l | tr -d ' ')" != '1' ] ||
  [ "$mount_target" != "$MOUNT_ROOT" ] ||
  [ "$mount_type" != 'ext4' ] ||
  ! printf '%s\n' "$mount_options" | grep -Eq '(^|,)rw(,|$)' ||
  [ "$(stat -c '%d' "$DATABASE")" != "$(stat -c '%d' "$MOUNT_ROOT")" ]
then
  echo 'vault FK baseline launcher: mount identity rejected' >&2
  exit 1
fi

if ! printf '%s  %s\n' "$AUDITOR_SHA256" "$AUDITOR" |
  sha256sum --check --status -
then
  echo 'vault FK baseline launcher: auditor checksum mismatch' >&2
  exit 1
fi

exec node "$AUDITOR" "$MODE" \
  --database "$DATABASE" \
  --mount-root "$MOUNT_ROOT" \
  --manifest "$MANIFEST" \
  --authorization "$AUTHORIZATION" \
  --authorization-sha256 "$VAULT_FK_AUTHORIZATION_SHA256" \
  --release-sha "$VAULT_FK_RELEASE_SHA" \
  --release-id "$VAULT_FK_RELEASE_ID" \
  --image-digest "$VAULT_FK_IMAGE_DIGEST" \
  --auditor-sha256 "$AUDITOR_SHA256" \
  --window-id "$VAULT_FK_WINDOW_ID" \
  --window-start "$VAULT_FK_WINDOW_START" \
  --window-end "$VAULT_FK_WINDOW_END"
