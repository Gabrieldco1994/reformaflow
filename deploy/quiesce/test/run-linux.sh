#!/bin/sh
# Adversarial Linux proof for the native quiesce watchdog.
# Requires: GNU timeout, util-linux flock + setsid, /proc.
#   - On a non-Linux dev box (macOS): SKIP cleanly (exit 0).
#   - In CI (env CI or QUIESCE_CI set): missing primitives FAIL HARD (exit 1),
#     never a green SKIP.
# Signals ONLY process groups this script itself created (recorded in $PGS).
# No pkill, no pgrep, no scanning of unknown PIDs.
set -u
umask 077

HERE=$(cd "$(dirname "$0")" && pwd)
WD="${WD:-$HERE/../watchdog.sh}"
OW="${OW:-$HERE/../op-wrap.sh}"
CI_MODE="${CI:-}${QUIESCE_CI:-}"

require(){
  miss=""
  for need in timeout flock setsid; do
    command -v "$need" >/dev/null 2>&1 || miss="$miss $need"
  done
  [ -d /proc ] || miss="$miss /proc"
  if [ -n "$miss" ]; then
    if [ -n "$CI_MODE" ]; then
      echo "FAIL: required primitive(s) absent in CI:$miss"
      exit 1
    fi
    echo "SKIP: primitive(s) absent (not Linux):$miss"
    exit 0
  fi
}
require

P=0; F=0
ok(){ echo "  PASS: $1"; P=$((P+1)); }
no(){ echo "  FAIL: $1"; F=$((F+1)); }

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/qwd.XXXXXX")
PGS=""; WPIDS=""
cleanup(){
  for g in $PGS; do [ -n "$g" ] && kill -KILL -- -"$g" 2>/dev/null || true; done
  for p in $WPIDS; do kill -KILL "$p" 2>/dev/null || true; done
  [ -n "${KEEP_ARTIFACTS:-}" ] && echo "kept: $ROOT" || rm -rf "$ROOT"
}
trap cleanup EXIT INT TERM

N=0
newenv(){
  N=$((N+1))
  Q="$ROOT/q.$N"; mkdir -p "$Q"
  DB="$Q/dev.db"; : > "$DB"
  # correction 7: the fake node MUST open the DB file so "two writers" is real.
  NODE_STUB="$Q/nodestub"
  {
    printf '#!/bin/sh\n'
    printf 'exec 8>>"%s"\n' "$DB"
    printf 'echo "STUB-NODE $$" >> "%s/node.log"\n' "$Q"
    printf 'exec sleep 30\n'
  } > "$NODE_STUB"
  chmod +x "$NODE_STUB"
  export QUIESCE_DIR="$Q" QUIESCE_DB="$DB" QUIESCE_APP_DIR="$Q" \
         QUIESCE_NODE="$NODE_STUB" QUIESCE_MAIN="stub" \
         QUIESCE_POLL=1 QUIESCE_LOCK_WAIT=12
}
wd_start(){ sh "$WD" >>"$Q/wd.stdout" 2>&1 & W=$!; WPIDS="$WPIDS $W"; }
node_up(){ [ -s "$Q/node.log" ]; }
lock_free(){ ( exec 9>"$Q/lock"; flock -n -x 9 ) 2>/dev/null; }
holders(){ lsof -t -w -- "$DB" "$DB-wal" 2>/dev/null | sort -un; }
op_pgid(){ cat "$Q/op.pgid" 2>/dev/null || echo; }

echo "=== native watchdog - Linux adversarial suite  $(date -u +%FT%TZ) ==="
echo "    timeout: $(timeout --version 2>/dev/null | head -1)"

