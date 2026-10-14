import { resolve } from "node:path";
import { writeQualifiedLiveEvidenceExclusive } from "./capture-live-file";
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
      await readFinalReviewHashes(policy);
      await verifyRepository();
      // The fixed in-process 45-scenario executor is intentionally required
      // before any provider construction. Until QA supplies that executable
      // harness, capture remains fail-closed instead of accepting claim JSON.
      throw new Error("LIVE_CAPTURE_BOUNDARY_RUNNER_UNAVAILABLE");
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
