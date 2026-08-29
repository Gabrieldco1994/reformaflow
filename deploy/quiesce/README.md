# Native quiesce fail-safe

Reference for the migration-recovery window. Exact commands live in `DEPLOY.md`;
this file keeps the invariants only.

## Invariants

1. One absolute deadline, written once on the volume.
2. One shared `flock` lock gates the operator chain and Node-direct.
3. The supervisor lives outside the chain process group and kills only the known
   pgid it created.
4. `op-wrap` publishes atomically, refuses to clobber queued work, and only the
   normalizer may advance `manifest.current`.
5. Every recovery uses a unique timestamped `QUIESCE_DIR`; there is no `/tmp`
   manifest protocol.
6. If recovery ends, restore the normal entrypoint, remove the normalizer from
   `/app`, then remove the exact machine-side files and `rmdir` the unique
   directory. Any unexpected leftover file must make the final `rmdir` fail.
7. Never touch SQLite manually on the machine while the window is armed.

See `DEPLOY.md` for the arm/apply/disarm/cleanup commands and evidence checks.
