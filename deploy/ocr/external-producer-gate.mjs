#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseStrictJson } from "../../scripts/ci/ocr-attestation.mjs";
function fail(code = "EXTERNAL_PRODUCER_CONTRACT_INVALID") {
  throw new Error(code);
}
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    fail();
}
try {
  const path = resolve(
    process.argv[2] ?? "deploy/ocr/external-producer-contracts.json",
  );
  const value = parseStrictJson(await readFile(path, "utf8"));
  exact(value, [
    "schemaVersion",
    "status",
    "runtimeSubjectContract",
    "recoveryEvidenceContract",
  ]);
  exact(value.runtimeSubjectContract, [
    "workflowPath",
    "artifactName",
    "payloadPath",
    "schemaVersion",
  ]);
  exact(value.recoveryEvidenceContract, [
    "workflowPath",
    "artifactName",
    "payloadPath",
    "schemaVersion",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.status !== "READY" ||
    value.runtimeSubjectContract.workflowPath !==
      ".github/workflows/ocr-runtime-subject.yml" ||
    value.runtimeSubjectContract.artifactName !== "ocr-runtime-subject-v1" ||
    value.runtimeSubjectContract.payloadPath !== "runtime-subject.json" ||
    value.runtimeSubjectContract.schemaVersion !== 1 ||
    value.recoveryEvidenceContract.workflowPath !==
      ".github/workflows/ocr-recovery-evidence.yml" ||
    value.recoveryEvidenceContract.artifactName !==
      "ocr-recovery-evidence-v1" ||
    value.recoveryEvidenceContract.payloadPath !== "recovery-evidence.json" ||
    value.recoveryEvidenceContract.schemaVersion !== 1
  )
    fail();
  process.stdout.write("EXTERNAL_PRODUCER_CONTRACTS_READY\n");
} catch (error) {
  process.stderr.write(
    (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "EXTERNAL_PRODUCER_CONTRACT_INVALID") + "\n",
  );
  process.exitCode = 1;
}
