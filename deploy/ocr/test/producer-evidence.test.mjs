import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, sha256 } from "../../../scripts/ci/ocr-attestation.mjs";
import {
  createRuntimeSubject,
  resolveApplicationEntrypoint,
  verifyRuntimeSubject,
  verifyRuntimeSubjectArtifact,
} from "../../../scripts/ci/ocr-runtime-subject.mjs";
import {
  createRecoveryEvidence,
  validateRecoveryEvidence,
  verifyRecoveryArtifact,
} from "../../../scripts/ci/ocr-recovery-evidence.mjs";

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const imageDigest = "sha256:" + "c".repeat(64);
const configDigest = "sha256:" + "d".repeat(64);
const image = "registry.fly.io/reformaflow-api@" + imageDigest;
function runtimeContext() {
  return {
    repository: "Gabrieldco1994/reformaflow",
    repositoryId: "12345",
    repositoryOwnerId: "67890",
    commitSha: sha,
    treeSha: tree,
    workflowSha: sha,
    runId: "5001",
    runAttempt: 1,
    imageReference: image,
    observedAt: "2026-10-14T01:00:00.000Z",
  };
}
function inspect() {
  return [
    {
      Id: configDigest,
      RepoDigests: [image],
      Config: {
        Entrypoint: null,
        Cmd: ["/entrypoint.sh"],
        Labels: {
          GH_SHA: sha,
          "org.opencontainers.image.revision": sha,
          "com.reformaflow.git.tree": tree,
        },
      },
    },
  ];
}
function artifactMetadata(id, name, runId, archive) {
  return {
    id,
    name,
    expired: false,
    digest: "sha256:" + sha256(archive),
    workflow_run: { id: runId, head_repository_id: 12345, head_sha: sha },
  };
}
function artifactExpected(id, runId) {
  return {
    artifactId: String(id),
    repositoryId: "12345",
    runId: String(runId),
    runAttempt: 1,
    commitSha: sha,
    treeSha: tree,
    workflowSha: sha,
  };
}

test("runtime subject derives config launch target and exact target-byte hash", () => {
  const bytes = Buffer.from("#!/bin/sh\nexec node apps/api/dist/main.js\n");
  const receipt = createRuntimeSubject(inspect(), bytes, runtimeContext());
  assert.equal(resolveApplicationEntrypoint(inspect()), "/entrypoint.sh");
  assert.equal(receipt.image.executableSha256, sha256(bytes));
  assert.equal(receipt.image.applicationEntrypointSize, bytes.length);
  assert.equal(receipt.image.ociConfigDigest, configDigest);
  assert.equal(
    verifyRuntimeSubject(receipt, inspect(), bytes, runtimeContext()),
    receipt,
  );
  assert.throws(
    () =>
      verifyRuntimeSubject(
        receipt,
        inspect(),
        Buffer.from("mutated"),
        runtimeContext(),
      ),
    /RUNTIME_SUBJECT_MISMATCH/,
  );
  const unresolved = inspect();
  unresolved[0].Config.Cmd = ["sh", "-c", "run"];
  assert.throws(
    () => resolveApplicationEntrypoint(unresolved),
    /RUNTIME_SUBJECT_EXECUTABLE_UNRESOLVED/,
  );
});

test("runtime artifact binds DB ID GitHub digest provenance and payload digest", () => {
  const payload = Buffer.from(
    canonicalize(
      createRuntimeSubject(inspect(), Buffer.from("target"), runtimeContext()),
    ),
  );
  const archive = Buffer.from("immutable-runtime-zip");
  const metadata = artifactMetadata(
    9001,
    "ocr-runtime-subject-v1",
    5001,
    archive,
  );
  const verified = verifyRuntimeSubjectArtifact(
    metadata,
    archive,
    payload,
    artifactExpected(9001, 5001),
  );
  assert.equal(verified.runtimeSubjectArtifactSha256, sha256(payload));
  assert.throws(
    () =>
      verifyRuntimeSubjectArtifact(
        { ...metadata, digest: "sha256:" + "0".repeat(64) },
        archive,
        payload,
        artifactExpected(9001, 5001),
      ),
    /RUNTIME_SUBJECT_ARTIFACT_INVALID/,
  );
});

