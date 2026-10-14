import { constants as fsConstants } from "node:fs";
import {
  VERTEX_LOCAL_ADC_STARTUP_ERROR,
  admitVertexLocalAdcFile,
  vertexLocalAdcPath,
} from "./vertex-local-adc-file";

type Stats = {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type LocalFileSystem = {
  lstat(path: string): Promise<Stats>;
  open(
    path: string,
    flags: number,
  ): Promise<{
    stat(): Promise<Stats>;
    readFile(): Promise<Buffer>;
    close(): Promise<void>;
  }>;
};

const document = (overrides: Record<string, unknown> = {}) => ({
  type: "authorized_user",
  client_id: "719-local.apps.googleusercontent.com",
  client_secret: "client-secret-canary-719",
  refresh_token: "refresh-token-canary-719",
  ...overrides,
});

function fileSystem(
  content = Buffer.from(JSON.stringify(document())),
  overrides: {
    directory?: Partial<Stats>;
    before?: Partial<Stats>;
    opened?: Partial<Stats>;
    after?: Partial<Stats>;
  } = {},
): LocalFileSystem {
  const directory: Stats = {
    dev: 7,
    ino: 10,
    mode: 0o40700,
    size: 0,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    ...overrides.directory,
  };
  const regular: Stats = {
    dev: 7,
    ino: 11,
    mode: 0o100600,
    size: content.length,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const before = { ...regular, ...overrides.before };
  const opened = { ...regular, ...overrides.opened };
  const after = { ...regular, ...overrides.after };
  let fileStats = 0;
  return {
    lstat: jest.fn(async (path: string) => {
      if (path.endsWith("/.config/gcloud")) return directory;
      fileStats += 1;
      return fileStats === 1 ? before : after;
    }),
    open: jest.fn(async () => ({
      stat: async () => opened,
      readFile: async () => content,
      close: async () => undefined,
    })),
  };
}

describe("Vertex local ADC file admission", () => {
  it("provides the dedicated local ADC loader", () => {
    expect({
      VERTEX_LOCAL_ADC_STARTUP_ERROR,
      admitVertexLocalAdcFile,
      vertexLocalAdcPath,
    }).toEqual({
      VERTEX_LOCAL_ADC_STARTUP_ERROR: "VERTEX_LOCAL_ADC_FILE_INVALID",
      admitVertexLocalAdcFile: expect.any(Function),
      vertexLocalAdcPath: expect.any(Function),
    });
  });

  it.each(["darwin", "linux"] as const)(
    "uses the deterministic %s well-known ADC path and returns only in-memory credentials",
    async (platform) => {
      const fs = fileSystem();
      const home = "/Users/reformaflow";
      const path =
        "/Users/reformaflow/.config/gcloud/application_default_credentials.json";

      expect(vertexLocalAdcPath(platform, home)).toBe(path);
      const admitted = await admitVertexLocalAdcFile({
        platform,
        homeDirectory: home,
        fileSystem: fs,
      });

      expect(admitted).toEqual({ credentials: document() });
      expect(admitted).not.toHaveProperty("keyFilename");
      expect(admitted).not.toHaveProperty("path");
      expect(fs.open).toHaveBeenCalledWith(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      expect(fs.open).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["symlink directory", { directory: { isSymbolicLink: () => true } }],
    ["writable directory", { directory: { mode: 0o40720 } }],
    ["symlink file", { before: { isSymbolicLink: () => true } }],
    ["nonregular file", { opened: { isFile: () => false } }],
    ["group-readable file", { opened: { mode: 0o100640 } }],
    ["inode swap before open", { opened: { ino: 12 } }],
    ["inode swap after read", { after: { ino: 12 } }],
  ])("rejects %s", async (_label, overrides) => {
    await expect(
      admitVertexLocalAdcFile({
        platform: "linux",
        homeDirectory: "/home/reformaflow",
        fileSystem: fileSystem(undefined, overrides),
      }),
    ).rejects.toThrow("VERTEX_LOCAL_ADC_FILE_INVALID");
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["oversize", Buffer.alloc(64 * 1024 + 1, 0x61)],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["invalid JSON", Buffer.from('{"type":')],
  ])("rejects %s content with one redacted error", async (_label, content) => {
    const failure = await admitVertexLocalAdcFile({
      platform: "darwin",
      homeDirectory: "/Users/reformaflow",
      fileSystem: fileSystem(content),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("VERTEX_LOCAL_ADC_FILE_INVALID");
    expect((failure as Error).message).not.toContain("canary");
  });

  it.each([
    ["service account", { type: "service_account" }],
    ["missing client id", { client_id: undefined }],
    ["missing client secret", { client_secret: undefined }],
    ["missing refresh token", { refresh_token: undefined }],
    ["quota project", { quota_project_id: "quota-canary-719" }],
    ["token URI override", { token_uri: "https://evil.example/token" }],
    ["universe domain", { universe_domain: "evil.example" }],
    ["API key", { api_key: "api-key-canary-719" }],
  ])(
    "rejects %s without leaking credential values",
    async (_label, override) => {
      const content = Buffer.from(JSON.stringify(document(override)));
      const failure = await admitVertexLocalAdcFile({
        platform: "linux",
        homeDirectory: "/home/reformaflow",
        fileSystem: fileSystem(content),
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("VERTEX_LOCAL_ADC_FILE_INVALID");
      expect((failure as Error).message).not.toContain("canary");
      expect((failure as Error).message).not.toContain(
        String(Object.values(override)[0]),
      );
    },
  );
});