# ---------------------------------------------------------------------------
echo "--- T1: SIGTERM-ignoring chain + grandchild -> known-group TERM/KILL frees the lock ---"
newenv; export QUIESCE_TTL=60 QUIESCE_OP_TIMEOUT=3 QUIESCE_KILL_AFTER=3 QUIESCE_MARGIN=5
wd_start; sleep 2
cat > "$Q/chain.sh" <<CH
trap '' TERM
exec 8>>"$DB"
( exec 7>>"$DB"; trap '' TERM; exec sleep 300 ) &
exec sleep 300
CH
printf 'sh %s\n' "$Q/chain.sh" > "$Q/RUN.tmp"; mv "$Q/RUN.tmp" "$Q/RUN"
i=0; while lock_free && [ $i -lt 12 ]; do sleep 1; i=$((i+1)); done
lock_free && no "op never acquired the lock" || ok "supervisor holds the shared lock while the chain runs"
pg=$(op_pgid); PGS="$PGS $pg"
[ -n "$pg" ] && ok "known pgid recorded ($pg)" || no "no op.pgid recorded"
nh=$(holders | wc -l); [ "$nh" -ge 2 ] && ok "chain+grandchild both hold the DB ($nh)" || no "only $nh DB holders"
i=0; while ! lock_free && [ $i -lt 25 ]; do sleep 1; i=$((i+1)); done
lock_free && ok "after TERM/KILL of the known group the lock is FREE (~${i}s)" || no "lock still held - group kill failed"
[ -z "$(holders)" ] && ok "no DB holders remain" || no "holders left: $(holders | tr '\n' ' ')"
i=0; while ! node_up && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
node_up && ok "watchdog then restored Node-direct" || no "no Node restore after chain death"
kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T2: reparented orphan (direct child exits, descendant survives in the pgid) ---"
newenv; export QUIESCE_TTL=60 QUIESCE_OP_TIMEOUT=30 QUIESCE_KILL_AFTER=3 QUIESCE_MARGIN=5
wd_start; sleep 2
cat > "$Q/chain.sh" <<CH
exec 8>>"$DB"
( exec 7>>"$DB"; exec sleep 300 ) &
echo \$! > "$Q/orphan.pid"
sleep 3
exit 0
CH
printf 'sh %s\n' "$Q/chain.sh" > "$Q/RUN.tmp"; mv "$Q/RUN.tmp" "$Q/RUN"
i=0; while lock_free && [ $i -lt 12 ]; do sleep 1; i=$((i+1)); done
pg=$(op_pgid); PGS="$PGS $pg"
orph=$(cat "$Q/orphan.pid" 2>/dev/null || echo)
lock_free && no "lock free while the chain + its descendant are alive" || ok "lock held while chain runs"
[ -n "$(holders)" ] && ok "descendant holds the DB during the window" || no "nobody holds the DB"
# direct child exits at ~3s; supervisor must then reap the KNOWN pgid incl. the
# reparented orphan and only then release the lock.
sleep 4
if [ -n "$orph" ] && [ -d "/proc/$orph" ]; then
  pp=$(awk '{print $4}' "/proc/$orph/stat" 2>/dev/null || echo "?")
  echo "  (orphan $orph still visible mid-teardown, ppid=$pp)"
fi
i=0; while ! lock_free && [ $i -lt 25 ]; do sleep 1; i=$((i+1)); done
lock_free && ok "supervisor reaped the known pgid incl. the reparented orphan -> lock free" || no "orphan survived the group kill"
{ [ -n "$orph" ] && [ -d "/proc/$orph" ]; } && no "orphan $orph still alive" || ok "reparented orphan is dead"
[ -z "$(holders)" ] && ok "no DB holders remain" || no "holders left: $(holders | tr '\n' ' ')"
kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T3: fallback vs. an active operation - both open the DB, never concurrently ---"
newenv; export QUIESCE_TTL=14 QUIESCE_OP_TIMEOUT=6 QUIESCE_KILL_AFTER=2 QUIESCE_MARGIN=3
wd_start; sleep 1
cat > "$Q/chain.sh" <<CH
exec 8>>"$DB"
echo "CHAIN_START \$(date +%s)" >> "$Q/timeline"
exec sleep 4
CH
printf 'sh %s\n' "$Q/chain.sh" > "$Q/RUN.tmp"; mv "$Q/RUN.tmp" "$Q/RUN"
pg=""; i=0; while [ -z "$pg" ] && [ $i -lt 10 ]; do pg=$(op_pgid); sleep 1; i=$((i+1)); done
PGS="$PGS $pg"
race=0; i=0
while [ $i -lt 30 ]; do
  n=$(holders | wc -l)
  if [ "$n" -ge 2 ] && node_up; then race=1; fi
  node_up && break
  sleep 1; i=$((i+1))
