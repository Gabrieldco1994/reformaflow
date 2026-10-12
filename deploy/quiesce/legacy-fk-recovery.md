# Dedicated legacy-FK recovery (#722)

This is a separate, one-off recovery operation. It does **not** activate the
import vault, resolve the historical external-ID migration, deploy migrations,
or authorize any other production change.

## Preconditions

- Pin and checksum the reviewed commit and all transferred artifacts.
- Take a new restorable database backup and prove the restore before arming.
- Use the existing quiesce watchdog with a unique timestamped
  `/data/quiesce-<UTC timestamp>` directory. No other writer may run.
- Keep the privately reviewed scope proof canonical JSON, regular-file mode
  `0600`, at `$QUIESCE_DIR/fk-scope-proof.json`. Never commit or publish it.
- Transfer `scripts/repair-legacy-fk-integrity.mjs` to
  `/app/repair-legacy-fk-integrity.mjs` and verify its local/remote SHA-256.
- Use only the persistent-directory `op-wrap.sh`; never invoke the repair
  script, Node, SQLite, Prisma Studio, or a migration command directly.

The proof must pin exactly two missing project IDs and their proven tenant IDs,
the exact 28 active room IDs partitioned between them, and the exact four
already-soft-deleted cash-flow IDs with their missing expense, tenant, and
project IDs. IDs and paths are confidential evidence.

The canonical shape is below. Arrays are lexicographically sorted by
`projectId`, each `roomIds` array by room ID, and cash-flow rows by
`cashFlowEntryId`; keys and two-space JSON formatting must remain exactly as
emitted before hashing.

```json
{
  "version": 1,
  "missingProjects": [
    {
      "projectId": "<private-project-id>",
      "tenantId": "<private-tenant-id>",
      "roomIds": ["<private-room-id>", "<...>"]
    },
    {
      "projectId": "<private-project-id>",
      "tenantId": "<private-tenant-id>",
      "roomIds": ["<private-room-id>", "<...>"]
    }
  ],
  "orphanCashFlowEntries": [
    {
      "cashFlowEntryId": "<private-cash-flow-id>",
      "missingExpenseId": "<private-expense-id>",
      "tenantId": "<private-tenant-id>",
      "projectId": "<private-project-id>"
    }
  ]
}
```

## Supervised commands

Compute the private proof hash locally and preserve it in the private operation
ledger. On the quiesced machine:

```sh
sh "$QUIESCE_DIR/op-wrap.sh" fk-dryrun "$SCOPE_PROOF_SHA256"
```

Wait for `op-wrap status` to report `last rc : 0`. Download the exact manifest
named by the private `$QUIESCE_DIR/fk-manifest.current` pointer, preserve it
mode `0600`, verify its SHA-256 locally, and privately review the exact set.
Only counts `2/28/4` and the first 12 manifest-hash characters are publishable.

Apply only that reviewed manifest and unchanged proof:

```sh
sh "$QUIESCE_DIR/op-wrap.sh" fk-apply \
  "$MANIFEST_SHA256" "$SCOPE_PROOF_SHA256"
```

`fk-apply` runs only the dedicated repair. It must report two project inserts,
four cash-flow updates, zero FK violations, and `rc 0`. A repeated apply must
report zero inserts and zero updates. Any count, hash, mode, topology,
dependency, integrity, or postimage mismatch is a hard stop.

## Finish and evidence

Before restoring the normal entrypoint, preserve the private mode-`0600` proof
and manifest plus their full hashes in the restricted operation ledger. Public
evidence contains counts and truncated hashes only—never IDs or paths.

Disarm through `op-wrap`, restore the normal entrypoint using the established
quiesce procedure, and run the normal machine and HTTP health gates. Remove
only the exact transferred repair script, scope proof, manifest path read from
`fk-manifest.current`, pointer, and known quiesce files; fail if the unique
directory is not empty. Do not use wildcards or recursive deletion.
