#!/bin/sh
# op-wrap - operator control client, run ON the machine via
#   `flyctl ssh console --command "sh /app/op-wrap.sh <cmd> ..."`.
# Publishes control ATOMICALLY (serialized by a publish lock, tmp + rename) and
# returns in milliseconds. It NEVER signals a process: teardown is the
# watchdog's job (it only ever kills a process group it created itself).
#
#   op-wrap dryrun
#   op-wrap apply <manifest-sha256> <expected-groups> <expected-updates>
#   op-wrap disarm | abort | status
set -u
umask 077

Q="${QUIESCE_DIR:-/data/quiesce}"
DB="${QUIESCE_DB:-/data/dev.db}"
MIG="${QUIESCE_MIGRATION:-20260826150000_external_id_unique_scope_tenant_project}"
NORMALIZER="${QUIESCE_NORMALIZER:-/usr/local/bin/node /app/normalize-external-id-duplicates.mjs}"
PRISMA="${QUIESCE_PRISMA:-npx --no-install prisma}"
SCHEMA="${QUIESCE_SCHEMA:-prisma/schema.prisma}"

[ -f "$Q/deadline" ] || { echo "op-wrap: not armed ($Q/deadline missing)" >&2; exit 2; }

# --- atomic single-writer publish; refuses to clobber a queued/active command ---
publish_run(){
  exec 8>"$Q/.publish.lock"
  flock -x 8 || { echo "op-wrap: publish lock busy" >&2; exit 3; }
  if [ -e "$Q/RUN" ] || [ -e "$Q/RUN.active" ]; then
    echo "op-wrap: a command is already queued or active - refusing to overwrite" >&2
    exit 3
  fi
  t="$(mktemp "$Q/.run.XXXXXX")" || { echo "op-wrap: mktemp failed" >&2; exit 1; }
  printf '%s\n' "$1" > "$t" || { rm -f "$t"; exit 1; }
  mv "$t" "$Q/RUN" || { rm -f "$t"; echo "op-wrap: publish rename failed" >&2; exit 1; }
}

set_disarm(){ t="$(mktemp "$Q/.disarm.XXXXXX")"; : > "$t"; mv "$t" "$Q/DISARM"; }

cmd="${1:-status}"; [ $# -gt 0 ] && shift

case "$cmd" in
  dryrun)
    # fresh manifest path per attempt -> O_EXCL creation in the normalizer never
    # collides with a previous run.
    M="$Q/manifest.$(date -u +%Y%m%dT%H%M%SZ).$$.json"
    publish_run "cd /app && DATABASE_URL=file:$DB $NORMALIZER --dry-run --manifest $M"
    mp="$(mktemp "$Q/.mcur.XXXXXX")"; printf '%s\n' "$M" > "$mp"; mv "$mp" "$Q/manifest.current"
    echo "queued: dry-run  manifest=$M" ;;

  apply)
    H="${1:?manifest sha256}"; EG="${2:?expected-groups}"; EU="${3:?expected-updates}"
    case "$H"  in *[!0-9a-f]*|"") echo "op-wrap: bad hash (need ^[0-9a-f]{64}\$)" >&2; exit 2 ;; esac
    [ "${#H}" -eq 64 ] || { echo "op-wrap: hash must be 64 hex chars" >&2; exit 2; }
    case "$EG" in *[!0-9]*|"")   echo "op-wrap: expected-groups must be a non-negative integer" >&2; exit 2 ;; esac
    case "$EU" in *[!0-9]*|"")   echo "op-wrap: expected-updates must be a non-negative integer" >&2; exit 2 ;; esac
    [ -f "$Q/manifest.current" ] || { echo "op-wrap: no manifest.current - run dryrun first" >&2; exit 2; }
    M="$(cat "$Q/manifest.current")"
    publish_run "cd /app && set -e && \
DATABASE_URL=file:$DB $NORMALIZER --apply --manifest $M --hash $H --expected-groups $EG --expected-updates $EU && \
DATABASE_URL=file:$DB $PRISMA migrate resolve --rolled-back $MIG --schema=$SCHEMA && \
DATABASE_URL=file:$DB $PRISMA migrate deploy --schema=$SCHEMA"
    echo "queued: apply+resolve+deploy  manifest=$M" ;;

  disarm)
    set_disarm
    echo "DISARM set (watchdog goes Node-direct once the op lock is free)" ;;

  abort)
    # NEVER signals a PID/PGID (it may have been reused). Only sets the DISARM
    # flag; the watchdog's own known-group termination handles teardown.
    set_disarm
    echo "abort -> DISARM set. Teardown is the watchdog's known-group termination; op-wrap sends no signal." ;;

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
    echo "usage: op-wrap {dryrun|apply <sha256> <eg> <eu>|disarm|abort|status}" >&2
    exit 2 ;;
esac
