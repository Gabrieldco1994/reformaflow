import { writeQualifiedLiveEvidenceExclusive } from "./capture-live-file";
import type { OcrEvalInput } from "./evaluator";

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
  throw new Error("LIVE_CAPTURE_PROTECTED_ENTRYPOINT_UNAVAILABLE");
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
