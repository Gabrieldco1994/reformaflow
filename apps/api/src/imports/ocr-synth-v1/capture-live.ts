import { resolve } from "node:path";
import { captureLiveEvidence } from "./capture-live-core";
import { writeQualifiedLiveEvidenceExclusive } from "./capture-live-file";
import { createConfiguredVertexPdfOcrProvider } from "../import-session/ocr/vertex-provider.factory";
import { VertexPdfOcrProvider } from "../import-session/ocr/vertex-pdf-ocr.provider";
import {
  assertOutputOutsideRepository,
  assertQualityRepositorySnapshot,
  attestQualityClosure,
  qualityCaptureLockPath,
  readFinalReviewHashes,
  type QualityClosurePolicy,
} from "./quality-closure-attestation";
import type { OcrRepositorySnapshot } from "./types";

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || !arguments_[0])
    throw new Error("LIVE_CAPTURE_OUTPUT_MISSING");
  const outputPath = resolve(process.cwd(), arguments_[0]);
  await assertOutputOutsideRepository(outputPath);
  const lockPath = await qualityCaptureLockPath();
  let policy: QualityClosurePolicy | undefined;
  let snapshot: OcrRepositorySnapshot | undefined;
  const verifyRepository = async (): Promise<void> => {
    if (!policy || !snapshot)
      throw new Error("LIVE_CAPTURE_ATTESTATION_MISSING");
    await assertQualityRepositorySnapshot(snapshot, policy);
  };

  await writeQualifiedLiveEvidenceExclusive(
    outputPath,
    lockPath,
    async () => {
      const attestation = await attestQualityClosure();
      policy = attestation.policy;
      snapshot = attestation.closure.snapshot;
      const finalReviewHashes = await readFinalReviewHashes(policy);
      await verifyRepository();
      const provider = await createConfiguredVertexPdfOcrProvider(process.env);
      if (!(provider instanceof VertexPdfOcrProvider) || !provider.ready())
        throw new Error("LIVE_CAPTURE_CONFIG_MISSING");
      return await captureLiveEvidence({
        provider,
        mechanical: {
          policy,
          qualityClosure: attestation.closure,
          finalReviewHashes,
          verifySnapshot: verifyRepository,
        },
      });
    },
    verifyRepository,
  );
}

void main().catch((error: unknown) => {
  const code =
    error instanceof Error &&
    /^(?:LIVE_CAPTURE|QUALITY)_[A-Z_]+$/.test(error.message)
      ? error.message
      : "LIVE_CAPTURE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
