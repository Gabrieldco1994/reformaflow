#!/bin/bash
set -euo pipefail

if [[ -f /work/probe-hang ]]; then
  trap '' TERM
  /bin/bash -c 'trap "" TERM; while :; do sleep 1; done' &
  while :; do sleep 1; done
fi

[[ ! -e /app && ! -e /data ]] || {
  printf '%s\n' APPLICATION_PATH_VISIBLE
  exit 71
}
[[ -z "${GEMINI_API_KEY:-}" && -z "${DATABASE_URL:-}" ]] || {
  printf '%s\n' SECRET_VISIBLE
  exit 72
}

for fd in /proc/self/fd/*; do
  number="${fd##*/}"
  if (( number > 2 )); then
    target="$(readlink "$fd" 2>/dev/null || true)"
    [[ "$target" == "/worker.sh" || "$target" == "/proc/"*"/fd" ]] || {
      printf '%s\n' EXTRA_FD
      exit 73
    }
  fi
done

if [[ -f /work/probe-network ]]; then
  read -r port </work/probe-network
  if /usr/bin/timeout 2 /bin/bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" \
    >/dev/null 2>&1; then
    printf '%s\n' NETWORK_AVAILABLE
    exit 74
  fi
fi
