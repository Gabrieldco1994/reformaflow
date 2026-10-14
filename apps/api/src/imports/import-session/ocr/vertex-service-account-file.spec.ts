import { generateKeyPairSync } from "node:crypto";
import {
  VERTEX_SERVICE_ACCOUNT_KEY_PATH,
  VERTEX_SERVICE_ACCOUNT_STARTUP_ERROR,
  admitVertexServiceAccountFile,
  type VertexServiceAccountFileSystem,
} from "./vertex-service-account-file";

const PROJECT = "project-719";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

const validDocument = (overrides: Record<string, unknown> = {}) => ({
  type: "service_account",
  project_id: PROJECT,
  private_key_id: "a".repeat(40),
  private_key: privateKey,
  client_email: `reformaflow-ocr@${PROJECT}.iam.gserviceaccount.com`,
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url:
    "https://www.googleapis.com/robot/v1/metadata/x509/vertex-ocr",
  ...overrides,
});

function fileSystem(
  content = Buffer.from(JSON.stringify(validDocument())),
  overrides: {
    directory?: Partial<
      Awaited<ReturnType<VertexServiceAccountFileSystem["lstat"]>>
    >;
    before?: Partial<
      Awaited<ReturnType<VertexServiceAccountFileSystem["lstat"]>>
    >;
    opened?: Partial<
      Awaited<ReturnType<VertexServiceAccountFileSystem["lstat"]>>
    >;
    after?: Partial<
      Awaited<ReturnType<VertexServiceAccountFileSystem["lstat"]>>
    >;
  } = {},
): VertexServiceAccountFileSystem {
  const directory = {
    dev: 1,
    ino: 1,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    mode: 0o40500,
    size: 0,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    ...overrides.directory,
  };
  const baseFile = {
    dev: 1,
    ino: 2,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    mode: 0o100400,
    size: content.length,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const before = { ...baseFile, ...overrides.before };
  const opened = { ...baseFile, ...overrides.opened };
  const after = { ...baseFile, ...overrides.after };
  let fileStats = 0;
  return {
    lstat: jest.fn(async (path: string) => {
      if (path === "/secrets") return directory;
      fileStats++;
      return fileStats === 1 ? before : after;
    }),
    open: jest.fn(async () => ({
      stat: async () => opened,
      readFile: async () => content,
      close: async () => undefined,
    })),
  };
}

describe("Vertex service-account file admission", () => {
  it("admits the fixed root-mounted read-only file without returning secrets", async () => {
    const fs = fileSystem();
    await expect(admitVertexServiceAccountFile(PROJECT, fs)).resolves.toEqual({
      projectId: PROJECT,
      credentials: validDocument(),
    });
    expect(fs.open).toHaveBeenCalledWith(
      VERTEX_SERVICE_ACCOUNT_KEY_PATH,
      expect.any(Number),
    );
  });

  it.each([
    ["symlink directory", { directory: { isSymbolicLink: () => true } }],
    ["writable directory", { directory: { mode: 0o40770 } }],
    ["symlink file", { before: { isSymbolicLink: () => true } }],
    ["nonregular file", { opened: { isFile: () => false } }],
    ["writable file", { opened: { mode: 0o100420 } }],
    ["inode mismatch", { after: { ino: 99 } }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(
      admitVertexServiceAccountFile(PROJECT, fileSystem(undefined, overrides)),
    ).rejects.toThrow(VERTEX_SERVICE_ACCOUNT_STARTUP_ERROR);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["oversize", Buffer.alloc(64 * 1024 + 1, 0x61)],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects %s content", async (_label, content) => {
    await expect(
      admitVertexServiceAccountFile(PROJECT, fileSystem(content)),
    ).rejects.toThrow(VERTEX_SERVICE_ACCOUNT_STARTUP_ERROR);
  });

  it.each([
    ["wrong type", { type: "authorized_user" }],
    ["wrong project", { project_id: "other-project" }],
    ["wrong email", { client_email: "other@example.com" }],
    ["wrong key", { private_key: "secret-canary" }],
    ["wrong token URI", { token_uri: "https://example.com/token" }],
    ["client secret", { client_secret: "secret-canary" }],
    ["API key", { api_key: "secret-canary" }],
    ["quota project", { quota_project_id: "secret-canary" }],
  ])("rejects %s without exposing values", async (_label, override) => {
    const content = Buffer.from(JSON.stringify(validDocument(override)));
    await expect(
      admitVertexServiceAccountFile(PROJECT, fileSystem(content)),
    ).rejects.toThrow(VERTEX_SERVICE_ACCOUNT_STARTUP_ERROR);
  });
});
