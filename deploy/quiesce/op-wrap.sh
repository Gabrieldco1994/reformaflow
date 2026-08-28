#!/bin/sh
# op-wrap - operator control client, run ON the machine via
#   `flyctl ssh console --command "sh /app/op-wrap.sh <cmd> ..."`.
# Publishes control ATOMICALLY (serialized by a publish lock, tmp + rename) and
# returns in milliseconds. It NEVER signals a process: teardown is the
# watchdog's job (it only ever kills a process group it created itself).
#
#   op-wrap dryrun
#   op-wrap apply <manifest-sha256> <expected-groups> <expected-updates>
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
NORMALIZER="${QUIESCE_NORMALIZER:-/usr/local/bin/node /app/normalize-external-id-duplicates.mjs}"
PRISMA="${QUIESCE_PRISMA:-npx --no-install prisma}"
SCHEMA="${QUIESCE_SCHEMA:-prisma/schema.prisma}"

[ -f "$Q/deadline" ] || { echo "op-wrap: not armed ($Q/deadline missing)" >&2; exit 2; }

# --- atomic single-writer publish; refuses to clobber a queued/active command ---
publish_run(){
  { : > "$Q/.publish.lock"; } 2>/dev/null || { echo "op-wrap: $Q not writable" >&2; exit 1; }
  exec 8>"$Q/.publish.lock" || { echo "op-wrap: cannot open publish lock" >&2; exit 1; }
  flock -x 8 || { echo "op-wrap: publish lock busy" >&2; exit 3; }
  if [ -e "$Q/RUN" ] || [ -e "$Q/RUN.active" ]; then
    echo "op-wrap: a command is already queued or active - refusing to overwrite" >&2
    exit 3
  fi
  t="$(mktemp "$Q/.run.XXXXXX")" || { echo "op-wrap: mktemp failed in $Q" >&2; exit 1; }
  printf '%s\n' "$1" > "$t" || { rm -f "$t"; echo "op-wrap: write to $t failed" >&2; exit 1; }
  mv "$t" "$Q/RUN" || { rm -f "$t"; echo "op-wrap: publish rename failed" >&2; exit 1; }
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

cmd="${1:-status}"; [ $# -gt 0 ] && shift

case "$cmd" in
  dryrun)
    # fresh manifest path per attempt -> O_EXCL creation in the normalizer never
    # collides with a previous run. FAIL-CLOSED: the chain publishes
    # manifest.current (atomically) ONLY AFTER the normalizer exits 0. A
    # failed/killed normalizer leaves the previous manifest.current untouched and
    # no forward/partial pointer.
    M="$Q/manifest.$(date -u +%Y%m%dT%H%M%SZ).$$.json"
    publish_run "cd $APP && DATABASE_URL=file:$DB $NORMALIZER --dry-run --manifest '$M' && mt=\$(mktemp '$Q/.mcur.XXXXXX') && printf '%s\\n' '$M' > \"\$mt\" && mv \"\$mt\" '$Q/manifest.current'"
    echo "queued: dry-run  manifest=$M (manifest.current set only if the normalizer exits 0)" ;;

  apply)
    H="${1:?manifest sha256}"; EG="${2:?expected-groups}"; EU="${3:?expected-updates}"
    case "$H"  in *[!0-9a-f]*|"") echo "op-wrap: bad hash (need ^[0-9a-f]{64}\$)" >&2; exit 2 ;; esac
    [ "${#H}" -eq 64 ] || { echo "op-wrap: hash must be 64 hex chars" >&2; exit 2; }
    case "$EG" in *[!0-9]*|"")   echo "op-wrap: expected-groups must be a non-negative integer" >&2; exit 2 ;; esac
    case "$EU" in *[!0-9]*|"")   echo "op-wrap: expected-updates must be a non-negative integer" >&2; exit 2 ;; esac
    [ -f "$Q/manifest.current" ] || { echo "op-wrap: no manifest.current - run dryrun first" >&2; exit 2; }
    M="$(cat "$Q/manifest.current")"
    publish_run "cd $APP && set -e && \
DATABASE_URL=file:$DB $NORMALIZER --apply --manifest $M --hash $H --expected-groups $EG --expected-updates $EU && \
DATABASE_URL=file:$DB $PRISMA migrate resolve --rolled-back $MIG --schema=$SCHEMA && \
DATABASE_URL=file:$DB $PRISMA migrate deploy --schema=$SCHEMA"
    echo "queued: apply+resolve+deploy  manifest=$M" ;;

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
    tail -n 15 "$Q/op.log" 2>/dev/null || true ;;

  *)
    echo "usage: op-wrap {dryrun|apply <sha256> <eg> <eu>|disarm|status}" >&2
    exit 2 ;;
esac
