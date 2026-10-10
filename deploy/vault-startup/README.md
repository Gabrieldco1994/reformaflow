# Private vault production startup — preparation only

**STOP: this is not deployment, merge approval, or activation evidence.** No Fly
configuration, production defaults, financial-write flags, or migration SQL change.
Parent owns push and Linux CI invocation; no local Docker proof is claimed.

## Contract

- The default is OFF. Only literal `IMPORT_VAULT_ENABLED=true` requests ON.
  OFF ignores invalid vault settings and does not inspect/open/provision the vault.
  Existing uploads setup and `prisma migrate deploy` still run; OFF is not a
  database-write freeze.
  **OFF is only partial containment, not a complete financial freeze.**
  Already materialized qualified CSV/PDF sessions may still prepare, confirm,
  and execute: `importSessionWritesEnabled` checks persisted extraction/evidence
  independently of vault runtime. Their existing authorization, revision,
  review/challenge and financial gates still apply. This preparation does not
  redesign that authority or promise those actions are disabled.
- ON requires explicit `VAULT_DIR=/data/import-vault`, idle, headroom, and drain
  values accepted by `parseVaultConfig`. Launcher supplies descriptor 9 only when
  omitted; a different explicit descriptor is rejected. No sizing defaults or
  ephemeral/non-Linux fallback exist. Zero drain is valid, not a recommendation.
- `/data` must be an explicit writable ext4 mount. Root, `t`, `trash` are
  directories mode `0700`; `.lock` is a single-link regular file mode `0600`.
  All four must have the API EUID and `/data` device. Existing invalid nodes fail
  without chmod/chown, unlink, truncation, or recursive cleanup.
- Before creation, after provisioning/flock, and in actual bootstrap, inspect
  layout and public/private upload roots using the canonical resolver. Reject
  symlink components/descendants, nested layout/upload mounts, overlapping roots,
  device/inode aliases and multiply-linked vault files. Inspection errors fail
  closed. Startup never clears stored documents or trash.
- Provision only missing allowed nodes with restrictive umask/exclusive lock
  creation. Open `.lock` read-only without create/truncate; util-linux `flock`
  selects a single writer **nonblocking, before migration**. Canonical Linux
  `/proc` proof must verify inherited FD9, device/inode and exclusive WRITE flock.
- Unchanged migrations run before Node. The API is PID1 (`exec`), independently
  waits for its actual injected gate to settle ON before administration/listen,
  and installs Nest shutdown hooks. Failure closes the app and exits nonzero.
  SIGTERM fences admission and drains the existing registry; FD9 stays held until
  process exit. Diagnostics are bounded event/reason tokens, not document/path
  dumps.

Assumptions: one cooperating ON process on one machine/volume; no hostile
same-EUID or privileged mount/path mutation. Node path APIs are not an `openat`
security boundary. Do not alter upload aliases or mounts while ON. A local flock
does not fence an old OFF process or machines with separate volumes. Replacement
ON processes fail immediately while the old process holds the lock; a quiesced,
non-overlapping release remains an external prerequisite.

## Evidence and Linux job

Local RED at base `37470cb9`: actual bootstrap resolved despite requested-ON
physical failure and omitted shutdown hooks. Local targeted tests cover actual
bootstrap ordering, canonical boundaries, OFF isolation, unsafe existing nodes,
alias rejection, exclusive creation, partial layout and inode/content preservation.

The separate `production-vault-startup` job in `maria-csv-vault-qa.yml` builds the
**actual Dockerfile/runtime**, mounts a disposable loopback ext4 filesystem at
`/data`, and runs the actual tracked entrypoint against `test.db`. It uses no
production credentials, hosted models, or Maria QA launcher. It tests HTTP
readiness, authentication/typed OFF response, real ON gate event, PID1/FD9 Linux
proof, collision-before-migration, simultaneous creation barriers, private
synthetic CSV/PDF upload/download/restart, migration failure, filesystem/config
rejection, missing lock/flock, real gate faults, and real SIGTERM lease drains.
Test-only preload instrumentation is bind-mounted, never shipped in the image.
The OFF-after-ON test persists synthetic documents through real ON uploads,
then restarts the actual entrypoint OFF. It verifies RAW create/reserve/analyze
are disabled and observes **two real EVERY_MINUTE cron callbacks** (not manually
invoked ticks), retaining admission fences and unchanged full documentary rows,
inode/content snapshots, no automated purge/rename, and SIGTERM persistence.
It does not claim an OFF materialized-session financial-action kill switch.
OFF Node may allocate an unrelated internal descriptor numbered 9; OFF evidence
requires no inherited vault flock, not prohibition of Node's internal descriptors.

Independent upgrade proof from `b3e0e26f` is integrated unchanged. The canonical
32-orphan fixture's final 69→72 deploy is adapted through the actual production
entrypoint by `test/canonical-image.setup.cjs`; the original fixture still seeds
and asserts exact FK tuples and full financial snapshots. Seeding FK-OFF is
restricted to its disposable synthetic fixture, never a repair. The clean-FK
test remains unchanged. The adapter copies only the guarded synthetic database,
uses basename `test.db` in the ext4 container, and returns the upgraded file for
the canonical assertions.

Local SQLite CLI is 3.51; reported production CLI is 3.40. The job prints both
the actual runtime image CLI version and Prisma engine's `sqlite_version()`.
CLI and Prisma engine versions are separate evidence. Until that job runs, Linux
startup/upgrade/runtime-version proof is **pending**, not green by inference.
Parent must arrange a branch trigger/push; this change does not activate a flag
or add a release branch trigger. The owned preparation branch
`feat/maria-vault-startup-20261010` is now in the workflow push list for Linux QA.

## Release remains separately blocked

SRE/PO must disposition the 32 pre-existing FK orphans and review all pending
migrations' persisted-data effects **even with vault OFF**. No repair or migration
bypass is added here. Require restorable backup, reviewed retention/data-effect
manifest and upgrade evidence before merge/deployment.

Before any later explicit ON authorization, require persistent encrypted-volume
inventory (mountinfo proves filesystem/mount, not encryption or Fly identity),
single-machine/quiesced release plan, PO-approved retention/backup/restore policy,
and sizing for existing 1 GiB global/200 MiB tenant/10 MiB per-file limits,
transient parser/upload overhead, trash and public/private growth, SQLite
WAL/journals/migrations, backup overlap and emergency reserve. Headroom is a
threshold snapshot, not an atomic disk reservation. Match signal-drain budget to
Fly kill grace and operation deadlines. The image tests' 1 MiB threshold is
**disposable QA only**, not production sizing approval.
SRE's suggested headroom 512 MiB, idle 300000 ms and drain 5000 ms remain
PO-approval-pending recommendations only; none are production defaults here.

The Linux cleanup trap unmounts only its unique loopback mount, removes only its
unique backing image, then `rmdir`s the mountpoint/runtime. Fixture content lives
on the mounted image, so it is not present beneath the mountpoint after unmount.
No broad directory removal or production volume cleanup is performed.
