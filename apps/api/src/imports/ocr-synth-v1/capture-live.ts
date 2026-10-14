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
import type { OcrEvalInput } from "./evaluator";
import type { OcrRepositorySnapshot } from "./types";

const PROTECTED_DEPENDENCIES_MISSING =
  "LIVE_CAPTURE_PROTECTED_DEPENDENCIES_MISSING";
const CREDENTIALS_MISSING = "LIVE_CAPTURE_CREDENTIALS_MISSING";
const PROTECTED_CONTEXT_UNAVAILABLE =
  "LIVE_CAPTURE_PROTECTED_CONTEXT_UNAVAILABLE";
const PROTECTED_CONTEXT = Symbol("live-capture-protected-context");

export interface ProtectedLiveCaptureDependencies {
  readonly outputPath: string;
  readonly lockPath: string;
  readonly credentials: {
    readonly projectId: string;
    readonly serviceAccountPath: string;
    readonly [PROTECTED_CONTEXT]?: true;
  };
  readonly captureEvidence: () => Promise<OcrEvalInput>;
  readonly verifyRepository: () => Promise<void>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const failClosed = (code: string): never => {
  throw new Error(code);
};

/**
 * Executes capture only when the protected caller supplies the credential
 * binding and all side-effecting dependencies explicitly.
 */
export async function runProtectedLiveCapture(input: unknown): Promise<void> {
  if (!object(input)) throw new Error(PROTECTED_DEPENDENCIES_MISSING);
  const credentials = input.credentials;
  if (
    !object(credentials) ||
    typeof credentials.projectId !== "string" ||
    credentials.projectId.length === 0 ||
    typeof credentials.serviceAccountPath !== "string" ||
    credentials.serviceAccountPath.length === 0
  ) {
    return failClosed(CREDENTIALS_MISSING);
  }
  if ((credentials as Record<PropertyKey, unknown>)[PROTECTED_CONTEXT] !== true)
    return failClosed(PROTECTED_CONTEXT_UNAVAILABLE);
  if (
    typeof input.outputPath !== "string" ||
    input.outputPath.length === 0 ||
    typeof input.lockPath !== "string" ||
    input.lockPath.length === 0 ||
    typeof input.captureEvidence !== "function" ||
    typeof input.verifyRepository !== "function"
  ) {
    return failClosed(PROTECTED_DEPENDENCIES_MISSING);
  }

  await writeQualifiedLiveEvidenceExclusive(
    input.outputPath,
    input.lockPath,
    input.captureEvidence as () => Promise<OcrEvalInput>,
    input.verifyRepository as () => Promise<void>,
  );
}

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

  const attestation = await attestQualityClosure();
  policy = attestation.policy;
  snapshot = attestation.closure.snapshot;
  await readFinalReviewHashes(policy);
  await verifyRepository();
  await runProtectedLiveCapture({
    outputPath,
    lockPath,
    credentials: {},
    captureEvidence: async () => {
      throw new Error(PROTECTED_DEPENDENCIES_MISSING);
    },
    verifyRepository,
  });
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
