import { writeQualifiedLiveEvidenceExclusive } from "./capture-live-file";
import type { OcrEvalInput } from "./evaluator";
import { VertexPdfOcrProvider } from "../import-session/ocr/vertex-pdf-ocr.provider";
import { captureLiveEvidence } from "./capture-live-core";
import {
  assertQualityFilesSnapshot,
  attestQualityClosureFromSnapshot,
} from "./quality-closure-attestation";
import type { FinalReviewHashes } from "./quality-closure-attestation";
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

export interface ProtectedWifLiveCaptureDependencies {
  readonly authMode: "GITHUB_OIDC_WIF";
  readonly projectId: string;
  readonly accessToken: string;
  readonly snapshot: OcrRepositorySnapshot;
  readonly finalReviewHashes: FinalReviewHashes;
}

const WIF_OUTPUT_PATH = "/run/ocr/raw-evidence.json";
const WIF_LOCK_PATH = "/run/ocr/live-capture.lock";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const failClosed = (code: string): never => {
  throw new Error(code);
};

/**
 * Executes capture only when the protected caller supplies the credential
 * binding and all side-effecting dependencies explicitly.
 */
export async function runProtectedLiveCapture(
  input: unknown,
): Promise<OcrEvalInput> {
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

  let captured: OcrEvalInput | undefined;
  await writeQualifiedLiveEvidenceExclusive(
    input.outputPath,
    input.lockPath,
    async () => {
      captured = await (input.captureEvidence as () => Promise<OcrEvalInput>)();
      return captured;
    },
    input.verifyRepository as () => Promise<void>,
  );
  if (!captured) return failClosed(PROTECTED_DEPENDENCIES_MISSING);
  return captured;
}

/**
 * Existing WIF adapter seam. Only this boundary can construct the module-local
 * context consumed by the generic runner; direct/local callers remain blocked.
 */
export async function runProtectedWifLiveCapture(
  input: ProtectedWifLiveCaptureDependencies,
): Promise<OcrEvalInput> {
  if (
    !object(input) ||
    input.authMode !== "GITHUB_OIDC_WIF" ||
    typeof input.projectId !== "string" ||
    input.projectId.length === 0 ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length < 20 ||
    !object(input.snapshot) ||
    !object(input.finalReviewHashes)
  )
    return failClosed(CREDENTIALS_MISSING);
  const snapshot = input.snapshot as unknown as OcrRepositorySnapshot;
  const finalReviewHashes =
    input.finalReviewHashes as unknown as FinalReviewHashes;
  const attestation = await attestQualityClosureFromSnapshot(snapshot);
  const verifyRepository = async () =>
    assertQualityFilesSnapshot(snapshot, attestation.policy);
  const provider = new VertexPdfOcrProvider(input.projectId, {
    authTrace: "GITHUB_OIDC_WIF",
    accessToken: async () => input.accessToken,
  });
  return runProtectedLiveCapture({
    outputPath: WIF_OUTPUT_PATH,
    lockPath: WIF_LOCK_PATH,
    credentials: {
      projectId: input.projectId,
      serviceAccountPath: "GITHUB_OIDC_WIF_INHERITED_TOKEN",
      [PROTECTED_CONTEXT]: true,
    },
    captureEvidence: () =>
      captureLiveEvidence({
        provider,
        mechanical: {
          policy: attestation.policy,
          qualityClosure: attestation.closure,
          finalReviewHashes,
          verifySnapshot: verifyRepository,
        },
      }),
    verifyRepository,
  });
}

async function main(): Promise<void> {
  throw new Error("LIVE_CAPTURE_PROTECTED_ENTRYPOINT_UNAVAILABLE");
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error &&
      /^(?:LIVE_CAPTURE|QUALITY)_[A-Z_]+$/.test(error.message)
        ? error.message
        : "LIVE_CAPTURE_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
