#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_MAX_ATTEMPTS=30
readonly DEFAULT_POLL_INTERVAL_SECONDS=10
readonly MAX_ID_LENGTH=64
readonly MAX_STATE_LENGTH=32
readonly MAX_SHA_LENGTH=64
readonly MAX_IMAGE_LENGTH=192

: "${FLY_APP:?FLY_APP is required}"
: "${EXPECTED_GH_SHA:?EXPECTED_GH_SHA is required}"

MAX_ATTEMPTS="${MAX_ATTEMPTS:-$DEFAULT_MAX_ATTEMPTS}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-$DEFAULT_POLL_INTERVAL_SECONDS}"

if [[ ! "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' "attempt=0/? count=? id=- state=- sha=- image=-" >&2
  exit 2
fi
if [[ ! "$POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]]; then
  printf '%s\n' "attempt=0/$MAX_ATTEMPTS count=? id=- state=- sha=- image=-" >&2
  exit 2
fi
if [[ ! "$EXPECTED_GH_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "attempt=0/$MAX_ATTEMPTS count=? id=- state=- sha=- image=-" >&2
  exit 2
fi

MAX_ATTEMPTS=$((10#$MAX_ATTEMPTS))
POLL_INTERVAL_SECONDS=$((10#$POLL_INTERVAL_SECONDS))

latest_summary="attempt=0/$MAX_ATTEMPTS count=? id=- state=- sha=- image=-"

emit_latest_summary() {
  printf '%s\n' "$latest_summary" >&2
}

handle_term() {
  emit_latest_summary
  exit 143
}

trap handle_term TERM

sanitize_field() {
  local value="$1"
  local maximum_length="$2"

  if [[ -z "$value" ]]; then
    printf '%s' "-"
    return
  fi

  value="$(LC_ALL=C printf '%s' "$value" | tr -c 'A-Za-z0-9._:@/+,-' '?')"
  printf '%.*s' "$maximum_length" "$value"
}

set_latest_summary() {
  local attempt="$1"
  local count="$2"
  local id="$3"
  local state="$4"
  local sha="$5"
  local image="$6"

  count="$(sanitize_field "$count" "$MAX_ID_LENGTH")"
  id="$(sanitize_field "$id" "$MAX_ID_LENGTH")"
  state="$(sanitize_field "$state" "$MAX_STATE_LENGTH")"
  sha="$(sanitize_field "$sha" "$MAX_SHA_LENGTH")"
  image="$(sanitize_field "$image" "$MAX_IMAGE_LENGTH")"
  latest_summary="attempt=$attempt/$MAX_ATTEMPTS count=$count id=$id state=$state sha=$sha image=$image"
}

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
  machines=""
  count="?"
  machine_id=""
  machine_state=""
  deployed_sha=""
  machine_image=""

  if machines="$(flyctl machines list --app "$FLY_APP" --json 2>/dev/null)" &&
    count="$(jq -er 'if type == "array" then length else error("not an array") end' <<<"$machines" 2>/dev/null)"; then
    if [[ "$count" == "1" ]]; then
      machine_id="$(jq -r '.[0].id | if type == "string" then . else empty end' <<<"$machines" 2>/dev/null || true)"
      machine_state="$(jq -r '.[0].state | if type == "string" then . else empty end' <<<"$machines" 2>/dev/null || true)"
      deployed_sha="$(jq -r '.[0].image_ref.labels.GH_SHA | if type == "string" then . else empty end' <<<"$machines" 2>/dev/null || true)"
      machine_image="$(jq -r '.[0].config.image | if type == "string" then . else empty end' <<<"$machines" 2>/dev/null || true)"

      if [[ "$machine_state" == "started" && "$deployed_sha" == "$EXPECTED_GH_SHA" ]]; then
        jq -c '.[0]' <<<"$machines"
        exit 0
      fi
    fi
  fi

  set_latest_summary \
    "$attempt" \
    "$count" \
    "$machine_id" \
    "$machine_state" \
    "$deployed_sha" \
    "$machine_image"
  emit_latest_summary

  if ((attempt < MAX_ATTEMPTS)); then
    sleep "$POLL_INTERVAL_SECONDS"
  fi
done

exit 1
