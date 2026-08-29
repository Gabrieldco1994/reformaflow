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
# pick a working process-group signal form (same logic as watchdog.sh)
GKFORM=""
_pp_probe(){
  # throwaway process this run owns; pid captured directly (no file, no stale PID)
  setsid sleep 6 >/dev/null 2>&1 &
  pp=$!
  sleep 0.3
  for f in 'kill -%s -%d' 'kill -%s -- -%d' '/bin/kill -%s -%d' '/bin/kill -%s -- -%d'; do
    $(printf "$f" 0 "$pp") 2>/dev/null || continue
    $(printf "$f" KILL "$pp") 2>/dev/null; sleep 0.3
    $(printf "$f" 0 "$pp") 2>/dev/null || { GKFORM="$f"; break; }
  done
  kill -KILL "$pp" 2>/dev/null || true
  [ -n "$GKFORM" ] && $(printf "$GKFORM" KILL "$pp") 2>/dev/null
  [ -n "$GKFORM" ]
}
gkill(){    $(printf "$GKFORM" "$(echo "$1" | tr -d -)" "$2") 2>/dev/null || true; }
grp_alive(){ $(printf "$GKFORM" 0 "$1") 2>/dev/null; }

require(){
  miss=""
  [ -n "${QUIESCE_TEST_FORCE_MISSING:-}" ] && miss=" (forced-missing test hook)"
  for need in timeout flock setsid; do
    command -v "$need" >/dev/null 2>&1 || miss="$miss $need"
  done
  # lsof is a test dependency (DB-holder introspection), not a runtime primitive
  command -v lsof >/dev/null 2>&1 || miss="$miss lsof"
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
  if [ "$F" -ne 0 ] || [ -n "${KEEP_ARTIFACTS:-}" ]; then
    for L in "$ROOT"/q.*/watchdog.log "$ROOT"/q.*/op.log; do
      [ -f "$L" ] || continue
      echo "--- $L ---"; sed 's/^/    /' "$L"
    done
  fi
  for g in $PGS; do [ -n "$g" ] && gkill -KILL "$g"; done
  for p in $WPIDS; do gkill -KILL "$p"; kill -KILL "$p" 2>/dev/null || true; done
  [ -n "${KEEP_ARTIFACTS:-}" ] && echo "kept: $ROOT" || rm -rf "$ROOT"
}
trap cleanup EXIT INT TERM

if _pp_probe; then
  echo "    group-signal form: [$GKFORM]"
else
  echo "FAIL: no working process-group signal form on this host (CI must have one)"
  [ -n "$CI_MODE" ] && exit 1
  echo "SKIP: cannot signal process groups here"; exit 0
