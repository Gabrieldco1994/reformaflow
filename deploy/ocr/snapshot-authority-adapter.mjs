#!/usr/bin/env node
import { canonicalize } from "../../scripts/ci/ocr-attestation.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const defaultDependencies = Object.freeze({
  load: () =>
    import("../../apps/api/dist/imports/ocr-synth-v1/quality-closure-attestation.js"),
});

export async function materializeSnapshotAuthority(
  environment = process.env,
  dependencies = {},
) {
  const runtime = { ...defaultDependencies, ...dependencies };
  const subjectSha = environment.OCR_SUBJECT_SHA ?? "";
  const subjectTree = environment.OCR_SUBJECT_TREE ?? "";
  const qualificationImageDigest =
    environment.OCR_QUALIFICATION_IMAGE_DIGEST ?? "";
  const executableDigest = environment.OCR_EXECUTABLE_DIGEST ?? "";
  if (
    !COMMIT.test(subjectSha) ||
    !COMMIT.test(subjectTree) ||
    !DIGEST.test(qualificationImageDigest) ||
    !DIGEST.test(executableDigest)
  )
    throw new Error("SNAPSHOT_AUTHORITY_INVALID");
  const module = await runtime.load();
  const policy = await module.loadQualityClosurePolicy();
  const snapshot = await module.snapshotQualityFiles(policy, {
    headSha: subjectSha,
    treeSha: subjectTree,
  });
  if (!HASH.test(snapshot.policySha256) || !HASH.test(snapshot.corpusSha256))
    throw new Error("SNAPSHOT_AUTHORITY_INVALID");
  return Object.freeze({
    schemaVersion: 1,
    subjectSha,
    subjectTree,
    qualificationImageDigest,
    executableDigest,
    policySha256: snapshot.policySha256,
    corpusSha256: snapshot.corpusSha256,
    snapshot,
  });
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
  void materializeSnapshotAuthority()
    .then((authority) => process.stdout.write(`${canonicalize(authority)}\n`))
    .catch(() => {
      process.stderr.write("SNAPSHOT_AUTHORITY_INVALID\n");
      process.exitCode = 1;
    });
