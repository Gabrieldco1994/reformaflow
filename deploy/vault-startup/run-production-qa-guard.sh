#!/bin/sh
set -eu

readonly GUARD='/app/vault-production-qa-guard.mjs'
readonly GUARD_SHA256='ce70979334200959fabcc343c20fcb83adb752917b4a6ca0daa9429d336eea12'
readonly DATABASE='/data/dev.db'
readonly MOUNT_ROOT='/data'

if [ "$#" -ne 1 ]; then
  echo 'vault production QA launcher: invalid arguments' >&2
  exit 64
fi

case "$1" in
  capture|guard|compare) readonly MODE="$1" ;;
  *)
    echo 'vault production QA launcher: invalid mode' >&2
    exit 64
    ;;
esac

if [ -z "${VAULT_QA_RELEASE_SHA:-}" ] ||
  [ -z "${VAULT_QA_RELEASE_ID:-}" ] ||
  [ -z "${VAULT_QA_IMAGE_DIGEST:-}" ] ||
  [ -z "${VAULT_QA_WINDOW_ID:-}" ] ||
  [ -z "${VAULT_QA_WINDOW_START:-}" ] ||
  [ -z "${VAULT_QA_WINDOW_END:-}" ] ||
  [ -z "${VAULT_QA_ACTOR:-}" ]
then
  echo 'vault production QA launcher: incomplete authorization' >&2
  exit 64
fi

if [ ! -f "$GUARD" ] || [ -L "$GUARD" ]; then
  echo 'vault production QA launcher: guard unavailable' >&2
  exit 1
fi

if [ ! -f "$DATABASE" ] || [ -L "$DATABASE" ] ||
  [ "$(stat -c '%h' "$DATABASE" 2>/dev/null || true)" != '1' ]
then
  echo 'vault production QA launcher: database identity rejected' >&2
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
  echo 'vault production QA launcher: mount identity rejected' >&2
  exit 1
fi

if ! printf '%s  %s\n' "$GUARD_SHA256" "$GUARD" |
  sha256sum --check --status -
then
  echo 'vault production QA launcher: guard checksum mismatch' >&2
  exit 1
fi

exec node "$GUARD" "$MODE"