fi

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
         QUIESCE_POLL=1 QUIESCE_LOCK_WAIT=12 QUIESCE_MIN_ADMISSION=1 \
         QUIESCE_OP_TIMEOUT=1 QUIESCE_KILL_AFTER=1 QUIESCE_MARGIN=1 QUIESCE_TTL=60
}
wd_start(){ setsid sh "$WD" >>"$Q/wd.stdout" 2>&1 & W=$!; WPIDS="$WPIDS $W"; }
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
( exec 7>>"$DB"; trap '' TERM; while :; do sleep 1; done ) &
while :; do sleep 1; done
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
[ -n "$pg" ] && { grp_alive "$pg" && no "known pgid $pg still alive" || ok "known pgid fully reaped"; }
i=0; while ! node_up && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
node_up && ok "watchdog restored Node-direct at the deadline" || echo "  (info: Node not yet restored - awaits deadline/disarm after a completed chain)"
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T2: reparented orphan (direct child exits, descendant survives in the pgid) ---"
newenv; export QUIESCE_TTL=60 QUIESCE_OP_TIMEOUT=30 QUIESCE_KILL_AFTER=3 QUIESCE_MARGIN=5
wd_start; sleep 2
cat > "$Q/chain.sh" <<CH
exec 8>>"$DB"
( exec 7>>"$DB"; exec sleep 300 ) &
echo \$! > "$Q/orphan.pid"
sleep 5
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
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

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
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T4: machine restart mid-window does NOT renew the deadline ---"
newenv; export QUIESCE_TTL=30 QUIESCE_OP_TIMEOUT=6 QUIESCE_KILL_AFTER=2 QUIESCE_MARGIN=3
wd_start; sleep 2
d1=$(cat "$Q/deadline")
printf 'sh -c "exec 8>>%s; exec sleep 120"\n' "$DB" > "$Q/RUN.tmp"; mv "$Q/RUN.tmp" "$Q/RUN"
i=0; while lock_free && [ $i -lt 10 ]; do sleep 1; i=$((i+1)); done
pg=$(op_pgid); PGS="$PGS $pg"
# simulate a Fly machine stop: kill the watchdog AND the whole op group
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null
[ -n "$pg" ] && gkill -KILL "$pg"
sleep 2
d2=$(cat "$Q/deadline")
[ "$d1" = "$d2" ] && ok "deadline byte-identical across the restart ($d2)" || no "deadline renewed $d1 -> $d2"
t0=$(date +%s); wd_start
i=0; while ! node_up && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
dt=$(( $(date +%s) - t0 ))
{ node_up && [ "$dt" -le 8 ]; } && ok "restarted watchdog collapsed the window (Node in ${dt}s, did not wait out old deadline)" || no "restore took ${dt}s / node_up=$(node_up && echo y || echo n)"
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

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
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T8: missing-primitive check FAILS HARD in CI mode (not a SKIP) ---"
out=$(QUIESCE_TEST_FORCE_MISSING=1 CI=1 sh "$HERE/run-linux.sh" 2>&1); rc=$?
{ [ "$rc" -eq 1 ] && printf '%s\n' "$out" | grep -q 'FAIL: required primitive'; } \
  && ok "CI mode with a primitive absent exits 1 (hard fail, no green SKIP)" || no "CI-mode missing-primitive check did not hard-fail (rc=$rc): $out"
