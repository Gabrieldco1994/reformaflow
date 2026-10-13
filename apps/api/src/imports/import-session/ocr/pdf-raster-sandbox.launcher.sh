#!/bin/bash
set -euo pipefail

fail() {
  printf '%s\n' SANDBOX_UNAVAILABLE
  exit 70
}

[[ "${1:-}" == "--no-network" ]] || fail
[[ "${2:-}" =~ ^[0-9]+$ ]] || fail
[[ "${3:-}" =~ ^[0-9]+$ ]] || fail
[[ -n "${PDF_SANDBOX_RUN_DIR:-}" && -n "${PDF_SANDBOX_WORKER:-}" ]] || fail
[[ -d "$PDF_SANDBOX_RUN_DIR" && -f "$PDF_SANDBOX_WORKER" ]] || fail

/usr/bin/bwrap \
  --unshare-all \
  --die-with-parent \
  --cap-drop ALL \
  --clearenv \
  --ro-bind /usr /usr \
  --ro-bind-try /lib /lib \
  --ro-bind-try /lib64 /lib64 \
  --ro-bind-try /etc/fonts /etc/fonts \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --bind "$PDF_SANDBOX_RUN_DIR" /work \
  --ro-bind "$PDF_SANDBOX_WORKER" /worker.sh \
  --chdir /work \
  --setenv PATH /usr/bin:/bin \
  --setenv HOME /work \
  --setenv TMPDIR /work/tmp \
  --setenv LANG C \
  --setenv LC_ALL C \
  --setenv PDF_SANDBOX_ADDRESS_SPACE "$2" \
  --setenv PDF_SANDBOX_OPEN_FILES "$3" \
  /bin/bash /worker.sh ||
  fail
