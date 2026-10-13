#!/bin/sh
set -eu

readonly TOOL="/app/v749-db-manifest.mjs"
readonly TOOL_SHA256="3d67f8731ac2b25d366e41ef87db43d8bb71ee1c832f30a2e413d1e7527e0ba5"

if [ "$#" -ne 1 ]; then
  echo "v749 compatibility: invalid arguments" >&2
  exit 64
fi

if printenv ADMIN_USERNAME >/dev/null 2>&1 ||
  printenv ADMIN_PASSWORD >/dev/null 2>&1 ||
  printenv ADMIN_EMAIL >/dev/null 2>&1
then
  echo "v749 compatibility: admin bootstrap environment present" >&2
  exit 1
fi

case "$1" in
  check)
    exit 0
    ;;
  boot)
    exec /entrypoint.sh
    ;;
  capture|compare)
    if [ ! -f "$TOOL" ] || [ -L "$TOOL" ]; then
      echo "v749 compatibility: manifest tool unavailable" >&2
      exit 1
    fi
    if ! printf "%s  %s\n" "$TOOL_SHA256" "$TOOL" |
      sha256sum --check --status -
    then
      echo "v749 compatibility: manifest tool checksum mismatch" >&2
      exit 1
    fi
    exec node "$TOOL" "$1"
    ;;
  *)
    echo "v749 compatibility: invalid mode" >&2
    exit 64
    ;;
esac
