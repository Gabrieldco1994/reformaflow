import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

export const OCR_RUNTIME_EXECUTABLE_ERROR = Object.freeze({
  UNAVAILABLE: "OCR_RUNTIME_EXECUTABLE_UNAVAILABLE",
  MISMATCH: "OCR_RUNTIME_EXECUTABLE_MISMATCH",
} as const);

export interface OcrRuntimeSubjectBinding {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly imageDigest: string;
  readonly applicationEntrypointPath: string;
  readonly executableSha256: string;
  readonly runtimeSubjectArtifactSha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;

function unavailable(): never {
  throw new Error(OCR_RUNTIME_EXECUTABLE_ERROR.UNAVAILABLE);
}

/**
 * Verifies the launch target from an already signature-verified runtime
 * subject. The process launch target is not configurable through env, request,
 * or a caller-provided filesystem root.
 */
export async function verifyOcrRuntimeExecutable(
  subject: OcrRuntimeSubjectBinding,
): Promise<Readonly<{ path: string; sha256: string }>> {
  const configuredPath = subject.applicationEntrypointPath;
  const launchedPath = require.main?.filename ?? process.argv[1];
  if (
    typeof launchedPath !== "string" ||
    launchedPath.length === 0 ||
    !isAbsolute(configuredPath) ||
    normalize(configuredPath) !== configuredPath ||
    configuredPath.includes("\0") ||
    !HASH.test(subject.executableSha256)
  )
    unavailable();

  let trustedPath: string;
  let actualLaunchTarget: string;
  try {
    [trustedPath, actualLaunchTarget] = await Promise.all([
      realpath(configuredPath),
      realpath(resolve(launchedPath)),
    ]);
  } catch {
    unavailable();
  }
  if (trustedPath !== configuredPath || trustedPath !== actualLaunchTarget)
    unavailable();

  let metadata;
  try {
    metadata = await lstat(trustedPath);
  } catch {
    unavailable();
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_EXECUTABLE_BYTES
  )
    unavailable();

  const handle = await open(
    trustedPath,
    constants.O_RDONLY |
      // O_NOFOLLOW is not present on every Node platform.
      (constants.O_NOFOLLOW ?? 0),
  ).catch(() => unavailable());
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== metadata.size ||
      before.size <= 0 ||
      before.size > MAX_EXECUTABLE_BYTES
    )
      unavailable();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    )
      unavailable();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== subject.executableSha256)
      throw new Error(OCR_RUNTIME_EXECUTABLE_ERROR.MISMATCH);
    return Object.freeze({ path: trustedPath, sha256 });
  } finally {
    await handle.close();
  }
}
