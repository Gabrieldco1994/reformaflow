#!/bin/sh
# op-wrap - operator control client, run ON the machine via
#   `flyctl ssh console --command "sh /app/op-wrap.sh <cmd> ..."`.
# Publishes control ATOMICALLY (serialized by a publish lock, tmp + rename) and
# returns in milliseconds. It NEVER signals a process: teardown is the
# watchdog's job (it only ever kills a process group it created itself).
#
#   op-wrap dryrun
#   op-wrap apply <manifest-sha256> <expected-groups> <expected-updates>
#   op-wrap fk-dryrun <scope-proof-sha256>
#   op-wrap fk-apply <manifest-sha256> <scope-proof-sha256>
#   op-wrap disarm | status
#
# There is deliberately NO "cancel a running chain" verb: `timeout` (inside the
# supervisor) is the only automatic cancellation. `disarm` only requests the
# Node-direct restore once the op lock is free.
set -u
umask 077

Q="${QUIESCE_DIR:-/data/quiesce}"
APP="${QUIESCE_APP_DIR:-/app}"
DB="${QUIESCE_DB:-/data/dev.db}"
MIG="${QUIESCE_MIGRATION:-20260826150000_external_id_unique_scope_tenant_project}"
NODE="${QUIESCE_NODE:-/usr/local/bin/node}"
NORMALIZER="${QUIESCE_NORMALIZER:-/app/normalize-external-id-duplicates.mjs}"
FK_REPAIR="${QUIESCE_FK_REPAIR:-/app/repair-legacy-fk-integrity.mjs}"
FK_EXPECTED_PROJECTS=2
FK_EXPECTED_ROOMS=28
FK_EXPECTED_CASH_FLOW=4
NPX="${QUIESCE_NPX:-npx}"
SCHEMA="${QUIESCE_SCHEMA:-prisma/schema.prisma}"

