# Private vault production startup and activation runbook

**STOP: this document and its verifier PR cannot activate the vault.** They do
not authorize or perform a deploy, a Fly secret change, a financial-write flag
change, a migration, or a production test. After the corrected `main` deploy is
green, an authorized `platform-sre` must perform activation as a **separate
operational change** in an approved exclusive window.

Status on 2026-10-12: the verified deployed baseline was Fly release **v751**
at `dcc80b5bb90197d12512177368091dd410a495e7`, but run `38289933866` failed
`Validate deployed Fly machine` on its single machine-state read. That run and
baseline are not activation evidence. A separate verifier correction may make
state observation resilient; it cannot set vault configuration or satisfy this
runbook's authorization and storage preflight.

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
The existing three Maria browser jobs also provision their own disposable ext4
`/data` mount and canonical `/data/import-vault`; their development launcher
does not bypass bootstrap's production layout checks. This fixes the observed
run `38092337121` boot rejection from its older `$RUNNER_TEMP/vault` layout.
Their mount is unmounted only after owned servers stop and artifacts upload.
Run `38092337121` produced 30 passing actual-image tests and one invalid
migration-failure fixture: Prisma creates missing database parent directories,
so the supposed failure started successfully. The corrected fixture uses a
synthetic regular-file parent under disposable `/data`, proven locally to make
real `prisma migrate deploy` fail with ENOTDIR. It still requires nonzero exit,
no API bootstrap, unchanged vault snapshot and released flock; no production
entrypoint behavior or assertion is weakened. Independent fault/barrier tests
are top-level so a failing migration test cannot prevent their registration.
Run `38092729296` passed the corrected migration STOP test and all three actual
SIGTERM drain cases. It exposed an OFF preload module-resolution error (fixed
with the image's absolute dependency path) and a real timeout exit defect:
the canonical boot deadline had been unreferenced, permitting a pending-probe
process to exit zero before its OFF verdict. A real child-process RED regression
reproduced exit 0; the deadline now remains referenced until existing
settle/terminate cleanup clears it. Requested-ON still cannot listen on failure.

## Operational activation profile

The proposed profile is exact, but remains conditional on every preflight item
below. These are explicit activation values, not application defaults:

| Setting                         |        Proposed value |
| ------------------------------- | --------------------: |
| `IMPORT_VAULT_ENABLED`          |        literal `true` |
| `IMPORT_VAULT_LOCK_FD`          |                   `9` |
| `VAULT_DIR`                     |  `/data/import-vault` |
| `IMPORT_VAULT_IDLE_TIMEOUT_MS`  |              `300000` |
| `IMPORT_VAULT_HEADROOM_BYTES`   | `536870912` (512 MiB) |
| `IMPORT_VAULT_DRAIN_TIMEOUT_MS` |                `5000` |

`IMPORT_SESSION_WRITES_ENABLED` remains the compile-time constant `false` in
`apps/api/src/imports/import-session/import-session.disabled.ts`. It is **not**
an activation environment variable. Do not add a Fly secret or change code to
turn it on. The qualified CSV/PDF path remains independently gated.

### Verified preflight facts — still blocked

These facts are a prospective baseline, not completed gates:

- the observed baseline is v751 / full SHA
  `dcc80b5bb90197d12512177368091dd410a495e7`; activation must nevertheless
  re-pin whatever full SHA is current after the corrected green deploy;
- the latest snapshot has been created, but no restore-test evidence or named
  backup/restore owner exists yet, so it is not a qualified restorable backup;
- explicit Fly `SIGTERM` and a shutdown grace at least 10 seconds longer than
  the 5000 ms vault drain have not yet been evidenced; and
- rollback target v749 / `ee5e4fea338499b89a22d9701c66441401b06288`
  has not yet been boot-tested against a disposable restore of the current
  post-migration production database.

Each missing item is a STOP. A later evidence record may close it; this page
does not claim that it has.

### Hard blockers and evidence record

The authorized `platform-sre` creates one dated activation record and names the
operator, approver, backup owner and rollback owner. Stop before changing any
secret unless the record contains all of the following:

1. **Exact current SHA:** capture the full `refs/heads/main` SHA immediately
   before the window. The completed workflow and deployed machine label must
   both equal it. All required jobs, including the corrected **Deploy API to
   Fly**, must be green. Run `38289933866` does not qualify.
2. **Separate authority:** link the explicit activation authorization. A
   verifier PR, its merge, its CI, or this documentation commit is not that
   authorization.
3. **One machine and one volume:** inventory exactly one API machine and its
   exact attached volume ID. It must be the authorized persistent volume on
   that machine; no second machine, old process, replacement, detached clone or
   separate volume may be able to serve or write during the window.
4. **Storage identity and encryption:** preserve evidence that `/data` is one
   writable ext4 mount and that its mount device, machine attachment and Fly
   volume ID agree. Preserve platform evidence that the identified volume is
   encrypted. `/proc/*/mountinfo` proves mount/type/device only; it does **not**
   prove Fly volume identity or encryption. Existing vault/upload roots must
   pass the ownership, mode, symlink, hard-link, device and overlap checks in
   the contract above.
5. **Restorable backup:** identify an off-volume backup made for this window,
   its integrity evidence, restore procedure, successful restore check and
   named owner. The latest snapshot exists but currently has neither
   restore-test evidence nor an owner, so it does not satisfy this gate. A copy
   on the same volume is not a restorable disaster backup.
6. **Migrations and FK integrity:** show all expected migrations applied on the
   production database. The normal gate remains
   `PRAGMA foreign_key_check = 0`. The sole exception is the one-window #722
   vault activation baseline described below: exactly 28 active
   `rooms` → `projects` plus 4 soft-deleted `cash_flow_entries` → `expenses`
   (32 total), retained byte-identically between capture and compare. No other
   unresolved FK row or migration state is accepted. Do not use raw SQLite,
   `prisma db execute`, reset, repair, migration bypass or any FK-OFF writer.
7. **Retention approval:** link PO/data-owner approval for original-document
   retention, seven-day inactivity expiry, trash, backup retention, restore and
   deletion responsibilities. Code defaults and QA evidence are not policy
   approval.
8. **Capacity:** record current volume size/free bytes and approved peak
   calculations for the existing 1 GiB global, 200 MiB tenant and 10 MiB
   per-file limits; concurrent upload/parser temporary space; trash; public and
   private uploads; SQLite WAL/journals/migrations; the off-volume backup
   process if it stages locally; backup overlap; and emergency reserve.
   `536870912` is only a startup threshold snapshot, not an atomic reservation.
9. **Termination budget:** require explicit Fly `SIGTERM` and prove the
   deployed kill grace is at least the proposed `5000` ms drain **plus 10 full
   seconds** of shutdown margin (at least 15000 ms total). It must also cover
   the measured operation deadline. Implicit/default signal, unknown grace, or
   less than that margin is a STOP. This requires a separately reviewed
   deployment/configuration correction before ON; documentation cannot supply
   it.
10. **Exclusive operation window:** freeze deploys, secret/config changes,
    machine replacement, scaling, mount/alias changes, backup jobs that use the
    volume and concurrent maintenance. Record the start/end and the sole
    operator. The old process must fully exit before its replacement can own
    FD9.
11. **Rollback compatibility:** boot v749 /
    `ee5e4fea338499b89a22d9701c66441401b06288` against a disposable restore of
    the **current post-migration production database**. Record successful
    startup, migration compatibility, health and a no-mutation comparison.
    Never point this test at production and never make the restore by copying
    private data into an unapproved environment. Until that evidence exists,
    activation is blocked even if every ON check passes.

Do not publish credentials, tokens, document names/content, database rows or
raw private paths beyond the canonical paths already in this contract. Store
the sanitized command transcript and identifiers with the operational record.

## Separate activation sequence

The sequence starts only after the blocker record is complete.

### One-window #722 FK preservation exception

The PO intentionally chose preservation, not repair: the 32 known legacy child
rows remain byte-identical. There is no quarantine, deletion, relink, tenant
inference or parent synthesis. This exception authorizes neither a migration nor
future debt and does not weaken `npm run db:check`, CI, pre-commit or any global
FK gate. `IMPORT_SESSION_WRITES_ENABLED` remains the source constant `false`.
It is prohibited to use repair, raw SQLite or migrations for this exception.

For this vault activation window only, the approved read-only evidence is
`scripts/audit-vault-fk-baseline.mjs`, invoked in production only through
`deploy/vault-startup/run-fk-baseline-audit.sh`. The launcher fixes
`/data/dev.db`, `/data`, `/data/vault-fk-baseline.private.json`,
`/data/vault-fk-baseline.authorization.json` and
`/app/audit-vault-fk-baseline.mjs`; it accepts only `capture` or `compare`,
requires an explicit writable ext4 `/data` mount on the database device, and
checks the exact auditor SHA-256 embedded in the tracked launcher. The auditor
opens SQLite explicitly read-only, pins one connection and one read
transaction, enables and verifies `query_only`, and rejects unstable
path/descriptor identity. Its exact snapshot also includes the relevant
`sqlite_schema` table/index/trigger SQL, `table_xinfo`, complete index metadata,
and the directly referenced parent table definitions. This binds generated and
hidden columns, CHECK/collation text, partial/unique indexes, triggers,
deferrability, STRICT and WITHOUT ROWID declarations. Any SQLite REAL storage
class in an affected row is unsupported and fails closed; no decimal rendering
is treated as byte identity. Transfer the two executables from the pinned release,
verify the launcher itself against the reviewed release, and never substitute a
path, statement, table, tenant selector, apply verb or migration command.

Before capture, the approver creates the external authorization as canonical
JSON at the fixed authorization path, regular single-link mode `0600`. It binds
the exact full release SHA, release ID, image digest, auditor artifact SHA-256,
authorization ID, random nonce, window ID/start/expiry and this exception's
purpose. Its full SHA-256 is supplied separately to the launcher. The window is
at most four hours. The authorization is not generated or self-approved by the
auditor.

The private manifest is exclusively created as a regular single-link `0600`
file in state `captured`. It contains rowids, exact FK multiplicity and
definitions, table column contracts, typed values and full hashes: keep it only
in the restricted activation record, never stdout, an issue, PR, artifact or
general log. Supply the exact release/image/authorization/window values through
the required `VAULT_FK_*` variables. They must be identical for capture and
compare, current, and unique to this window. Compare exclusively creates the
fixed `0600` `.consumed` receipt before reporting success; an existing receipt,
clock rollback, second compare or recapture is a replay and a STOP.

1. Run launcher `capture` only after freeze/quiescence and all other preflight
   gates. Existing manifest, unsafe path/mode/link, any count/type other than
   28/4/32, or any additional violation is a STOP.
2. Immediately before activation run launcher `compare`. Any changed typed
   column bytes, row/FK identity, count, release, image, authorization, window,
   manifest integrity or path identity is a STOP. Keep the database quiescent
   through the activation decision.
3. After ON evidence and the retain-ON/flag-OFF decision are recorded, preserve
   the approved private authorization, manifest and consumed receipt, then
   clean up only those three exact files and the exact transferred auditor and
   launcher named by the record. No wildcard and no database/vault cleanup.

Production QA is **review-only** for this release. A deny/flag network guard
must fail the run if any `POST` reaches confirmation-challenge, confirm or
execute. QA may navigate the typed import review only until state **READY** with
`proposal` non-null, `confirmation` and `receipt` null, and state never
`APPLIED`, then stops. Before/after evidence must show no financial-table
change and no `UserActivityLog` execute event. It never calls `challenge`,
`confirm` or `execute`, and never uploads a real document as part of activation
proof.

This is enforced by the checked-in
`deploy/vault-startup/run-production-qa-guard.sh` and
`deploy/vault-startup/production-qa-guard.mjs`, not by operator convention.
Transfer those exact two release artifacts to
`/app/run-production-qa-guard.sh` and
`/app/vault-production-qa-guard.mjs`, verify the launcher against the pinned
release, and supply one identical set of `VAULT_QA_RELEASE_SHA`,
`VAULT_QA_RELEASE_ID`, `VAULT_QA_IMAGE_DIGEST`, `VAULT_QA_WINDOW_ID`,
`VAULT_QA_WINDOW_START`, `VAULT_QA_WINDOW_END`, and `VAULT_QA_ACTOR` values to
all three modes. The launcher accepts only `capture`, `guard`, or `compare`;
the database, private evidence paths, loopback port `4317`, and production API
origin are fixed. There is no SQL, database, origin, table or tenant argument.

1. Run `run-production-qa-guard.sh capture` after quiescence. It takes one
   read-only SQLite transaction and exclusively creates the mode-`0600`
   baseline bound to database device/inode and the release/image/window/QA
   actor.
2. Run `run-production-qa-guard.sh guard`, and make the SRE-driven journey use
   only `http://127.0.0.1:4317`. The guard forwards to the fixed production
   origin, records only counters, rejects every matching import-session
   confirmation-challenge/confirm/execute `POST`, rejects CONFIRMED/APPLIED or
   malformed READY responses, and stops import-session traffic after the first
   valid READY response. Authorization headers, response bodies, routes and
   session IDs are never written to evidence or stdout.
3. Stop the guard immediately after READY and require its zero exit. Then run
   `run-production-qa-guard.sh compare`. Compare requires a zero-forbidden,
   zero-state-violation READY trace and exact before/after counts plus hashes
   for `bank_accounts`, `bank_statement_imports`, `budget_allocations`,
   `cash_flow_entries`, `credit_cards`, `credit_card_imports`,
   `cross_project_settlements`, `expenses`, `imported_invoice_liquidations`,
   `invoice_adjustments`, `rateio_allocations`, and `receipts`, plus exact
   count/hash equality for
   `user_activity_logs.action = 'importSessions.execute'`. It exclusively
   creates the consumed receipt. A changed identity/fingerprint, metadata
   mismatch, missing READY, forbidden attempt, existing receipt, or reused
   trace is a STOP; start a newly authorized window rather than overwrite.

4. **Freeze and pin.** Enter the exclusive window. Record `EXPECTED_SHA` from
   current `origin/main`; do not copy a SHA from this page. Re-read current main
   immediately before the change and stop if it moved. Record the green
   workflow URL/run ID, sole machine ID, volume ID, current release/image digest
   and pre-change health.
5. **Finish read-only preflight.** Reconfirm machine/volume uniqueness,
   attachment, ext4/rw/device identity, encryption evidence, free space,
   ownership/modes/aliases, backup restorability, migrations/FK, retention
   approval, explicit SIGTERM plus the 10-second shutdown margin, and the v749
   disposable-restore boot test. Do not create or repair vault nodes manually;
   the fail-closed launcher provisions only missing allowed nodes.
6. **Apply the whole profile once.** The authorized `platform-sre`, from the
   reviewed transcript, runs:

   ```bash
   flyctl secrets set --app reformaflow-api \
     IMPORT_VAULT_ENABLED=true \
     IMPORT_VAULT_LOCK_FD=9 \
     VAULT_DIR=/data/import-vault \
     IMPORT_VAULT_IDLE_TIMEOUT_MS=300000 \
     IMPORT_VAULT_HEADROOM_BYTES=536870912 \
     IMPORT_VAULT_DRAIN_TIMEOUT_MS=5000
   ```

   `flyctl secrets set` is an operational release/restart. Do not combine it
   with a source deploy, scale change, migration repair or any
   `IMPORT_SESSION_WRITES_ENABLED` setting.

7. **Observe replacement to completion.** Use bounded polling rather than a
   single machine-state read. Stop and execute flag-off rollback if there is
   more than one machine, the old process overlaps, the machine does not settle
   `started`, the sole check does not pass, the release/image/SHA differs, the
   volume attachment changes, or any `vault_startup:*`/`vault_boot` failure is
   reported.
8. **Collect the exact ON evidence below.** Do not ask the PO to upload or test
   a real document until every item is attached to the activation record.
9. **Hand off, then unfreeze.** Only after ON evidence is complete may the PO
   perform the separately approved real journey. Keep the rollback owner
   present through that test. End the exclusive window only after the decision
   to retain ON or roll back is recorded.

### Exact ON evidence required before the PO test

All items are required; a green workflow or absence of errors alone is not ON:

- activation timestamp, operator, authorization, exact current-main SHA and the
  sanitized six-setting command transcript;
- one machine ID in `started`, exactly one passing check, its
  `image_ref.labels.GH_SHA` equal to the pinned SHA, latest release `complete`,
  and release image equal to the machine image (ignoring its digest suffix);
- the same authorized volume ID attached to that sole machine, with `/data`
  still writable ext4 on the recorded device and the independent encryption
  evidence unchanged;
- PID1 is the API, `/proc/1/fd/9` resolves to
  `/data/import-vault/.lock`, FD9's device/inode equals the lock path, and
  `/proc/1/fdinfo/9` shows the exclusive advisory WRITE flock. Record only
  bounded stat/fd evidence; never dump `/proc/1/environ`;
- `/data/import-vault`, `t` and `trash` are API-EUID-owned directories mode
  `0700`; `.lock` is an API-EUID-owned, single-link regular file mode `0600`;
  all are on the `/data` device, with no nested mount or upload-root alias;
- post-start logs contain no activation-time `vault_startup:*`,
  `event=vault_boot` error, drain timeout or lock replacement/collision;
- `/api/docs-json` returns 200 and unauthenticated `/auth/me` returns 401; and
- using a pre-approved authenticated operator identity, a read-only
  `GET /import-sessions` returns only the projected availability evidence
  `entry: { kind: "CARD_INVOICE", formats: ["CSV", "PDF"] }`. Do not retain or
  publish the returned session `items`. This read does not authorize upload,
  confirmation or execution.

Requested-ON startup verifies the physical layout and flock before migration,
and API bootstrap independently waits for the runtime gate before listening.
Consequently, the pinned profile plus the positive FD9/layout and read-only
availability proofs establish ON without a real document. Secret-name presence,
`configured: true`, HTTP health by itself, or a verifier PR does not.

## Rollback

### First response: flag OFF and preserve vault bytes

For any failed/uncertain activation or PO stop decision, fence new vault
admission first:

```bash
flyctl secrets set --app reformaflow-api IMPORT_VAULT_ENABLED=false
```

This restart must be observed with the same one-machine/release/health checks.
OFF intentionally does not inspect, truncate, unlink, rename, purge or recreate
the vault. Do not unset the other five profile values, delete
`/data/import-vault`, detach the volume, run cleanup, or roll schema back.
Record bounded pre/post inode, size and content-integrity evidence for the vault
bytes without exposing names or content. Preserve the backup and volume.

Flag-OFF is also the rollback for any failure of the #722 preservation
exception. Do not repair the 32 rows, open raw SQLite, run a migration, or
recapture under a reused/extended window. Close the window and start a newly
authorized process from the top.

OFF is only vault-admission containment. As stated in the contract, already
materialized qualified sessions can retain independent prepare/confirm/execute
authority; use the separately authorized financial containment procedure if
that risk must also be fenced.

### Application rollback: release v749 / `ee5e4fea`

If application rollback is also authorized, keep the vault flag OFF and have
`platform-sre` roll the API back to Fly release **v749**, whose expected image
label is the full commit
`ee5e4fea338499b89a22d9701c66441401b06288`. Verify that exact release/image/SHA
mapping in Fly before selecting it; stop if it does not match.

This production rollback target is not authorized until the pre-activation
gate has booted v749 successfully against a disposable restore of the current
post-migration production database and preserved the reviewed evidence. The
existing snapshot does not satisfy that test while restore proof and ownership
remain missing.

The rollback is application-only. **Retain the additive schema and all vault
bytes.** Do not run down migrations, drop import tables/columns, restore an old
database over the current one, or remove the volume. After rollback, repeat the
one-machine, release/image, check and HTTP evidence, and keep the backup until
the incident owner closes the window. A later reactivation starts again at the
top of this runbook; it is never an automatic forward toggle.

## Canonical deploy command preparation

The existing serialized `deploy-api` command now selects `--strategy immediate
--ha=false --update-only`: replace existing machines without rolling overlap or
automatic HA creation. Full-SHA stale-run checks, serialization, machine/release
identity checks and HTTP contracts are unchanged. Release contract tests assert
the exact argv and reject removal of each safeguard or a strategy change; the
entrypoint contract reads the tracked shell copied by Docker, not obsolete inline
Dockerfile text.

These flags are **not proof of process non-overlap** and do not authorize a
deploy. SRE must observe machine/process lifecycle during a separately authorized
operation; quiescence, backup, migration disposition and PO-approved downtime
remain prerequisites. No deployment, vault activation or financial change is
performed by this preparation.

The Linux cleanup trap unmounts only its unique loopback mount, removes only its
unique backing image, then `rmdir`s the mountpoint/runtime. Fixture content lives
on the mounted image, so it is not present beneath the mountpoint after unmount.
No broad directory removal or production volume cleanup is performed.
