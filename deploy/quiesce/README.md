# Native quiesce fail-safe

Machine-side quiescer for the migration-recovery window (issue #629). It replaces
the machine command (`sleep infinity`) while an operator runs the
normalize -> `migrate resolve` -> `migrate deploy` chain by hand, and guarantees
the API comes back on its own even if every operator connection dies.

Built from three primitives already in the runtime image and on `ubuntu-latest`:
`timeout` (GNU coreutils), `setsid` + `flock` (util-linux). No daemon, no PID
file for unknown processes, no token, no `pkill`/`pgrep`, no `/proc` scan.

## Files

| file            | role |
|-----------------|------|
| `watchdog.sh`   | the Fly **machine command** during the window (set via `flyctl machine update --command`) |
| `op-wrap.sh`    | operator **control client**, run through `flyctl ssh console --command` |
| `test/run-linux.sh` | adversarial suite (real Linux only; CI job `quiesce-failsafe`) |

## Invariants

1. **One absolute deadline, written once.** `$QUIESCE_DIR/deadline` is created
   with an `O_EXCL` hardlink. A machine restart re-reads it and never renews it.
   A restart while the lock is free **collapses** the window immediately (Node
   comes back now), it never extends it.
2. **One shared lock (`flock`, fd 9) gates the DB.** The operator chain runs
   under a **supervisor** that holds fd 9 for the chain's whole lifetime,
   including every descendant that inherits the fd. Node-direct is started
   **only after acquiring that same lock**. Node and a live chain (or a
   reparented orphan of it) can therefore never open `/data/dev.db` at once.
3. **The supervisor lives outside the chain's process group.** It starts the
   chain with `setsid` (new session/group), records that one pgid, waits, and on
   timeout terminates **only that known pgid**: `TERM` group -> grace -> `KILL`
   group. This reaps the reparented orphans that GNU `timeout` leaves behind
   when its direct child exits early. It confirms the group is gone before it
   releases the lock.
4. **Nothing else is ever signalled.** The only thing the watchdog kills is a
   process group it created itself (or its own throwaway startup probe process,
   pid captured directly). There is **no "cancel a running chain" verb** —
   `timeout` inside the supervisor is the only automatic cancellation. `op-wrap
   disarm` only requests the Node-direct restore once the lock is free.
5. **Control is published atomically and never clobbered.** `op-wrap` serializes
   on a publish lock, writes a temp file, `mv`s it into place, and **refuses**
   if `RUN` or `RUN.active` already exists. `RUN.active` is held for the whole
   supervisor lifetime (chain running *and* its post-exit teardown), so a second
   op cannot be queued for the entire window. Every `mktemp`/write/`mv` failure
   propagates a non-zero exit with no success line. Two concurrent publications:
   exactly one wins.
6. **Fresh window = fresh dir + fresh manifest, fail-closed.** Every recovery
   attempt uses a new `QUIESCE_DIR` and every `op-wrap dryrun` picks a new
   manifest path; the supervised chain publishes `$QUIESCE_DIR/manifest.current`
   (atomically) **only after the normalizer exits 0** — a failed/killed
   normalizer leaves the prior pointer untouched, never a partial/forward one.
   `apply` and every download/cleanup read the path from `manifest.current`.

## Arm — Phase 1 (transfer + checksum watchdog and op-wrap BEFORE machine update)

```sh
# extract from the tested PR HEAD, then local<->remote SHA-256 each:
#   deploy/quiesce/watchdog.sh  -> ${QUIESCE_DIR}/watchdog.sh
#   deploy/quiesce/op-wrap.sh   -> ${QUIESCE_DIR}/op-wrap.sh
# where QUIESCE_DIR is a fresh timestamp-based persistent directory: /data/quiesce-<RECOVERY_RUN>
# (flyctl ssh sftp put ... --mode 0500 ; compare sha256sum). See DEPLOY.md step 4.

# only with both checksums matching, arm the machine with --skip-health-checks:
# (watchdog is not an HTTP server, so health checks would fail; their absence is intentional)
RECOVERY_RUN="$(date -u +%Y%m%dT%H%M%SZ)"
QUIESCE_DIR="/data/quiesce-${RECOVERY_RUN}"
flyctl machine update <machine-id> --app reformaflow-api \
  --skip-health-checks \
  --env "QUIESCE_DIR=${QUIESCE_DIR}" \
  --machine-config '{"init":{"entrypoint":null,"cmd":["sh","'"${QUIESCE_DIR}"'/watchdog.sh"]}}' --yes
# QUIESCE_DIR is now unique per recovery attempt, persisted on the volume.
```

## Arm — Phase 2 (transfer + checksum normalizer AFTER machine update)

```sh
# extract from the tested PR HEAD:
#   scripts/normalize-external-id-duplicates.mjs -> /app/normalize-external-id-duplicates.mjs
# (flyctl ssh sftp put ... --mode 0500 ; compare sha256sum). See DEPLOY.md step 5.
# Only then run dry-run via op-wrap dryrun.
```

## Operate (all through `op-wrap`, never a raw shell)

```sh
op-wrap status
op-wrap dryrun                         # queues the normalizer dry-run; manifest.current set only on exit 0
op-wrap apply <sha256> <groups> <updates>   # queues normalize --apply && migrate resolve && migrate deploy
op-wrap disarm                         # after deploy: go Node-direct as soon as the lock is free
```

Run each command on the machine via:
```sh
QUIESCE_DIR="/data/quiesce-<RECOVERY_RUN>" sh "${QUIESCE_DIR}/op-wrap.sh" <cmd> ...
```

`apply` validates the hash as `^[0-9a-f]{64}$` and the two counts as
`^[0-9]+$` before it publishes anything.

## Disarm / cleanup

`op-wrap disarm` (or the absolute deadline, or a restart with a free lock) makes
the watchdog exec Node-direct. Then, once the API is healthy, SRE clears the
machine override so the Dockerfile `CMD` (migrate-first entrypoint) governs again:

```sh
# NOTE: Restore does NOT use --skip-health-checks; it waits for health.
flyctl machine update <machine-id> --app reformaflow-api \
  --machine-config '{"init":{"entrypoint":null,"cmd":null}}' --yes
```

After the normal entrypoint is restored, remove the normalizer from `/app`:

```sh
flyctl ssh console --app reformaflow-api --machine <machine-id> \
  --command "rm -f -- /app/normalize-external-id-duplicates.mjs"
```

Then remove the shipped scripts and manifest from the machine (exact paths,
no wildcard, exact list only) as part of evidence-preservation cleanup.
Validate that `QUIESCE_DIR` matches the expected format and `REMOTE_MANIFEST`
is a child of it. Use fail-closed cleanup (set -e):

```sh
QUIESCE_DIR="/data/quiesce-<RECOVERY_RUN>"
REMOTE_MANIFEST="<path-from-manifest.current>"

flyctl ssh console --app reformaflow-api --machine <machine-id> \
  --command "set -e && \
[[ '$QUIESCE_DIR' =~ ^/data/quiesce-[0-9]{8}T[0-9]{6}Z$ ]] && \
[[ '$REMOTE_MANIFEST' == '$QUIESCE_DIR'/manifest.*.json ]] && \
rm -f -- \
  '$QUIESCE_DIR/watchdog.sh' \
  '$QUIESCE_DIR/op-wrap.sh' \
  '$REMOTE_MANIFEST' \
  '$QUIESCE_DIR/manifest.current' \
  '$QUIESCE_DIR/deadline' \
  '$QUIESCE_DIR/lock' \
  '$QUIESCE_DIR/RUN' \
  '$QUIESCE_DIR/RUN.active' \
  '$QUIESCE_DIR/DISARM' \
  '$QUIESCE_DIR/op.pgid' \
  '$QUIESCE_DIR/op.pgid.raw' \
  '$QUIESCE_DIR/op.rc' \
  '$QUIESCE_DIR/.publish.lock' \
  '$QUIESCE_DIR/watchdog.log' \
  '$QUIESCE_DIR/op.log' && \
rmdir -- '$QUIESCE_DIR'"
```

Exact cleanup: only watchdog.sh, op-wrap.sh, manifest files (from manifest.current),
manifest.current, deadline, lock, RUN, RUN.active, DISARM, op.pgid, op.pgid.raw,
op.rc, .publish.lock, watchdog.log, op.log. No wildcard patterns, no rm -rf.
Any unexpected file causes the cleanup to fail (set -e enforces it).

## Caveat — no manual SQLite during a window

**Do not open `sqlite3`, `prisma studio`, `node`, or any other DB client on the
machine outside `op-wrap` while a window is armed.** The lock only protects the
supervised chain and Node-direct; a hand-run writer bypasses it and can corrupt
the recovery. Every DB touch goes through `op-wrap dryrun` / `op-wrap apply`.