done
[ "$race" = 0 ] && ok "never observed Node + a live chain both holding the DB" || no "CONCURRENT WRITERS observed"
node_up && ok "Node restored after the chain ended + deadline" || no "no restore"
grep -q CHAIN_START "$Q/timeline" 2>/dev/null && ok "the chain actually ran" || no "chain never ran"
kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T4: machine restart mid-window does NOT renew the deadline ---"
newenv; export QUIESCE_TTL=30 QUIESCE_OP_TIMEOUT=6 QUIESCE_KILL_AFTER=2 QUIESCE_MARGIN=3
wd_start; sleep 2
d1=$(cat "$Q/deadline")
printf 'sh -c "exec 8>>%s; exec sleep 120"\n' "$DB" > "$Q/RUN.tmp"; mv "$Q/RUN.tmp" "$Q/RUN"
i=0; while lock_free && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
pg=$(op_pgid); PGS="$PGS $pg"
# simulate a Fly machine stop: kill the watchdog AND the whole op group
kill -KILL "$W" 2>/dev/null
[ -n "$pg" ] && kill -KILL -- -"$pg" 2>/dev/null
sleep 2
d2=$(cat "$Q/deadline")
[ "$d1" = "$d2" ] && ok "deadline byte-identical across the restart ($d2)" || no "deadline renewed $d1 -> $d2"
t0=$(date +%s); wd_start
i=0; while ! node_up && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
dt=$(( $(date +%s) - t0 ))
{ node_up && [ "$dt" -le 8 ]; } && ok "restarted watchdog collapsed the window (Node in ${dt}s, did not wait out old deadline)" || no "restore took ${dt}s / node_up=$(node_up && echo y || echo n)"
kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T5: two concurrent RUN publications - exactly one accepted ---"
newenv; export QUIESCE_TTL=600
: > "$Q/deadline"; echo "$(( $(date +%s) + 600 ))" > "$Q/deadline"
( QUIESCE_DIR="$Q" QUIESCE_NORMALIZER="/bin/echo AAA" sh "$OW" dryrun >"$Q/o1" 2>&1 ) &
( QUIESCE_DIR="$Q" QUIESCE_NORMALIZER="/bin/echo BBB" sh "$OW" dryrun >"$Q/o2" 2>&1 ) &
wait
acc=$(grep -l 'queued: dry-run' "$Q/o1" "$Q/o2" 2>/dev/null | wc -l)
rej=$(grep -l 'refusing to overwrite' "$Q/o1" "$Q/o2" 2>/dev/null | wc -l)
{ [ "$acc" -eq 1 ] && [ "$rej" -eq 1 ]; } && ok "exactly one publication accepted, the other rejected" || no "acc=$acc rej=$rej"
if [ -f "$Q/RUN" ]; then
  lines=$(wc -l < "$Q/RUN"); fb=$(head -c1 "$Q/RUN")
  { [ "$lines" -eq 1 ] && [ -n "$fb" ]; } && ok "RUN is exactly one complete line (atomic, no interleave)" || no "RUN has $lines lines / firstbyte='$fb'"
else no "no RUN produced"; fi
ls "$Q"/.run.* >/dev/null 2>&1 && no "a temp .run.* file leaked" || ok "no leftover temp files - tmp+rename only"

