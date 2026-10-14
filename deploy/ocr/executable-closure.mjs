#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalize, sha256 } from "../../scripts/ci/ocr-attestation.mjs";

const FILES = [
  "deploy/ocr/Dockerfile",
  "deploy/ocr/executable-closure.mjs",
  "deploy/ocr/artifact-digest.mjs",
  "deploy/ocr/build-unsigned-attestation.mjs",
  "deploy/ocr/evidence-bundle.mjs",
  "deploy/ocr/github-approval-evidence.mjs",
  "deploy/ocr/kms-curl-config.mjs",
  "deploy/ocr/offline-report-adapter.mjs",
  "deploy/ocr/wif-adapter.mjs",
  "deploy/ocr/workflow-payload-template.mjs",
  "deploy/ocr/qualification-entrypoint.mjs",
  "deploy/ocr/verify-reviews.mjs",
  "deploy/ocr/oci-layout.mjs",
  "deploy/ocr/infra-policy.json",
  "deploy/ocr/required-reviews.json",
  "deploy/ocr/review.schema.json",
  "apps/api/src/imports/import-session/ocr/ocr-release-trust.json",
  "apps/api/src/imports/ocr-synth-v1/capture-live.ts",
  "apps/api/src/imports/ocr-synth-v1/capture-live-file.ts",
  "apps/api/src/imports/ocr-synth-v1/capture-live-core.ts",
  "apps/api/src/imports/ocr-synth-v1/corpus.ts",
  "apps/api/src/imports/ocr-synth-v1/offline-report.ts",
  "apps/api/src/imports/ocr-synth-v1/evaluator.ts",
  "apps/api/src/imports/ocr-synth-v1/fixture-generator.ts",
  "apps/api/src/imports/ocr-synth-v1/live-evidence-parser.ts",
  "apps/api/src/imports/ocr-synth-v1/provider-native-outcome.ts",
  "apps/api/src/imports/ocr-synth-v1/quality-closure-attestation.ts",
  "apps/api/src/imports/ocr-synth-v1/quality-closure-policy.json",
  "apps/api/src/imports/ocr-synth-v1/types.ts",
  "apps/api/src/imports/ocr-synth-v1/ground-truth.json",
  "apps/api/src/imports/ocr-synth-v1/report.schema.json",
  "apps/api/src/imports/import-session/ocr/ocr-release-envelope.ts",
  "apps/api/src/imports/import-session/ocr/pdf-ocr-parser.ts",
  "apps/api/src/imports/import-session/ocr/pdf-ocr.ports.ts",
  "apps/api/src/imports/import-session/ocr/strict-json.ts",
  "apps/api/src/imports/import-session/ocr/vertex-pdf-ocr.provider.ts",
  "packages/domain/src/import-ocr.ts",
  "packages/domain/src/index.ts",
  "deploy/ocr/external-producer-contracts.json",
  "deploy/ocr/external-producer-gate.mjs",
  "scripts/ci/ocr-attestation.mjs",
  "scripts/ci/ocr-runtime-subject.mjs",
  "scripts/ci/ocr-recovery-evidence.mjs",
];

export async function executableClosure(root) {
  const hash = createHash("sha256");
  const files = [];
  for (const path of [...FILES].sort()) {
    const bytes = await readFile(resolve(root, path));
    const digest = sha256(bytes);
    files.push({ path, sha256: digest, size: bytes.length });
    hash.update(path);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return { digest: `sha256:${hash.digest("hex")}`, files };
}

executableClosure(resolve(process.argv[2] ?? "."))
  .then((value) => process.stdout.write(`${canonicalize(value)}\n`))
  .catch(() => {
    process.stderr.write("EXECUTABLE_CLOSURE_INVALID\n");
    process.exitCode = 1;
  });
