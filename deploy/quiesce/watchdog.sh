#!/bin/sh
# quiesce watchdog - the Fly machine command during a migration-recovery window
# (replaces `/bin/sleep infinity`). Primitives only: GNU coreutils `timeout`,
# util-linux `flock` + `setsid`, POSIX sh. No /proc scan, no PID tracking of
# unknown processes, no daemon, no token, no pkill/pgrep.
#
# Invariants
#   * one absolute Node-direct deadline, persisted on the volume, written ONCE
#     (a machine restart re-reads it, never renews it)
#   * the operator's apply/resolve/deploy chain runs under a SUPERVISOR that
#       - lives OUTSIDE the chain's process group (it is a child of this watchdog)
#       - holds the shared flock lock (fd 9) for the chain's WHOLE lifetime
#       - starts ONLY the known group via `setsid` and records that pgid
#       - after timeout terminates ONLY that known pgid: TERM group -> grace ->
#         KILL group  (this reaps reparented orphans that GNU `timeout` leaves
#         behind when the direct child exits early)
#       - confirms the group is gone (no fd-9 inheritor left) BEFORE it drops
#         the lock
#   * the watchdog starts Node ONLY after acquiring that same lock -> Node and a
#     live chain (or a reparented orphan of it) can never touch /data/dev.db at
#     once
#   * nothing is ever killed except a process group this watchdog itself created
set -u
umask 077

Q="${QUIESCE_DIR:-/data/quiesce}"
LOCK="$Q/lock"
DL="$Q/deadline"
APP="${QUIESCE_APP_DIR:-/app}"
NODE="${QUIESCE_NODE:-/usr/local/bin/node}"
MAIN="${QUIESCE_MAIN:-apps/api/dist/main.js}"
TTL="${QUIESCE_TTL:-1500}"                 # 25m Node-direct backstop
OP_TIMEOUT="${QUIESCE_OP_TIMEOUT:-900}"    # 15m hard cap on the chain (SIGTERM)
KILL_AFTER="${QUIESCE_KILL_AFTER:-60}"     # +Ns then SIGKILL the whole group
MARGIN="${QUIESCE_MARGIN:-300}"            # >=5m gap between op hard-kill and deadline
POLL="${QUIESCE_POLL:-5}"
LOCK_WAIT="${QUIESCE_LOCK_WAIT:-1800}"

mkdir -p "$Q"
log(){ echo "$(date -u +%FT%TZ) [wd $$] $*" >> "$Q/watchdog.log"; }

# util-linux kill (can signal a process group via `-- -<pgid>`); the POSIX sh
# builtin cannot. Never used on anything but a group this script created.
KILL="/bin/kill"; [ -x "$KILL" ] || KILL="$(command -v kill)"
gsig(){ "$KILL" "$1" -- -"$2" 2>/dev/null || true; }   # gsig <-SIG|-0> <pgid>
galive(){ "$KILL" -0 -- -"$1" 2>/dev/null; }           # galive <pgid>

# --- absolute deadline: written exactly once, atomically (hardlink), on the volume ---
FRESH=1; [ -f "$DL" ] && FRESH=0
if [ "$FRESH" = 1 ]; then
  t="$(mktemp "$Q/.dl.XXXXXX")"; echo $(( $(date +%s) + TTL )) > "$t"
  ln "$t" "$DL" 2>/dev/null || true            # O_EXCL link; silently loses a race
  rm -f "$t"
  [ -f "$DL" ] || { log "FATAL: could not create deadline"; exit 1; }
fi
D="$(cat "$DL")"
log "watchdog up fresh=$FRESH deadline=$D ($(( D - $(date +%s) ))s left) op_timeout=$OP_TIMEOUT kill_after=$KILL_AFTER margin=$MARGIN"

# ---------------------------------------------------------------------------
# restore(): Node-direct fallback. Starts Node ONLY after acquiring the same
# lock the chain supervisor holds, so it can never race a live chain / orphan.
# ---------------------------------------------------------------------------
restore(){
  log "restore requested - acquiring op lock (blocks until any chain + all its descendants exit)"
  exec 9>"$LOCK"
  if flock -x -w "$LOCK_WAIT" 9; then
    log "restore: lock acquired, exec Node-direct"
    cd "$APP" || { log "FATAL: cd $APP failed"; exec sleep 2147483647; }
    exec "$NODE" $MAIN
  fi
  log "CRITICAL: op lock not free after ${LOCK_WAIT}s - a DB holder is stuck (uninterruptible?). NOT starting Node. Paging via logs."
  exec sleep 2147483647
}