[ -d "$Q" ] && [ ! -L "$Q" ] || { echo "op-wrap: unsafe quiesce directory" >&2; exit 2; }
case "$Q" in /*) ;; *) echo "op-wrap: QUIESCE_DIR must be absolute" >&2; exit 2 ;; esac
Q="$(cd "$Q" && pwd -P)" || exit 2
[ -f "$Q/deadline" ] || { echo "op-wrap: not armed ($Q/deadline missing)" >&2; exit 2; }

# --- atomic single-writer publish; refuses to clobber a queued/active command ---
publish_request(){
  { : > "$Q/.publish.lock"; } 2>/dev/null || { echo "op-wrap: $Q not writable" >&2; exit 1; }
  exec 8>"$Q/.publish.lock" || { echo "op-wrap: cannot open publish lock" >&2; exit 1; }
  flock -x 8 || { echo "op-wrap: publish lock busy" >&2; exit 3; }
  if [ -e "$Q/RUN" ] || [ -e "$Q/RUN.active" ] ||
     [ -e "$Q/REQUEST" ] || [ -e "$Q/REQUEST.active" ]; then
    echo "op-wrap: a command is already queued or active - refusing to overwrite" >&2
    exit 3
  fi
  r="$(mktemp "$Q/.request.XXXXXX")" ||
    { echo "op-wrap: request mktemp failed in $Q" >&2; exit 1; }
  for field in "$@"; do
    case "$field" in *'
'*) rm -f "$r"; echo "op-wrap: invalid request field" >&2; exit 2 ;; esac
    printf '%s\n' "$field" >> "$r" ||
      { rm -f "$r"; echo "op-wrap: request write failed" >&2; exit 1; }
  done
  mv "$r" "$Q/REQUEST" ||
    { rm -f "$r"; echo "op-wrap: request publish failed" >&2; exit 1; }
  t="$(mktemp "$Q/.run.XXXXXX")" ||
    { rm -f "$Q/REQUEST"; echo "op-wrap: mktemp failed in $Q" >&2; exit 1; }
  printf '%s\n' 'exec sh "$QUIESCE_DIR/op-wrap.sh" __execute "$QUIESCE_DIR/REQUEST.active"' > "$t" ||
    { rm -f "$t" "$Q/REQUEST"; echo "op-wrap: write to $t failed" >&2; exit 1; }
  mv "$t" "$Q/RUN" ||
    { rm -f "$t" "$Q/REQUEST"; echo "op-wrap: publish rename failed" >&2; exit 1; }
}

# atomic flag/pointer write; every step checked, non-zero propagated, no success
# line printed by the caller unless this returns 0.
atomic_put(){                            # atomic_put <dest> <content>
  _d="$1"; _c="$2"
  _t="$(mktemp "$Q/.put.XXXXXX")" || { echo "op-wrap: mktemp failed in $Q" >&2; return 1; }
  printf '%s\n' "$_c" > "$_t" || { rm -f "$_t"; echo "op-wrap: write to $_t failed" >&2; return 1; }
  mv "$_t" "$_d" || { rm -f "$_t"; echo "op-wrap: rename -> $_d failed" >&2; return 1; }
}
set_disarm(){ atomic_put "$Q/DISARM" ""; }
valid_hash(){
  case "$1" in *[!0-9a-f]*|"") return 1 ;; esac
  [ "${#1}" -eq 64 ]
}
valid_manifest_basename(){
  case "$2" in
    normal) _prefix="manifest" ;;
    fk) _prefix="fk-manifest" ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$1" |
    grep -Eq "^${_prefix}\\.[0-9]{8}T[0-9]{6}Z\\.[1-9][0-9]*\\.json$"
}
read_manifest_pointer(){
  _pointer="$1"; _kind="$2"
  [ -f "$_pointer" ] && [ ! -L "$_pointer" ] || return 1
  [ "$(wc -l < "$_pointer" | tr -d ' ')" = 1 ] || return 1
  IFS= read -r POINTER_BASENAME < "$_pointer" || return 1
  valid_manifest_basename "$POINTER_BASENAME" "$_kind" || return 1
  POINTER_PATH="$Q/$POINTER_BASENAME"
  [ -f "$POINTER_PATH" ] && [ ! -L "$POINTER_PATH" ] || return 1
  [ "$(cd "$(dirname "$POINTER_PATH")" && pwd -P)/$(basename "$POINTER_PATH")" = "$POINTER_PATH" ]
}
request_field(){
  sed -n "${1}p" "$2"
}
assert_executor_lock(){
  [ "${LEGACY_FK_RECOVERY_LOCK_FD:-}" = 9 ] ||
    { echo "op-wrap: missing watchdog lock fd" >&2; exit 2; }
  [ -e /proc/self/fd/9 ] ||
    { echo "op-wrap: watchdog lock fd is not inherited" >&2; exit 2; }
  _lock_inode="$(stat -Lc '%d:%i' "$Q/lock")" || exit 2
  _fd_inode="$(stat -Lc '%d:%i' /proc/self/fd/9)" || exit 2
  [ "$_lock_inode" = "$_fd_inode" ] ||
    { echo "op-wrap: inherited fd is not the watchdog lock" >&2; exit 2; }
  if flock -n "$Q/lock" true 2>/dev/null; then
    echo "op-wrap: watchdog lock is not held" >&2
    exit 2
  fi
  flock -n 9 true ||
    { echo "op-wrap: inherited watchdog lock is not owned" >&2; exit 2; }
}
run_normalizer(){
  _mode="$1"; shift
  if [ "$_mode" = exec ]; then
    "$NORMALIZER" "$@"
  else
    "$NODE" "$NORMALIZER" "$@"
  fi
}
normalizer_request(){
  if [ -n "${QUIESCE_NORMALIZER:-}" ]; then
    NORMALIZER_MODE=exec
  else
    NORMALIZER_MODE=node
  fi
  case "$NORMALIZER" in /*) ;; *) echo "op-wrap: normalizer path must be absolute" >&2; exit 2 ;; esac
  case "$NORMALIZER" in *'
'*) echo "op-wrap: invalid normalizer path" >&2; exit 2 ;; esac
}
run_fk_repair(){
  _cap="$(mktemp "$Q/.fk-cap.XXXXXX")" || return 1
  chmod 0600 "$_cap" || { rm -f "$_cap"; return 1; }
  exec 7<"$_cap" || { rm -f "$_cap"; return 1; }
  rm -f "$_cap" || return 1
  LEGACY_FK_RECOVERY_OP_WRAP=legacy-fk-integrity-v1 \
  LEGACY_FK_RECOVERY_LOCK_FD=9 \
  LEGACY_FK_RECOVERY_CAP_FD=7 \
  QUIESCE_DIR="$Q" \
  DATABASE_URL="file:$DB" \
    "$NODE" "$FK_REPAIR" "$@"
  _rc=$?
  exec 7<&-
  return "$_rc"
}

cmd="${1:-status}"; [ $# -gt 0 ] && shift

case "$cmd" in
  __execute)
    assert_executor_lock
    R="${1:-}"
    [ "$R" = "$Q/REQUEST.active" ] && [ -f "$R" ] && [ ! -L "$R" ] ||
      { echo "op-wrap: invalid active request" >&2; exit 2; }
    action="$(request_field 1 "$R")"
    cd "$APP" || exit 1
    case "$action" in
      dryrun)
        [ "$(wc -l < "$R" | tr -d ' ')" = 4 ] || exit 2
        B="$(request_field 2 "$R")"
        _mode="$(request_field 3 "$R")"; NORMALIZER="$(request_field 4 "$R")"
        valid_manifest_basename "$B" normal || exit 2
        case "$_mode:$NORMALIZER" in node:/*|exec:/*) ;; *) exit 2 ;; esac
        M="$Q/$B"
        DATABASE_URL="file:$DB" run_normalizer "$_mode" --dry-run --manifest "$M" || exit $?
        atomic_put "$Q/manifest.current" "$B"
        ;;
      apply)
        [ "$(wc -l < "$R" | tr -d ' ')" = 7 ] || exit 2
        B="$(request_field 2 "$R")"; H="$(request_field 3 "$R")"
        EG="$(request_field 4 "$R")"; EU="$(request_field 5 "$R")"
        _mode="$(request_field 6 "$R")"; NORMALIZER="$(request_field 7 "$R")"
        valid_manifest_basename "$B" normal && valid_hash "$H" || exit 2
        case "$EG:$EU" in *[!0-9:]*|:*|*:) exit 2 ;; esac
        case "$_mode:$NORMALIZER" in node:/*|exec:/*) ;; *) exit 2 ;; esac
        M="$Q/$B"; [ -f "$M" ] && [ ! -L "$M" ] || exit 2
        DATABASE_URL="file:$DB" run_normalizer "$_mode" --apply --manifest "$M" \
          --hash "$H" --expected-groups "$EG" --expected-updates "$EU" &&
        DATABASE_URL="file:$DB" "$NPX" --no-install prisma migrate resolve \
          --rolled-back "$MIG" --schema="$SCHEMA" &&
        DATABASE_URL="file:$DB" "$NPX" --no-install prisma migrate deploy \
          --schema="$SCHEMA"
        ;;
      fk-dryrun)
        [ "$(wc -l < "$R" | tr -d ' ')" = 3 ] || exit 2
        B="$(request_field 2 "$R")"; SH="$(request_field 3 "$R")"
        valid_manifest_basename "$B" fk && valid_hash "$SH" || exit 2
        M="$Q/$B"; S="$Q/fk-scope-proof.json"
        [ -f "$S" ] && [ ! -L "$S" ] || exit 2
        run_fk_repair --dry-run --scope-proof "$S" --scope-proof-hash "$SH" \
          --manifest "$M" || exit $?
        atomic_put "$Q/fk-manifest.current" "$B"
        ;;
      fk-apply)
        [ "$(wc -l < "$R" | tr -d ' ')" = 4 ] || exit 2
        B="$(request_field 2 "$R")"; H="$(request_field 3 "$R")"
        SH="$(request_field 4 "$R")"
        valid_manifest_basename "$B" fk && valid_hash "$H" && valid_hash "$SH" || exit 2
        M="$Q/$B"; S="$Q/fk-scope-proof.json"
        [ -f "$M" ] && [ ! -L "$M" ] && [ -f "$S" ] && [ ! -L "$S" ] || exit 2
        run_fk_repair --apply --scope-proof "$S" --scope-proof-hash "$SH" \
          --manifest "$M" --hash "$H" --expected-projects "$FK_EXPECTED_PROJECTS" \
          --expected-rooms "$FK_EXPECTED_ROOMS" \
          --expected-cash-flow-entries "$FK_EXPECTED_CASH_FLOW"
        ;;
      *) echo "op-wrap: invalid request action" >&2; exit 2 ;;
    esac
    ;;

  dryrun)
    # fresh manifest path per attempt -> O_EXCL creation in the normalizer never
    # collides with a previous run. FAIL-CLOSED: the chain publishes
    # manifest.current (atomically) ONLY AFTER the normalizer exits 0. A
    # failed/killed normalizer leaves the previous manifest.current untouched and
    # no forward/partial pointer.
    B="manifest.$(date -u +%Y%m%dT%H%M%SZ).$$.json"
    valid_manifest_basename "$B" normal || exit 2
    normalizer_request
    publish_request dryrun "$B" "$NORMALIZER_MODE" "$NORMALIZER"
    echo "queued: dry-run  manifest=$Q/$B (manifest.current set only if the normalizer exits 0)" ;;

  apply)
    H="${1:?manifest sha256}"; EG="${2:?expected-groups}"; EU="${3:?expected-updates}"
    case "$H"  in *[!0-9a-f]*|"") echo "op-wrap: bad hash (need ^[0-9a-f]{64}\$)" >&2; exit 2 ;; esac
    [ "${#H}" -eq 64 ] || { echo "op-wrap: hash must be 64 hex chars" >&2; exit 2; }
    case "$EG" in *[!0-9]*|"")   echo "op-wrap: expected-groups must be a non-negative integer" >&2; exit 2 ;; esac
    case "$EU" in *[!0-9]*|"")   echo "op-wrap: expected-updates must be a non-negative integer" >&2; exit 2 ;; esac
    read_manifest_pointer "$Q/manifest.current" normal ||
      { echo "op-wrap: invalid manifest.current - run dryrun first" >&2; exit 2; }
    normalizer_request
    publish_request apply "$POINTER_BASENAME" "$H" "$EG" "$EU" \
      "$NORMALIZER_MODE" "$NORMALIZER"
    echo "queued: apply+resolve+deploy  manifest=$Q/$POINTER_BASENAME" ;;

  fk-dryrun)
    SH="${1:?scope proof sha256}"
    valid_hash "$SH" || { echo "op-wrap: bad scope-proof hash" >&2; exit 2; }
    S="$Q/fk-scope-proof.json"
    [ -f "$S" ] && [ ! -L "$S" ] || { echo "op-wrap: private scope proof is missing or unsafe" >&2; exit 2; }
    B="fk-manifest.$(date -u +%Y%m%dT%H%M%SZ).$$.json"
    valid_manifest_basename "$B" fk || exit 2
    publish_request fk-dryrun "$B" "$SH"
    echo "queued: fk-dryrun counts=projects:$FK_EXPECTED_PROJECTS,rooms:$FK_EXPECTED_ROOMS,cash-flow:$FK_EXPECTED_CASH_FLOW" ;;

  fk-apply)
    H="${1:?manifest sha256}"; SH="${2:?scope proof sha256}"
    valid_hash "$H" || { echo "op-wrap: bad manifest hash" >&2; exit 2; }
    valid_hash "$SH" || { echo "op-wrap: bad scope-proof hash" >&2; exit 2; }
    S="$Q/fk-scope-proof.json"
    [ -f "$S" ] && [ ! -L "$S" ] || { echo "op-wrap: private scope proof is missing or unsafe" >&2; exit 2; }
    read_manifest_pointer "$Q/fk-manifest.current" fk ||
      { echo "op-wrap: invalid fk-manifest.current - run fk-dryrun first" >&2; exit 2; }
    publish_request fk-apply "$POINTER_BASENAME" "$H" "$SH"
    echo "queued: fk-apply counts=projects:$FK_EXPECTED_PROJECTS,rooms:$FK_EXPECTED_ROOMS,cash-flow:$FK_EXPECTED_CASH_FLOW manifest-hash=$(printf '%s' "$H" | cut -c1-12)" ;;

  disarm)
    set_disarm || { echo "op-wrap: DISARM not set" >&2; exit 1; }
    echo "DISARM set (watchdog goes Node-direct once the op lock is free)" ;;

  status)
    now="$(date +%s)"; D="$(cat "$Q/deadline")"
    echo "deadline : $D ($(( D - now ))s left)"
    [ -f "$Q/op.pgid" ]        && echo "op       : pgid $(cat "$Q/op.pgid") RUNNING"
    [ -f "$Q/op.rc" ]          && echo "last rc  : $(cat "$Q/op.rc")"
    [ -f "$Q/DISARM" ]         && echo "DISARM   : set"
    [ -e "$Q/RUN" ]            && echo "RUN      : queued (not yet claimed)"
    [ -e "$Q/RUN.active" ]     && echo "RUN      : claimed, launching"
    [ -f "$Q/manifest.current" ] && echo "manifest : $(cat "$Q/manifest.current")"
    [ -f "$Q/fk-manifest.current" ] && echo "fk manifest: ready"
    tail -n 15 "$Q/op.log" 2>/dev/null || true ;;

  *)
    echo "usage: op-wrap {dryrun|apply <sha256> <eg> <eu>|fk-dryrun <scope-sha256>|fk-apply <manifest-sha256> <scope-sha256>|disarm|status}" >&2
    exit 2 ;;
esac