out=$(env -u CI -u QUIESCE_CI -u GITHUB_ACTIONS QUIESCE_TEST_FORCE_MISSING=1 sh "$HERE/run-linux.sh" 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^SKIP'; } \
  && ok "non-CI dev box with a primitive absent SKIPs cleanly (exit 0)" || no "non-CI missing-primitive path did not SKIP (rc=$rc): $out"

# ---------------------------------------------------------------------------
echo "--- T9: zero pkill / pgrep / proc-scan in executable source lines or watchdog logs ---"
bad=0
# strip comments and shebang, then look for an actual invocation
code_of(){ sed -e 's/[[:space:]]#.*$//' -e '/^[[:space:]]*#/d' "$1"; }
for f in "$WD" "$OW"; do
  code_of "$f" | grep -Eq '(^|[;&|( ])(pkill|pgrep)( |$)' && { no "$(basename "$f") invokes pkill/pgrep"; bad=1; }
done
# the watchdog must only ever signal groups via the gsig/galive helpers (-- -<pgid>);
# no bare `kill <pid>` of anything other than $SUP_PID / $bgpid / $cpid.
code_of "$WD" | grep -Eq 'kill +-(TERM|KILL|[0-9]+) +[0-9]' && { no "watchdog.sh signals a hard-coded PID"; bad=1; }
for L in "$ROOT"/q.*/watchdog.log; do
  [ -f "$L" ] || continue
  grep -Eiq 'pkill|pgrep|/proc/[0-9]' "$L" && { no "a watchdog.log mentions pkill/pgrep/proc-scan"; bad=1; }
done
[ "$bad" -eq 0 ] && ok "no pkill/pgrep/proc-scan in executable source or logs; only known-group signaling"

# ---------------------------------------------------------------------------
echo "--- T10: startup probe owns its pid directly - a stale probe file is never signalled ---"
newenv; export QUIESCE_TTL=8
# plant a stale probe file pointing at a live process WE own
sleep 300 & STALE=$!; WPIDS="$WPIDS $STALE"
echo "$STALE" > "$Q/.gkprobe"
wd_start; sleep 3
kill -0 "$STALE" 2>/dev/null && ok "stale .gkprobe PID still alive - watchdog never read/signalled it" || no "the stale-file PID was killed on startup (BUG)"
grep -Eq '\.gkprobe|cat .*probe|kill .*\$\(cat' "$WD" && no "watchdog.sh still reads a PID from a probe file" || ok "watchdog.sh has no probe-file PID read"
i=0; while ! node_up && [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done
node_up && ok "watchdog still restored Node at the deadline" || no "no restore"
kill -KILL "$STALE" 2>/dev/null
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T11: publish into a non-writable dir fails (non-zero, no success line) ---"
newenv
: > "$Q/deadline"; echo "$(( $(date +%s) + 600 ))" > "$Q/deadline"
chmod 0555 "$Q"
out=$(QUIESCE_DIR="$Q" QUIESCE_NORMALIZER="/bin/echo X" sh "$OW" dryrun 2>&1); rc=$?
chmod 0755 "$Q"
{ [ "$rc" -ne 0 ] && ! printf '%s\n' "$out" | grep -q 'queued'; } \
  && ok "read-only publish returns rc=$rc with no success line" || no "rc=$rc out='$out'"
[ -e "$Q/RUN" ] && no "a RUN file appeared despite the failure" || ok "no RUN produced on failure"

# ---------------------------------------------------------------------------
echo "--- T12: a second publish during an active operation is rejected for the whole window ---"
newenv; export QUIESCE_TTL=60 QUIESCE_OP_TIMEOUT=20 QUIESCE_KILL_AFTER=2 QUIESCE_MARGIN=5
wd_start; sleep 1
printf 'sh -c "exec 8>>%s; exec sleep 6"\n' "$DB" > "$Q/RUN.tmp"; mv "$Q/RUN.tmp" "$Q/RUN"
i=0; while [ ! -e "$Q/RUN.active" ] && [ $i -lt 12 ]; do sleep 1; i=$((i+1)); done
pg=$(op_pgid); PGS="$PGS $pg"
[ -e "$Q/RUN.active" ] && ok "RUN.active present while the chain runs" || no "RUN.active missing during the chain"
out=$(QUIESCE_DIR="$Q" QUIESCE_NORMALIZER="/bin/echo X" sh "$OW" dryrun 2>&1); rc=$?
{ [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -q 'already queued or active'; } \
  && ok "second publish rejected while the op is active" || no "second publish not rejected (rc=$rc out='$out')"
# RUN.active must persist through the supervisor's post-exit teardown too
i=0; while [ -e "$Q/RUN.active" ] && [ $i -lt 25 ]; do sleep 1; i=$((i+1)); done
[ ! -e "$Q/RUN.active" ] && ok "RUN.active cleared only after the supervisor exited (~${i}s)" || no "RUN.active never cleared"
out=$(QUIESCE_DIR="$Q" QUIESCE_NORMALIZER="/bin/echo X" sh "$OW" dryrun 2>&1); rc=$?
{ [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q 'queued: dry-run'; } \
  && ok "a fresh publish is accepted once the window slot is free" || no "post-window publish rejected (rc=$rc out='$out')"
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T13: dry-run is FAIL-CLOSED - manifest.current published only after the normalizer exits 0 ---"
newenv; export QUIESCE_TTL=60 QUIESCE_OP_TIMEOUT=15 QUIESCE_KILL_AFTER=2 QUIESCE_MARGIN=5
wd_start; sleep 1   # newenv already exports QUIESCE_APP_DIR="$Q"
# a normalizer that WRITES the manifest then FAILS (proves the pointer is gated
# on exit code, not on the manifest file merely existing)
# stubs receive: $1=--dry-run $2=--manifest $3=<manifest path>. They write the
# manifest file, then exit 1 (fail) or 0 (ok) - proving the pointer is gated on
# exit code, not on the manifest file merely existing.
NRM_FAIL="$Q/nrm_fail"; printf '#!/bin/sh\n: > "$3"\nexit 1\n' > "$NRM_FAIL"; chmod +x "$NRM_FAIL"
NRM_OK="$Q/nrm_ok";     printf '#!/bin/sh\n: > "$3"\nexit 0\n' > "$NRM_OK";   chmod +x "$NRM_OK"
mpath(){ grep -o 'manifest=[^ ]*' "$1" | head -1 | cut -d= -f2; }
QUIESCE_DIR="$Q" QUIESCE_APP_DIR="$Q" QUIESCE_NORMALIZER="$NRM_FAIL" sh "$OW" dryrun >"$Q/dr1" 2>&1
i=0; while { [ -e "$Q/RUN" ] || [ -e "$Q/RUN.active" ]; } && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
[ ! -e "$Q/manifest.current" ] && ok "failed normalizer left NO manifest.current" || no "manifest.current appeared after a failed normalizer ($(cat "$Q/manifest.current"))"
ls "$Q"/.mcur.* >/dev/null 2>&1 && no "a partial .mcur.* pointer leaked" || ok "no partial pointer file"
# now a succeeding normalizer -> pointer appears and equals the emitted path
QUIESCE_DIR="$Q" QUIESCE_APP_DIR="$Q" QUIESCE_NORMALIZER="$NRM_OK" sh "$OW" dryrun >"$Q/dr2" 2>&1
m2=$(mpath "$Q/dr2")
i=0; while { [ -e "$Q/RUN" ] || [ -e "$Q/RUN.active" ]; } && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
rec=$(cat "$Q/manifest.current" 2>/dev/null)
{ [ -n "$m2" ] && [ "$rec" = "$m2" ]; } && ok "successful dry-run publishes manifest.current == emitted path" || no "m2='$m2' recorded='$rec'"
# a subsequent FAILED dry-run must leave the good pointer untouched
QUIESCE_DIR="$Q" QUIESCE_APP_DIR="$Q" QUIESCE_NORMALIZER="$NRM_FAIL" sh "$OW" dryrun >"$Q/dr3" 2>&1
i=0; while { [ -e "$Q/RUN" ] || [ -e "$Q/RUN.active" ]; } && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
[ "$(cat "$Q/manifest.current" 2>/dev/null)" = "$m2" ] && ok "a later failed dry-run leaves the prior manifest.current untouched" || no "manifest.current changed to '$(cat "$Q/manifest.current" 2>/dev/null)'"
gkill -KILL "$W"; kill -KILL "$W" 2>/dev/null

# ---------------------------------------------------------------------------
echo "--- T16: protocol checker + watchdog boundary checks ---"
REPO="$HERE/../../.."
DEPLOY="$REPO/DEPLOY.md"
proto_ok=0
check_protocol_file(){
  file="$1"
  phase1_block=$(sed -n '/^4\. \*\*Fase 1/,/^4\.1\./p' "$file")
  arm_line=$(grep -n '^4\.1\.' "$file" | head -1 | cut -d: -f1)
  phase2_line=$(grep -n '^4\.2\.' "$file" | head -1 | cut -d: -f1)
  [ -n "$arm_line" ] && [ -n "$phase2_line" ] || return 1
  [ "$phase2_line" -gt "$arm_line" ] || return 1

  arm_block=$(sed -n '/^4\.1\./,/^4\.2\./p' "$file")
  phase2_block=$(sed -n '/^4\.2\./,/^5\./p' "$file")

  printf '%s\n' "$phase1_block" | grep -Fq -- "--skip-health-checks" || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'MACHINE_JSON="$(flyctl machines list --json --app reformaflow-api)"' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'jq -e --arg id "$MACHINE_ID" --arg q "$QUIESCE_DIR"' || return 1
  printf '%s\n' "$arm_block" | grep -Fq '.[0].config.init.cmd == ["sh", ($q + "/watchdog.sh")]' || return 1
  printf '%s\n' "$arm_block" | grep -Fq '.[0].config.env.QUIESCE_DIR == $q' || return 1
  printf '%s\n' "$arm_block" | grep -Fq '[ -s \"\$Q/deadline\" ]' || return 1
  printf '%s\n' "$arm_block" | grep -Fq '[ -e \"\$Q/lock\" ]' || return 1
  printf '%s\n' "$arm_block" | grep -Fq '[ -f \"\$Q/watchdog.log\" ]' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'argv0=\${1:-}' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'argv1=\${2:-}' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'tr "\\0" "\\n"' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'watchdog_found=1' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'node_direct_found=1' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'node_direct_found=0' || return 1
  printf '%s\n' "$arm_block" | grep -Fq 'pgrep' && return 1
  printf '%s\n' "$arm_block" | grep -Fq '/app/watchdog.sh' && return 1
  printf '%s\n' "$arm_block" | grep -Fq 'curl' && return 1
  printf '%s\n' "$arm_block" | grep -Fq '{"init":{"entrypoint":["/usr/local/bin/node"],"cmd":["apps/api/dist/main.js"]}}' || return 1
  printf '%s\n' "$arm_block" | grep -Fq '["/usr/local/bin/node"]' || return 1
  printf '%s\n' "$arm_block" | grep -Fq '["apps/api/dist/main.js"]' || return 1
  printf '%s\n' "$phase2_block" | grep -Fq 'scripts/normalize-external-id-duplicates.mjs' || return 1
  printf '%s\n' "$phase2_block" | grep -Fq '/app/normalize-external-id-duplicates.mjs' || return 1
  return 0
}

check_protocol_file "$DEPLOY" && ok "protocol checker accepts the real DEPLOY.md" || { no "protocol checker rejected DEPLOY.md"; proto_ok=1; }

check_finish_protocol_file(){
  file="$1"
  restore_block=$(sed -n '/^11\. \*\*Restaurar entrypoint:/,/^12\. \*\*Encerrar:/p' "$file")
  restore_code_block=$(printf '%s\n' "$restore_block" | awk '
    BEGIN { in_code = 0 }
    /^    ```bash$/ { in_code = 1; next }
    in_code && /^    ```$/ { exit }
    in_code { print }
  ')
  cleanup_block=$(awk '
    /^12\. \*\*Encerrar:/ { in_section = 1 }
    in_section {
      if ($0 ~ /^Não adicione\[processes\] app="\/entrypoint\.sh"/ || $0 ~ /^### /) exit
      print
    }
  ' "$file")
  cleanup_code_blocks=$(printf '%s\n' "$cleanup_block" | awk '
    BEGIN { in_code = 0 }
    /^[[:space:]]*```(bash|sh)$/ { in_code = 1; next }
    in_code && /^[[:space:]]*```$/ { in_code = 0; next }
    in_code { print }
  ')

  printf '%s\n' "$restore_block" | grep -Fq 'flyctl machine update "$MACHINE_ID" --app reformaflow-api' || return 1
  printf '%s\n' "$restore_block" | grep -Fq -- '--machine-config' || return 1
  printf '%s\n' "$restore_block" | grep -Fq -- '{"init":{"entrypoint":null,"cmd":null}}' || return 1
  printf '%s\n' "$restore_code_block" | grep -Fq -- '--skip-health-checks' && return 1
  printf '%s\n' "$restore_block" | grep -Fq 'MACHINE_JSON="$(flyctl machines list --json --app reformaflow-api)"' || return 1
  printf '%s\n' "$restore_block" | grep -Fq 'CHECKS_JSON="$(flyctl checks list --json --app reformaflow-api)"' || return 1
  printf '%s\n' "$restore_block" | grep -Fq 'jq -e --arg id "$MACHINE_ID"' || return 1
  printf '%s\n' "$restore_block" | grep -Fq 'has($id) and (keys | length == 1) and (.[$id] | length == 1) and (.[$id][0].status == "passing")' || return 1
  printf '%s\n' "$restore_block" | grep -Fq 'https://reformaflow-api.fly.dev/api/docs-json' || return 1
  printf '%s\n' "$restore_block" | grep -Fq 'https://reformaflow-api.fly.dev/auth/me' || return 1
  printf '%s\n' "$restore_block" | grep -Fq '[ "$docs_code" = 200 ]' || return 1
  printf '%s\n' "$restore_block" | grep -Fq '[ "$auth_code" = 401 ]' || return 1
  printf '%s\n' "$restore_block" | grep -Fq 'flyctl logs --no-tail --machine "$MACHINE_ID" --app reformaflow-api' || return 1

  printf '%s\n' "$cleanup_block" | grep -Fq 'case "$QUIESCE_DIR" in' || return 1
  printf '%s\n' "$cleanup_block" | grep -Fq '/data/quiesce-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z' || return 1
  printf '%s\n' "$cleanup_block" | grep -Fq 'case "$REMOTE_MANIFEST" in' || return 1
  printf '%s\n' "$cleanup_block" | grep -Fq '"$QUIESCE_DIR"/manifest.*.json' || return 1
  printf '%s\n' "$cleanup_block" | grep -Fq 'rm -f -- /app/normalize-external-id-duplicates.mjs' || return 1
  printf '%s\n' "$cleanup_block" | grep -Fq 'rm -f --' || return 1
  printf '%s\n' "$cleanup_block" | grep -Fq "rmdir -- '\$QUIESCE_DIR'" || return 1
  printf '%s\n' "$cleanup_code_blocks" | grep -Fq 'rm -rf' && return 1
  printf '%s\n' "$cleanup_code_blocks" | grep -Fq '|| true' && return 1
  return 0
}

check_finish_protocol_file "$DEPLOY" && ok "finish protocol checker accepts the real DEPLOY.md" || { no "finish protocol checker rejected DEPLOY.md"; proto_ok=1; }

PROTO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qwd-proto.XXXXXX")"
M1="$PROTO_DIR/missing-skip.md"
M2="$PROTO_DIR/docs-url.md"
M3="$PROTO_DIR/missing-path-validation.md"
M4="$PROTO_DIR/missing-rmdir.md"
cp "$DEPLOY" "$M1"
cp "$DEPLOY" "$M2"
cp "$DEPLOY" "$M3"
cp "$DEPLOY" "$M4"
perl -0pi -e 's/\{"init":\{"entrypoint":null,"cmd":null\}\}/{"init":{"entrypoint":null,"cmd":"removed"}}/' "$M1"
perl -0pi -e 's#https://reformaflow-api.fly.dev/api/docs-json#https://reformaflow-api.fly.dev/api/docs#' "$M2"
perl -0pi -e 's#    case "\$QUIESCE_DIR" in#    case removed#; s#    case "\$REMOTE_MANIFEST" in#    case removed#' "$M3"
perl -0pi -e 's/rmdir -- '\''\$QUIESCE_DIR'\''"/rmdir removed/' "$M4"

for mutant in "$M1" "$M2" "$M3" "$M4"; do
  if check_finish_protocol_file "$mutant"; then
    no "finish protocol checker accepted mutated $(basename "$mutant")"
    proto_ok=1
  else
    ok "finish protocol checker rejects $(basename "$mutant")"
  fi
done

[ "$proto_ok" -eq 0 ] && ok "protocol checker covers skip-health, /app init, process scan and finish contracts" || no "protocol checker failed"

# ---------------------------------------------------------------------------
echo "--- T16a0: default minimum admission without env stays at 600s ---"
Q0="$PROTO_DIR/default-min-$$"
mkdir -p "$Q0"
env -u QUIESCE_MIN_ADMISSION QUIESCE_DIR="$Q0" QUIESCE_TTL=1139 QUIESCE_OP_TIMEOUT=480 QUIESCE_KILL_AFTER=30 QUIESCE_MARGIN=29 \
  QUIESCE_APP_DIR="$Q0" timeout 2 sh "$HERE/../watchdog.sh" >"$Q0/log" 2>&1
RC=$?
if [ "$RC" -eq 124 ] && [ -f "$Q0/deadline" ] && [ -f "$Q0/lock" ] && [ -f "$Q0/watchdog.log" ] && \
   grep -q 'admission window valid: 600s >= 600s minimum' "$Q0/watchdog.log"; then
  ok "T16a0: watchdog defaults to minimum admission=600s without env"
else
  no "T16a0: watchdog default minimum admission=600s did not hold (rc=$RC)"
fi
rm -rf "$Q0"

# ---------------------------------------------------------------------------
echo "--- T16a: boundary test - admission window 600s passes under timeout 2 ---"
QB="$PROTO_DIR/boundary-600-$$"
mkdir -p "$QB"
QUIESCE_MIN_ADMISSION=600 QUIESCE_DIR="$QB" QUIESCE_TTL=1139 QUIESCE_OP_TIMEOUT=480 QUIESCE_KILL_AFTER=30 QUIESCE_MARGIN=29 \
  QUIESCE_APP_DIR="$QB" timeout 2 sh "$HERE/../watchdog.sh" >"$QB/log" 2>&1
RC=$?
if [ "$RC" -eq 124 ] && [ -f "$QB/deadline" ] && [ -f "$QB/lock" ] && [ -f "$QB/watchdog.log" ] && \
   grep -q 'admission window valid: 600s >= 600s minimum' "$QB/watchdog.log"; then
  ok "T16a: watchdog admission=600s timed out under timeout 2 with logs present"
else
  no "T16a: watchdog admission=600s did not time out cleanly (rc=$RC)"
fi
rm -rf "$QB"

# ---------------------------------------------------------------------------
echo "--- T16b: boundary test - admission window 599s fails ---"
QC="$PROTO_DIR/boundary-599-$$"
mkdir -p "$QC"
QUIESCE_MIN_ADMISSION=600 QUIESCE_DIR="$QC" QUIESCE_TTL=1139 QUIESCE_OP_TIMEOUT=480 QUIESCE_KILL_AFTER=30 QUIESCE_MARGIN=30 \
  QUIESCE_APP_DIR="$QC" timeout 2 sh "$HERE/../watchdog.sh" >"$QC/log" 2>&1
RC=$?
if [ "$RC" -eq 1 ] && grep -q 'FATAL: .*admission window' "$QC/log" && \
   [ ! -e "$QC/deadline" ] && [ ! -e "$QC/lock" ] && [ ! -e "$QC/watchdog.log" ]; then
  ok "T16b: watchdog admission=599s rejected at the 600s production boundary"
else
  no "T16b: watchdog admission=599s was not rejected cleanly (rc=$RC)"
fi
rm -rf "$QC"

# ---------------------------------------------------------------------------
echo "--- T17: POSIX path validation and rmdir failure are honest ---"
cleanup_ok=0
case "/data/quiesce-20260828T210456Z" in
  /data/quiesce-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ok "T17: valid Q format matches POSIX case" ;;
  *) no "T17: valid Q format does not match POSIX case"; cleanup_ok=1 ;;
esac

case "/invalid-quiesce-dir" in
  /data/quiesce-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) no "T17: invalid Q format matched (should not)"; cleanup_ok=1 ;;
  *) ok "T17: invalid Q format rejected by POSIX case" ;;
esac

case "/data/quiesce-20260828T210456Z/manifest.captured.json" in
  /data/quiesce-*/manifest.*.json) ok "T17: manifest child path matches case glob" ;;
  *) no "T17: manifest child path does not match case glob"; cleanup_ok=1 ;;
esac

case "/tmp/manifest.wrong.json" in
  /data/quiesce-*/manifest.*.json) no "T17: manifest outside Q matched (should not)"; cleanup_ok=1 ;;
  *) ok "T17: manifest outside Q rejected by case glob" ;;
esac

UNKNOWN_DIR="$PROTO_DIR/unknown-$$"
mkdir -p "$UNKNOWN_DIR"
UNKNOWN_FILE="$UNKNOWN_DIR/unexpected.txt"
: > "$UNKNOWN_FILE"
if rmdir "$UNKNOWN_DIR" 2>/dev/null; then
  no "T17: rmdir unexpectedly succeeded on a non-empty unknown path"
  cleanup_ok=1
else
  ok "T17: rmdir fails on a non-empty unknown path"
fi
rm -f -- "$UNKNOWN_FILE"
if rmdir "$UNKNOWN_DIR" 2>/dev/null; then
  ok "T17: cleanup rmdir succeeds after removing the unexpected file"
else
  no "T17: cleanup rmdir still failed after removing the unexpected file"
  cleanup_ok=1
fi

[ "$cleanup_ok" -eq 0 ] && ok "T17: POSIX path assertions and rmdir failure behave honestly" || no "T17 check failed: see flags above"
rm -rf "$PROTO_DIR"


# ---------------------------------------------------------------------------
echo "--- T15: no canonical source re-introduces the old /tmp-manifest / direct-normalizer protocol ---"
REPO="$HERE/../../.."
oldproto=0
flag(){ no "$1"; oldproto=1; }
for S in "$REPO/DEPLOY.md" "$REPO/AGENTS.md" "$REPO/.claude/skills/release-verification/SKILL.md" \
         "$HERE/../README.md" "$HERE/../watchdog.sh" "$OW"; do
  b=$(basename "$S"); [ -f "$S" ] || { no "$S missing"; oldproto=1; continue; }
  grep -Eq '/tmp/[^ ]*manifest' "$S"                 && flag "$b has a /tmp manifest literal"
  grep -Eq 'REMOTE_MANIFEST=.?/tmp'                  "$S" && flag "$b sets REMOTE_MANIFEST to a /tmp path"
  grep -Eq 'recovery-manifest-private-\$RECOVERY_RUN' "$S" && flag "$b uses the old recovery-manifest-private-\$RECOVERY_RUN path"
  grep -Eq 'normalize-external-id-duplicates\.mjs --(dry-run|apply)' "$S" \
    && flag "$b invokes the normalizer directly (must go through the op-wrap chain)"
  if grep -q 'REMOTE_MANIFEST=' "$S"; then
    { grep -Eq 'REMOTE_MANIFEST="\$\(' "$S" && grep -Fq 'manifest.current' "$S"; } \
      || flag "$b sets REMOTE_MANIFEST without deriving it from \$QUIESCE_DIR/manifest.current"
  fi
done
[ "$oldproto" -eq 0 ] && ok "no /tmp-manifest / direct-normalizer / stale-REMOTE_MANIFEST protocol in any canonical source"

# ---------------------------------------------------------------------------
echo "--- T14: 'abort' is gone from the CLI and the docs ---"
sh "$OW" bogusverb >/dev/null 2>"$ROOT/usage" || true
grep -q 'abort' "$ROOT/usage" && no "op-wrap usage still lists abort" || ok "op-wrap usage has no abort"
grep -Eq '(^|[^a-z])abort([^a-z]|$)' "$OW" && no "op-wrap.sh source still mentions abort" || ok "op-wrap.sh source has no abort"
docbad=0
for D in "$HERE/../README.md" "$HERE/../../../DEPLOY.md" "$HERE/../../../AGENTS.md"; do
  [ -f "$D" ] || continue
  grep -Eiq '(op-wrap |quiesce.*)abort|abort.*DISARM' "$D" && { no "$(basename "$D") still documents an abort verb"; docbad=1; }
done
[ "$docbad" -eq 0 ] && ok "no abort verb in README/DEPLOY/AGENTS"

echo
echo "=== native watchdog Linux suite: PASS=$P FAIL=$F ==="
[ "$F" -eq 0 ]
