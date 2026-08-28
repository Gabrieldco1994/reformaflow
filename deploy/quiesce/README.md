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

## Arm (transfer + checksum all THREE scripts first)

```sh
# extract from the tested PR HEAD, then local<->remote SHA-256 each:
#   deploy/quiesce/watchdog.sh   -> /app/watchdog.sh
#   deploy/quiesce/op-wrap.sh    -> /app/op-wrap.sh
#   scripts/normalize-external-id-duplicates.mjs -> /app/normalize-external-id-duplicates.mjs
# (flyctl ssh sftp put ... --mode 0500 ; compare sha256sum). See DEPLOY.md step 4.

# only with all three checksums matching:
flyctl machine update <machine-id> --app reformaflow-api \
  --machine-config '{"init":{"entrypoint":null,"cmd":["sh","/app/watchdog.sh"]}}' --yes
# QUIESCE_DIR defaults to /data/quiesce on the volume.
```

## Operate (all through `op-wrap`, never a raw shell)

```sh
op-wrap status
op-wrap dryrun                         # queues the normalizer dry-run; manifest.current set only on exit 0
op-wrap apply <sha256> <groups> <updates>   # queues normalize --apply && migrate resolve && migrate deploy
op-wrap disarm                         # after deploy: go Node-direct as soon as the lock is free
```

`apply` validates the hash as `^[0-9a-f]{64}$` and the two counts as
`^[0-9]+$` before it publishes anything.

## Disarm / cleanup

`op-wrap disarm` (or the absolute deadline, or a restart with a free lock) makes
the watchdog exec Node-direct. Then, once the API is healthy, SRE clears the
machine override so the Dockerfile `CMD` (migrate-first entrypoint) governs again:

```sh
flyctl machine update <machine-id> --machine-config '{"init":{"entrypoint":null,"cmd":null}}' --yes
```

Remove the shipped `watchdog.sh` and any manifest from the machine (exact paths,
no wildcard) as part of evidence-preservation cleanup.

## Caveat — no manual SQLite during a window

**Do not open `sqlite3`, `prisma studio`, `node`, or any other DB client on the
machine outside `op-wrap` while a window is armed.** The lock only protects the
supervised chain and Node-direct; a hand-run writer bypasses it and can corrupt
the recovery. Every DB touch goes through `op-wrap dryrun` / `op-wrap apply`.
