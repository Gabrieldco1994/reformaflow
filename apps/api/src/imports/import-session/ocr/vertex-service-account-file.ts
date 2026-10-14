import { createPrivateKey } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";

export const VERTEX_SERVICE_ACCOUNT_KEY_PATH = "/secrets/vertex-sa.json";
export const VERTEX_SERVICE_ACCOUNT_STARTUP_ERROR =
  "VERTEX_SERVICE_ACCOUNT_FILE_INVALID";

const VERTEX_SECRETS_DIRECTORY = "/secrets";
const MAX_KEY_FILE_BYTES = 64 * 1024;
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REQUIRED_KEYS = [
  "type",
  "project_id",
  "private_key_id",
  "private_key",
  "client_email",
  "client_id",
  "auth_uri",
  "token_uri",
  "auth_provider_x509_cert_url",
  "client_x509_cert_url",
] as const;

type FileStats = Pick<Stats, "dev" | "ino" | "mode" | "size"> &
  Partial<Pick<Stats, "uid">> &
  Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">;

export interface VertexServiceAccountFileSystem {
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

export interface AdmittedVertexServiceAccount {
  readonly projectId: string;
  readonly credentials: Readonly<{
    type: "service_account";
    project_id: string;
    private_key_id: string;
    private_key: string;
    client_email: string;
    client_id: string;
    auth_uri: string;
    token_uri: string;
    auth_provider_x509_cert_url: string;
    client_x509_cert_url: string;
  }>;
}

const nodeFileSystem: VertexServiceAccountFileSystem = {
  lstat: (path) => fs.lstat(path),
  open: (path, flags) => fs.open(path, flags),
};

function fail(): never {
  throw new Error(VERTEX_SERVICE_ACCOUNT_STARTUP_ERROR);
}

function isProtected(mode: number): boolean {
  return (mode & 0o022) === 0;
}

function isOwnerOnlyFile(stats: FileStats): boolean {
  const processUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  return (
    (stats.mode & 0o077) === 0 &&
    (processUid === null || stats.uid === undefined || stats.uid === processUid)
  );
}

function sameFile(left: FileStats, right: FileStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function validateDocument(
  value: unknown,
  projectId: string,
): AdmittedVertexServiceAccount {
  if (!isPlainObject(value)) fail();
  const keys = Object.keys(value);
  if (
    keys.length !== REQUIRED_KEYS.length ||
    REQUIRED_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    fail();
  }

  if (
    value.type !== "service_account" ||
    value.project_id !== projectId ||
    !GOOGLE_PROJECT_ID.test(projectId) ||
    value.token_uri !== GOOGLE_TOKEN_URI ||
    !isBoundedString(value.private_key_id, 1, 256) ||
    !/^[\x21-\x7e]+$/.test(value.private_key_id) ||
    !isBoundedString(value.private_key, 1, MAX_KEY_FILE_BYTES) ||
    !isBoundedString(value.client_email, 1, 320) ||
    !isBoundedString(value.client_id, 1, 64) ||
    !/^\d+$/.test(value.client_id) ||
    !isBoundedString(value.auth_uri, 1, 2048) ||
    !isBoundedString(value.auth_provider_x509_cert_url, 1, 2048) ||
    !isBoundedString(value.client_x509_cert_url, 1, 2048)
  ) {
    fail();
  }

  const expectedEmail = `reformaflow-ocr@${projectId}.iam.gserviceaccount.com`;
  if (value.client_email !== expectedEmail) {
    fail();
  }

  try {
    const key = createPrivateKey(value.private_key);
    if (key.type !== "private" || key.asymmetricKeyType !== "rsa") fail();
  } catch {
    return fail();
  }

  return Object.freeze({
    projectId,
    credentials: Object.freeze({
      type: "service_account" as const,
      project_id: projectId,
      private_key_id: value.private_key_id,
      private_key: value.private_key,
      client_email: expectedEmail,
      client_id: value.client_id,
      auth_uri: value.auth_uri,
      token_uri: GOOGLE_TOKEN_URI,
      auth_provider_x509_cert_url: value.auth_provider_x509_cert_url,
      client_x509_cert_url: value.client_x509_cert_url,
    }),
  });
}

/**
 * Admits only the fixed, protected service-account file. Errors are intentionally
 * collapsed to one code so credential values and parser details never escape.
 */
export async function admitVertexServiceAccountFile(
  projectId: string,
  fileSystem: VertexServiceAccountFileSystem = nodeFileSystem,
): Promise<AdmittedVertexServiceAccount> {
  let handle: Awaited<
    ReturnType<VertexServiceAccountFileSystem["open"]>
  > | null = null;
  try {
    const directory = await fileSystem.lstat(VERTEX_SECRETS_DIRECTORY);
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      !isProtected(directory.mode)
    ) {
      fail();
    }

    const before = await fileSystem.lstat(VERTEX_SERVICE_ACCOUNT_KEY_PATH);
    if (before.isSymbolicLink() || !before.isFile()) fail();

    handle = await fileSystem.open(
      VERTEX_SERVICE_ACCOUNT_KEY_PATH,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      !isOwnerOnlyFile(opened) ||
      opened.size <= 0 ||
      opened.size > MAX_KEY_FILE_BYTES ||
      !sameFile(before, opened)
    ) {
      fail();
    }

    const bytes = await handle.readFile();
    if (bytes.length <= 0 || bytes.length > MAX_KEY_FILE_BYTES) fail();
    const after = await fileSystem.lstat(VERTEX_SERVICE_ACCOUNT_KEY_PATH);
    if (!sameFile(opened, after)) fail();

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const admitted = validateDocument(JSON.parse(text) as unknown, projectId);
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
        // Never expose filesystem details while collapsing admission failures.
      }
    }
  }
}
