# Native quiesce fail-safe

Reference for the migration-recovery window. Exact commands live in `DEPLOY.md`;
this file keeps the invariants only.

## Invariants

1. One absolute deadline, written once on the volume.
2. One shared `flock` lock gates the operator chain and Node-direct.
3. The supervisor lives outside the chain process group and kills only the known
   pgid it created.
4. `op-wrap` publishes an atomic typed request, refuses to clobber queued work,
   and only the supervised executor may advance `manifest.current`. Manifest
   pointers contain one exact generated basename, never a shell fragment or
   path.
5. `QUIESCE_MIN_ADMISSION` defaults to `600`; production does not define or
   lower it.
6. Every recovery uses a unique timestamped `QUIESCE_DIR`; there is no `/tmp`
   manifest protocol.
7. If recovery ends, restore the normal entrypoint, remove the normalizer from
   `/app`, then remove the exact machine-side files and `rmdir` the unique
   directory. Any unexpected leftover file must make the final `rmdir` fail.
8. Never touch SQLite manually on the machine while the window is armed.
9. The legacy-FK recovery has independent `fk-dryrun`/`fk-apply` commands,
   proof and manifest pointers. It never runs external-ID migration resolution
   or `prisma migrate deploy`.
10. The legacy-FK executable verifies the inherited watchdog lock and its
    unlinked execution capability before opening SQLite; a static environment
    marker is insufficient.

See `DEPLOY.md` for the arm/apply/disarm/cleanup commands and evidence checks.
The one-off legacy-FK operation is documented separately in
`legacy-fk-recovery.md`; it does not change any vault-activation profile.