# ---------------------------------------------------------------------------
# supervise(): runs as a background child of the watchdog (i.e. OUTSIDE the
# chain's process group). Holds fd-9 lock the whole time; owns teardown of the
# one known process group it creates.
# ---------------------------------------------------------------------------
supervise(){
  chain="$1"
  exec 9>"$LOCK"
  if ! flock -x -w "$LOCK_WAIT" 9; then
    log "supervisor: could not acquire lock in ${LOCK_WAIT}s - not launching chain"
    return 4
  fi
  log "supervisor: lock held; launching known group via setsid+timeout(-k $KILL_AFTER -s TERM $OP_TIMEOUT)"
  raw="$Q/op.pgid.raw"; rm -f "$raw"
  # setsid makes the exec'd sh a session (=> process-group) leader, so its $$ IS
  # the pgid. Capture it from inside, independent of whether setsid forked.
  rm -f "$Q/op.rc"
  setsid sh -c 'echo $$ > "$0"; timeout -k "$1" -s TERM "$2" sh -c "$3"; r=$?; echo "$r" > "$4"; exit "$r"' \
    "$raw" "$KILL_AFTER" "$OP_TIMEOUT" "$chain" "$Q/op.rc" >> "$Q/op.log" 2>&1 &
  bgpid=$!
  i=0; while [ ! -s "$raw" ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done
  pgid="$(cat "$raw" 2>/dev/null || echo)"
  [ -n "$pgid" ] || pgid=$bgpid
  echo "$pgid" > "$Q/op.pgid"
  log "supervisor: chain pgid=$pgid"

  # `timeout` bounds the operation itself; wait it out. (setsid does not fork
  # here - the backgrounded subshell is not a group leader - so bgpid IS the
  # session leader and this wait is real.)
  wait "$bgpid" 2>/dev/null; rc=$?
  log "supervisor: operation finished rc=$rc; enforcing teardown of known pgid $pgid (reaps any orphan)"

  # authoritative teardown of the KNOWN group (reaps reparented orphans that
  # `timeout` leaves behind). TERM group -> grace -> KILL group.
  gsig -TERM "$pgid"
  grace=$(( $(date +%s) + KILL_AFTER ))
  while galive "$pgid"; do
    [ "$(date +%s)" -ge "$grace" ] && break
    sleep 1
  done
  gsig -KILL "$pgid"

  # confirm the group is gone: nobody can still be holding an inherited fd 9
  i=0
  while galive "$pgid" && [ "$i" -lt 60 ]; do sleep 1; i=$((i+1)); done
  if galive "$pgid"; then
    log "CRITICAL supervisor: pgid $pgid still alive after KILL - NOT releasing the lock (paging via logs)"
    exec sleep 2147483647
  fi

  rm -f "$Q/op.pgid" "$raw"
  log "supervisor: pgid $pgid reaped (chain rc=$rc); releasing lock"
  # returning closes fd 9 (this function runs in a subshell because it is
  # backgrounded), freeing the lock for restore() or the next chain.
  return 0
}

SUP_PID=""

# --- a machine restart with no chain running COLLAPSES the window (never renews the deadline) ---
if [ "$FRESH" = 0 ]; then
  if ( exec 9>"$LOCK"; flock -n -x 9 ); then
    log "restart detected, no chain holds the lock -> restoring Node-direct now (window collapses)"
    restore
  fi
  log "restart detected, a chain still holds the lock -> resuming watch"
fi

while :; do
  now="$(date +%s)"

  if [ -f "$Q/DISARM" ]; then log "DISARM flag present"; restore; fi
  if [ "$now" -ge "$D" ]; then log "absolute deadline reached"; restore; fi

  # a supervisor already running? just wait it out.
  if [ -n "$SUP_PID" ] && kill -0 "$SUP_PID" 2>/dev/null; then
    sleep "$POLL"; continue
  fi
  SUP_PID=""

  # --- atomically claim a published chain and launch its supervisor ---
  if [ -s "$Q/RUN" ] && [ ! -e "$Q/RUN.active" ]; then
    if mv "$Q/RUN" "$Q/RUN.active" 2>/dev/null; then
      chain="$(cat "$Q/RUN.active")"
      if [ $(( now + OP_TIMEOUT + KILL_AFTER + MARGIN )) -ge "$D" ]; then
        log "REFUSED chain: now+op_timeout+kill_after+margin >= deadline"
        rm -f "$Q/RUN.active"
      elif ! ( exec 9>"$LOCK"; flock -n -x 9 ) 2>/dev/null; then
        log "chain deferred: op lock busy"
        mv "$Q/RUN.active" "$Q/RUN" 2>/dev/null || true
      else
        log "claimed chain -> starting supervisor"
        supervise "$chain" &
        SUP_PID=$!
        rm -f "$Q/RUN.active"
      fi
    fi
  fi

  sleep "$POLL"
done