function backupReceipt() {
  return {
    schemaVersion: 1,
    evidenceClass: "LIVE",
    operation: "OFF_VOLUME_BACKUP_RESTORE_DRILL",
    status: "PASS",
    sourceDatabase: { identifier: "fly-volume:/data/dev.db", sizeBytes: 4096 },
    backup: {
      receiptId: "backup-100",
      completedAt: "2026-10-14T02:00:00.000Z",
      sha256: "e".repeat(64),
      sizeBytes: 4096,
      offVolumeLocation: "object-lock:backup-100",
    },
    restore: {
      receiptId: "restore-100",
      completedAt: "2026-10-14T02:10:00.000Z",
      restoredSizeBytes: 4096,
      integrityCheck: "ok",
      representativeReads: 12,
    },
  };
}
function legacyReceipt() {
  return {
    schemaVersion: 1,
    evidenceClass: "LIVE",
    operation: "LEGACY_FOUR_MIGRATION_UPGRADE_DRILL",
    status: "PASS",
    receiptId: "legacy-100",
    completedAt: "2026-10-14T02:20:00.000Z",
    sourceBackupSha256: "e".repeat(64),
    migrations: [
      "20261013180000_import_pdf_ocr_runtime",
      "20261013183000_import_ocr_usage_budget",
      "20261013233000_import_ocr_usage_foreign_keys",
      "20261014004500_import_ocr_usage_provenance",
    ],
    integrityCheck: "ok",
    representativeReads: 8,
  };
}
function recoveryContext() {
  const value = runtimeContext();
  delete value.imageReference;
  delete value.observedAt;
  value.runId = "5002";
  return value;
}

test("recovery evidence requires live fixed receipts and all four migrations", () => {
  assert.throws(
    () => createRecoveryEvidence(null, null, recoveryContext()),
    /RECOVERY_OPERATION_NOT_EXECUTED/,
  );
  const backup = Buffer.from(canonicalize(backupReceipt()));
  const legacy = Buffer.from(canonicalize(legacyReceipt()));
  const payload = createRecoveryEvidence(backup, legacy, recoveryContext());
  validateRecoveryEvidence(payload);
  for (const mutation of [{ evidenceClass: "TEST_ONLY" }, { status: "GAPS" }]) {
    const value = { ...backupReceipt(), ...mutation };
    assert.throws(
      () =>
        createRecoveryEvidence(
          Buffer.from(canonicalize(value)),
          legacy,
          recoveryContext(),
        ),
      /RECOVERY_OPERATION_NOT_EXECUTED/,
    );
  }
  const missing = legacyReceipt();
  missing.migrations.pop();
  assert.throws(
    () =>
      createRecoveryEvidence(
        backup,
        Buffer.from(canonicalize(missing)),
        recoveryContext(),
      ),
    /RECOVERY_OPERATION_NOT_EXECUTED/,
  );
});

test("recovery artifact pins run artifact GitHub digest and payload hash", () => {
  const payload = Buffer.from(
    canonicalize(
      createRecoveryEvidence(
        Buffer.from(canonicalize(backupReceipt())),
        Buffer.from(canonicalize(legacyReceipt())),
        recoveryContext(),
      ),
    ),
  );
  const archive = Buffer.from("immutable-recovery-zip");
  const metadata = artifactMetadata(
    9002,
    "ocr-recovery-evidence-v1",
    5002,
    archive,
  );
  const verified = verifyRecoveryArtifact(
    metadata,
    archive,
    payload,
    artifactExpected(9002, 5002),
  );
  assert.equal(verified.recoveryEvidenceArtifactSha256, sha256(payload));
  assert.throws(
    () =>
      verifyRecoveryArtifact(
        { ...metadata, id: 9999 },
        archive,
        payload,
        artifactExpected(9002, 5002),
      ),
    /RECOVERY_ARTIFACT_INVALID/,
  );
});