# ---------------------------------------------------------------------------
echo "--- T6: single manifest via O_EXCL - a second create fails ---"
newenv
M="$Q/manifest.test.json"
( set -C; : > "$M" ) 2>/dev/null && ok "first O_EXCL create of the manifest succeeds" || no "first create failed"
( set -C; : > "$M" ) 2>/dev/null && no "second O_EXCL create of the same manifest SUCCEEDED (bug)" || ok "second O_EXCL create is refused"
# and op-wrap hands out a fresh manifest path per dryrun
: > "$Q/deadline"; echo "$(( $(date +%s) + 600 ))" > "$Q/deadline"
QUIESCE_DIR="$Q" QUIESCE_NORMALIZER="/bin/echo X" sh "$OW" dryrun >"$Q/d1" 2>&1
m1=$(sed -n 's/.*manifest=//p' "$Q/d1")
rm -f "$Q/RUN"
QUIESCE_DIR="$Q" QUIESCE_NORMALIZER="/bin/echo X" sh "$OW" dryrun >"$Q/d2" 2>&1
m2=$(sed -n 's/.*manifest=//p' "$Q/d2")
{ [ -n "$m1" ] && [ -n "$m2" ] && [ "$m1" != "$m2" ]; } && ok "op-wrap dryrun uses a fresh manifest path each time" || no "manifest path reused: '$m1' vs '$m2'"

# ---------------------------------------------------------------------------
echo "--- T7: DISARM during a running op is deferred structurally via the lock ---"
newenv; export QUIESCE_TTL=40 QUIESCE_OP_TIMEOUT=8 QUIESCE_KILL_AFTER=2 QUIESCE_MARGIN=3
wd_start; sleep 1
printf 'sh -c "exec 8>>%s; echo OPGO > %s/opgo; exec sleep 5"\n' "$DB" "$Q" > "$Q/RUN.tmp"; mv "$Q/RUN.tmp" "$Q/RUN"
i=0; while [ ! -f "$Q/opgo" ] && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
pg=$(op_pgid); PGS="$PGS $pg"
: > "$Q/DISARM"
sleep 2
node_up && no "Node started while the op still held the lock (RACE)" || ok "DISARM did not start Node while the op runs"
i=0; while ! node_up && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
node_up && ok "Node restored once the op finished and released the lock" || no "no restore after op end"
kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T8: missing-primitive check FAILS HARD in CI mode (not a SKIP) ---"
FAKEPATH="$ROOT/emptybin"; mkdir -p "$FAKEPATH"
# a PATH with none of timeout/flock/setsid; run the suite in CI mode; expect exit 1
out=$(PATH="$FAKEPATH" CI=1 sh "$HERE/run-linux.sh" 2>&1); rc=$?
{ [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'FAIL: required primitive'; } \
  && ok "CI mode with primitives absent exits 1 (hard fail, no green SKIP)" || no "CI-mode missing-primitive check did not hard-fail (rc=$rc)"
out=$(PATH="$FAKEPATH" sh "$HERE/run-linux.sh" 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^SKIP'; } \
  && ok "non-CI dev box with primitives absent SKIPs cleanly (exit 0)" || no "non-CI missing-primitive path did not SKIP (rc=$rc)"

# ---------------------------------------------------------------------------
echo "--- T9: zero pkill / pgrep / /proc/[0-9] kills anywhere in sources or logs ---"
bad=0
for f in "$WD" "$OW" "$HERE/run-linux.sh"; do
  grep -Eq 'pkill|pgrep' "$f" && { no "$(basename "$f") references pkill/pgrep"; bad=1; }
done
# the watchdog must only ever kill groups (negative pids); no bare `kill <pid>`
grep -Eq 'kill +-(TERM|KILL|[0-9]+) +[0-9]' "$WD" && { no "watchdog.sh kills a bare PID"; bad=1; }
for L in "$ROOT"/q.*/watchdog.log; do
  [ -f "$L" ] || continue
  grep -Eiq 'pkill|pgrep|/proc/[0-9]' "$L" && { no "watchdog.log mentions pkill/pgrep/proc-scan"; bad=1; }
done
[ "$bad" -eq 0 ] && ok "no pkill/pgrep/proc-scan/bare-PID-kill in sources or logs"

echo
echo "=== native watchdog Linux suite: PASS=$P FAIL=$F ==="
[ "$F" -eq 0 ]
