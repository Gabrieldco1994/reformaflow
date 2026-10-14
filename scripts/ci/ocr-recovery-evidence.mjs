#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, parseStrictJson, sha256 } from "./ocr-attestation.mjs";

const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const WORKFLOW_PATH = ".github/workflows/ocr-recovery-evidence.yml";
const ARTIFACT_NAME = "ocr-recovery-evidence-v1";
const MIGRATIONS = [
  "20261013180000_import_pdf_ocr_runtime",
  "20261013183000_import_ocr_usage_budget",
  "20261013233000_import_ocr_usage_foreign_keys",
  "20261014004500_import_ocr_usage_provenance",
];
function fail(code) {
  throw new Error(code);
}
function object(value, code = "RECOVERY_EVIDENCE_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}
function exact(value, keys, code = "RECOVERY_EVIDENCE_INVALID") {
  object(value, code);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail(code);
}
function match(value, pattern, code = "RECOVERY_EVIDENCE_INVALID") {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
function timestamp(value, code = "RECOVERY_EVIDENCE_INVALID") {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(code);
  return value;
}
function positive(value, code = "RECOVERY_EVIDENCE_INVALID") {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}
function validateContext(context) {
  exact(context, [
    "repository",
    "repositoryId",
    "repositoryOwnerId",
    "commitSha",
    "treeSha",
    "workflowSha",
    "runId",
    "runAttempt",
  ]);
  match(context.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  match(String(context.repositoryId), ID);
  match(String(context.repositoryOwnerId), ID);
  match(context.commitSha, SHA);
  match(context.treeSha, SHA);
  match(context.workflowSha, SHA);
  match(String(context.runId), ID);
  if (context.runAttempt !== 1) fail("RECOVERY_RUN_ATTEMPT_UNSUPPORTED");
  return context;
}
function liveRoot(value, operation) {
  exact(
    value,
    operation === "OFF_VOLUME_BACKUP_RESTORE_DRILL"
      ? [
          "schemaVersion",
          "evidenceClass",
          "operation",
          "status",
          "sourceDatabase",
          "backup",
          "restore",
        ]
      : [
          "schemaVersion",
          "evidenceClass",
          "operation",
          "status",
          "receiptId",
          "completedAt",
          "sourceBackupSha256",
          "migrations",
          "integrityCheck",
          "representativeReads",
        ],
  );
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== "LIVE" ||
    value.operation !== operation ||
    value.status !== "PASS"
  )
    fail("RECOVERY_OPERATION_NOT_EXECUTED");
}
function validateBackup(value) {
  liveRoot(value, "OFF_VOLUME_BACKUP_RESTORE_DRILL");
  exact(value.sourceDatabase, ["identifier", "sizeBytes"]);
  match(value.sourceDatabase.identifier, /^[A-Za-z0-9._:/-]{3,256}$/);
  positive(value.sourceDatabase.sizeBytes);
  exact(value.backup, [
    "receiptId",
    "completedAt",
    "sha256",
    "sizeBytes",
    "offVolumeLocation",
  ]);
  match(value.backup.receiptId, /^[A-Za-z0-9._:-]{3,256}$/);
  timestamp(value.backup.completedAt);
  match(value.backup.sha256, HASH);
  positive(value.backup.sizeBytes);
  match(value.backup.offVolumeLocation, /^[A-Za-z0-9._:/-]{3,256}$/);
  exact(value.restore, [
    "receiptId",
    "completedAt",
    "restoredSizeBytes",
    "integrityCheck",
    "representativeReads",
  ]);
  match(value.restore.receiptId, /^[A-Za-z0-9._:-]{3,256}$/);
  timestamp(value.restore.completedAt);
  positive(value.restore.restoredSizeBytes);
  if (
    value.restore.integrityCheck !== "ok" ||
    !Number.isSafeInteger(value.restore.representativeReads) ||
    value.restore.representativeReads < 1 ||
    value.restore.restoredSizeBytes !== value.sourceDatabase.sizeBytes ||
    value.backup.sizeBytes <= 0
  )
    fail("RECOVERY_OPERATION_NOT_EXECUTED");
  return value;
}
function validateLegacy(value) {
  liveRoot(value, "LEGACY_FOUR_MIGRATION_UPGRADE_DRILL");
  match(value.receiptId, /^[A-Za-z0-9._:-]{3,256}$/);
  timestamp(value.completedAt);
  match(value.sourceBackupSha256, HASH);
  if (
    !Array.isArray(value.migrations) ||
    canonicalize(value.migrations) !== canonicalize(MIGRATIONS) ||
    value.integrityCheck !== "ok" ||
    !Number.isSafeInteger(value.representativeReads) ||
    value.representativeReads < 1
  )
    fail("RECOVERY_OPERATION_NOT_EXECUTED");
  return value;
}
export function createRecoveryEvidence(backupBytes, legacyBytes, context) {
  validateContext(context);
  if (!Buffer.isBuffer(backupBytes) || !Buffer.isBuffer(legacyBytes))
    fail("RECOVERY_OPERATION_NOT_EXECUTED");
  let backup;
  let legacy;
  try {
    backup = validateBackup(parseStrictJson(backupBytes.toString("utf8")));
    legacy = validateLegacy(parseStrictJson(legacyBytes.toString("utf8")));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RECOVERY_OPERATION_NOT_EXECUTED"
    )
      throw error;
    fail("RECOVERY_OPERATION_NOT_EXECUTED");
  }
  if (
    legacy.sourceBackupSha256 !== backup.backup.sha256 ||
    Date.parse(legacy.completedAt) < Date.parse(backup.restore.completedAt)
  )
    fail("RECOVERY_OPERATION_NOT_EXECUTED");
  return validateRecoveryEvidence({
    schemaVersion: 1,
    kind: "REFORMAFLOW_OCR_RECOVERY_EVIDENCE",
    repository: {
      name: context.repository,
      id: String(context.repositoryId),
      ownerId: String(context.repositoryOwnerId),
    },
    git: { commitSha: context.commitSha, treeSha: context.treeSha },
    workflow: {
      path: WORKFLOW_PATH,
      sha: context.workflowSha,
      runId: String(context.runId),
      runAttempt: context.runAttempt,
    },
    backupRestore: { receiptSha256: sha256(backupBytes), receipt: backup },
    legacyUpgrade: { receiptSha256: sha256(legacyBytes), receipt: legacy },
  });
}
export function validateRecoveryEvidence(value) {
  exact(value, [
    "schemaVersion",
    "kind",
    "repository",
    "git",
    "workflow",
    "backupRestore",
    "legacyUpgrade",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "REFORMAFLOW_OCR_RECOVERY_EVIDENCE"
  )
    fail("RECOVERY_EVIDENCE_INVALID");
  exact(value.repository, ["name", "id", "ownerId"]);
  match(value.repository.name, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  match(value.repository.id, ID);
  match(value.repository.ownerId, ID);
  exact(value.git, ["commitSha", "treeSha"]);
  match(value.git.commitSha, SHA);
  match(value.git.treeSha, SHA);
  exact(value.workflow, ["path", "sha", "runId", "runAttempt"]);
  if (value.workflow.path !== WORKFLOW_PATH || value.workflow.runAttempt !== 1)
    fail("RECOVERY_EVIDENCE_INVALID");
  match(value.workflow.sha, SHA);
  match(value.workflow.runId, ID);
  exact(value.backupRestore, ["receiptSha256", "receipt"]);
  match(value.backupRestore.receiptSha256, HASH);
  validateBackup(value.backupRestore.receipt);
  exact(value.legacyUpgrade, ["receiptSha256", "receipt"]);
  match(value.legacyUpgrade.receiptSha256, HASH);
  validateLegacy(value.legacyUpgrade.receipt);
  if (
    value.legacyUpgrade.receipt.sourceBackupSha256 !==
    value.backupRestore.receipt.backup.sha256
  )
    fail("RECOVERY_EVIDENCE_INVALID");
  return value;
}
export function verifyRecoveryArtifact(
  metadata,
  archiveBytes,
  payloadBytes,
  expected,
) {
  object(metadata, "RECOVERY_ARTIFACT_INVALID");
  exact(expected, [
    "artifactId",
    "repositoryId",
    "runId",
    "runAttempt",
    "commitSha",
    "treeSha",
    "workflowSha",
  ]);
  if (
    String(metadata.id) !== String(expected.artifactId) ||
    metadata.name !== ARTIFACT_NAME ||
    metadata.expired !== false ||
    metadata.digest !== "sha256:" + sha256(archiveBytes) ||
    String(metadata.workflow_run?.id) !== String(expected.runId) ||
    String(metadata.workflow_run?.head_repository_id) !==
      String(expected.repositoryId) ||
    metadata.workflow_run?.head_sha !== expected.commitSha ||
    Number(expected.runAttempt) !== 1
  )
    fail("RECOVERY_ARTIFACT_INVALID");
  const payload = validateRecoveryEvidence(
    parseStrictJson(payloadBytes.toString("utf8")),
  );
  if (
    payload.repository.id !== String(expected.repositoryId) ||
    payload.git.commitSha !== expected.commitSha ||
    payload.git.treeSha !== expected.treeSha ||
    payload.workflow.sha !== expected.workflowSha ||
    payload.workflow.runId !== String(expected.runId)
  )
    fail("RECOVERY_ARTIFACT_INVALID");
  return {
    schemaVersion: 1,
    artifactId: String(metadata.id),
    githubArtifactDigest: metadata.digest,
    recoveryEvidenceArtifactSha256: sha256(payloadBytes),
    payload,
  };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") {
    try {
      const backup = await readFile(resolve(args[0]));
      const legacy = await readFile(resolve(args[1]));
      const context = parseStrictJson(await readFile(resolve(args[2]), "utf8"));
      process.stdout.write(
        canonicalize(createRecoveryEvidence(backup, legacy, context)),
      );
      return;
    } catch (error) {
      if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message))
        throw error;
      fail("RECOVERY_OPERATION_NOT_EXECUTED");
    }
  }
  if (command === "verify-artifact") {
    const metadata = parseStrictJson(await readFile(resolve(args[0]), "utf8"));
    const archive = await readFile(resolve(args[1]));
    const payload = await readFile(resolve(args[2]));
    const expected = parseStrictJson(await readFile(resolve(args[3]), "utf8"));
    process.stdout.write(
      canonicalize(
        verifyRecoveryArtifact(metadata, archive, payload, expected),
      ),
    );
    return;
  }
  fail("RECOVERY_EVIDENCE_USAGE_INVALID");
}
const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  main().catch((error) => {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "RECOVERY_EVIDENCE_INVALID";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  });
