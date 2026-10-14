import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const VERTEX_LOCAL_ADC_STARTUP_ERROR = "VERTEX_LOCAL_ADC_FILE_INVALID";
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const GCLOUD_DIRECTORY_PARTS = [".config", "gcloud"] as const;
const ADC_FILE_NAME = "application_default_credentials.json";
const AUTHORIZED_USER_KEYS = [
  "type",
  "client_id",
  "client_secret",
  "refresh_token",
] as const;
const AUTHORIZED_USER_OPTIONAL_KEYS = [
  "quota_project_id",
  "universe_domain",
  "account",
] as const;
const AUTHORIZED_USER_KEY_ALLOWLIST = new Set<string>([
  ...AUTHORIZED_USER_KEYS,
  ...AUTHORIZED_USER_OPTIONAL_KEYS,
]);
const GOOGLE_UNIVERSE_DOMAIN = "googleapis.com";
const GOOGLE_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const MAX_GOOGLE_PROJECT_ID_LENGTH = 30;
const MAX_ACCOUNT_LENGTH = 320;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

type FileStats = Pick<Stats, "dev" | "ino" | "mode" | "size"> &
  Partial<Pick<Stats, "uid">> &
  Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">;

export interface VertexLocalAdcFileSystem {
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

export interface AdmittedVertexLocalAdc {
  readonly credentials: Readonly<{
    type: "authorized_user";
    client_id: string;
    client_secret: string;
    refresh_token: string;
  }>;
}

const nodeFileSystem: VertexLocalAdcFileSystem = {
  lstat: (path) => fs.lstat(path),
  open: (path, flags) => fs.open(path, flags),
};

const fail = (): never => {
  throw new Error(VERTEX_LOCAL_ADC_STARTUP_ERROR);
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
    CONTROL_CHARACTERS.test(result)
  )
    return fail();
  return result;
};
const exactText = (value: unknown, maxLength: number): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    CONTROL_CHARACTERS.test(value)
  )
    return fail();
  return value;
};
const ownerOnly = (stats: FileStats): boolean => {
  const processUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  return (
    (stats.mode & 0o077) === 0 &&
    (processUid === null || stats.uid === undefined || stats.uid === processUid)
  );
};
const protectedDirectory = (stats: FileStats): boolean =>
  !stats.isSymbolicLink() && stats.isDirectory() && (stats.mode & 0o022) === 0;

export function vertexLocalAdcPath(
  _platform: "darwin" | "linux",
  homeDirectory: string,
): string {
  return join(homeDirectory, ...GCLOUD_DIRECTORY_PARTS, ADC_FILE_NAME);
}

/**
 * Loads only gcloud's deterministic local ADC file into memory. The caller
 * passes the admitted object to GoogleAuth, so no ambient path probing occurs.
 */
export async function admitVertexLocalAdcFile(
  input: Readonly<{
    platform: "darwin" | "linux";
    homeDirectory: string;
    fileSystem: VertexLocalAdcFileSystem;
  }> = {
    platform: platform() as "darwin" | "linux",
    homeDirectory: homedir(),
    fileSystem: nodeFileSystem,
  },
): Promise<AdmittedVertexLocalAdc> {
  const { fileSystem, homeDirectory } = input;
  const directory = join(homeDirectory, ...GCLOUD_DIRECTORY_PARTS);
  const path = vertexLocalAdcPath(input.platform, homeDirectory);
  let handle: Awaited<ReturnType<VertexLocalAdcFileSystem["open"]>> | null =
    null;
  try {
    const directoryStats = await fileSystem.lstat(directory);
    if (!protectedDirectory(directoryStats)) fail();
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
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== "string" || !AUTHORIZED_USER_KEY_ALLOWLIST.has(key),
      ) ||
      AUTHORIZED_USER_KEYS.some(
        (key) => !Object.prototype.hasOwnProperty.call(value, key),
      ) ||
      value.type !== "authorized_user"
    )
      fail();
    const document = value as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(document, "universe_domain") &&
      document.universe_domain !== GOOGLE_UNIVERSE_DOMAIN
    )
      fail();
    if (Object.prototype.hasOwnProperty.call(document, "quota_project_id")) {
      const quotaProjectId = exactText(
        document.quota_project_id,
        MAX_GOOGLE_PROJECT_ID_LENGTH,
      );
      if (!GOOGLE_PROJECT_ID.test(quotaProjectId)) fail();
    }
    if (Object.prototype.hasOwnProperty.call(document, "account"))
      exactText(document.account, MAX_ACCOUNT_LENGTH);
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
