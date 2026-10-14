import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERTEX_AUTHORIZED_USER_STARTUP_ERROR =
  "VERTEX_AUTHORIZED_USER_FILE_INVALID";
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const AUTHORIZED_USER_KEYS = [
  "type",
  "client_id",
  "client_secret",
  "refresh_token",
] as const;

type FileStats = Pick<Stats, "dev" | "ino" | "mode" | "size" | "uid"> &
  Pick<Stats, "isFile" | "isSymbolicLink">;

export interface VertexAuthorizedUserFileSystem {
  lstat(path: string): Promise<FileStats>;
  open(
    path: string,
    flags: number,
  ): Promise<{
    stat(): Promise<FileStats>;
    readFile(): Promise<Buffer>;
    close(): Promise<void>;
  }>;
}

export interface AdmittedVertexAuthorizedUser {
  readonly credentials: Readonly<{
    type: "authorized_user";
    client_id: string;
    client_secret: string;
    refresh_token: string;
  }>;
}

const nodeFileSystem: VertexAuthorizedUserFileSystem = {
  lstat: (path) => fs.lstat(path),
  open: (path, flags) => fs.open(path, flags),
};

const fail = (): never => {
  throw new Error(VERTEX_AUTHORIZED_USER_STARTUP_ERROR);
};
const sameFile = (left: FileStats, right: FileStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const normalized = (value: unknown): string => {
  if (typeof value !== "string") return fail();
  const result = value.trim();
  if (
    result.length === 0 ||
    result.length > MAX_CREDENTIAL_FILE_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/.test(result)
  )
    return fail();
  return result;
};
const ownerOnly = (stats: FileStats): boolean => {
  const processUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  return (
    (stats.mode & 0o077) === 0 &&
    (processUid === null || stats.uid === processUid)
  );
};

/**
 * Loads only gcloud's deterministic local ADC file into memory. The caller
 * passes the admitted object to GoogleAuth, so no ambient path probing occurs.
 */
export async function admitVertexAuthorizedUserFile(
  fileSystem: VertexAuthorizedUserFileSystem = nodeFileSystem,
  homeDirectory: string = homedir(),
): Promise<AdmittedVertexAuthorizedUser> {
  const path = join(
    homeDirectory,
    ".config",
    "gcloud",
    "application_default_credentials.json",
  );
  let handle: Awaited<
    ReturnType<VertexAuthorizedUserFileSystem["open"]>
  > | null = null;
  try {
    const before = await fileSystem.lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) fail();
    handle = await fileSystem.open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      !ownerOnly(opened) ||
      opened.size <= 0 ||
      opened.size > MAX_CREDENTIAL_FILE_BYTES ||
      !sameFile(before, opened)
    )
      fail();
    const bytes = await handle.readFile();
    if (bytes.length <= 0 || bytes.length > MAX_CREDENTIAL_FILE_BYTES) fail();
    const after = await fileSystem.lstat(path);
    if (!sameFile(opened, after)) fail();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !plainRecord(value) ||
      Reflect.ownKeys(value).length !== AUTHORIZED_USER_KEYS.length ||
      AUTHORIZED_USER_KEYS.some(
        (key) => !Object.prototype.hasOwnProperty.call(value, key),
      ) ||
      value.type !== "authorized_user"
    )
      fail();
    const document = value as Record<string, unknown>;
    const admitted = Object.freeze({
      credentials: Object.freeze({
        type: "authorized_user" as const,
        client_id: normalized(document.client_id),
        client_secret: normalized(document.client_secret),
        refresh_token: normalized(document.refresh_token),
      }),
    });
    await handle.close();
    handle = null;
    return admitted;
  } catch {
    return fail();
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Admission failures intentionally collapse filesystem diagnostics.
      }
    }
  }
}
