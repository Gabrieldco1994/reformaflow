import { dirname, isAbsolute, join } from "path";

export interface UploadsRoots {
  publicDir: string;
  privateDir: string;
}

const DEFAULT_PUBLIC_DIRNAME = "uploads";
const PRIVATE_SIBLING_DIRNAME = "private-uploads";

function anchor(raw: string, cwd: string): string {
  return isAbsolute(raw) ? raw : join(cwd, raw);
}

/**
 * Pure: reads only the arguments, so each consumer decides WHEN to evaluate.
 * An explicit PRIVATE_UPLOADS_DIR is not checked against the public root.
 */
export function resolveUploadsRoots(
  env: NodeJS.ProcessEnv,
  cwd: string,
): UploadsRoots {
  const publicRaw = env["UPLOADS_DIR"];
  const publicDir = publicRaw
    ? anchor(publicRaw, cwd)
    : join(cwd, DEFAULT_PUBLIC_DIRNAME);
  const privateRaw = env["PRIVATE_UPLOADS_DIR"];
  const privateDir = privateRaw
    ? anchor(privateRaw, cwd)
    : join(dirname(publicDir), PRIVATE_SIBLING_DIRNAME);
  return { publicDir, privateDir };
}
