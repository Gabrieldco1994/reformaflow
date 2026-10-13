import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  buildLinuxSandboxSpawn,
  PDF_RASTER_SANDBOX_LIMITS,
  PdfRasterSandbox,
  PdfRasterSandboxError,
  PdfRasterSandboxErrorCode as SandboxCode,
  type PdfSandboxProcessRunner,
  type PdfSandboxRun,
} from "./pdf-raster-sandbox";

const PDF = Buffer.from("%PDF-1.7\nsynthetic\n%%EOF\n");
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
  "base64",
);

type ManifestPage = {
  pageNumber: number;
  file: string;
  width: number;
  height: number;
};

async function emitManifest(
  run: PdfSandboxRun,
  pages: readonly ManifestPage[] = [
    { pageNumber: 1, file: "page-0001.png", width: 1, height: 1 },
  ],
): Promise<void> {
  await mkdir(join(run.runDirectory, "output"), { mode: 0o700 });
  for (const page of pages) {
    await writeFile(join(run.runDirectory, "output", page.file), PNG_1X1, {
      flag: "wx",
      mode: 0o600,
    });
  }
  await writeFile(
    join(run.runDirectory, "manifest.json"),
    JSON.stringify({ version: 1, pages }),
    { flag: "wx", mode: 0o600 },
  );
}

function runner(
  execute: (run: PdfSandboxRun) => Promise<void> = emitManifest,
): PdfSandboxProcessRunner {
  return { execute };
}

describe("local PDF raster admission sandbox", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = join(
      "/tmp",
      `rf-pdf-sandbox-spec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(testRoot, { mode: 0o700 });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("rejects MIME mismatch, shifted magic and trailing polyglot bytes before spawn", async () => {
    let executions = 0;
    const sandbox = new PdfRasterSandbox(
      runner(async (run) => {
        executions += 1;
        await emitManifest(run);
      }),
      testRoot,
    );
    const cases = [
      { mimeType: "text/plain", bytes: PDF },
      {
        mimeType: "application/pdf",
        bytes: Buffer.concat([Buffer.from("X"), PDF]),
      },
      {
        mimeType: "application/pdf",
        bytes: Buffer.concat([PDF, Buffer.from("PK\u0003\u0004polyglot")]),
      },
    ];

    for (const input of cases) {
      await expect(sandbox.rasterize(input)).rejects.toMatchObject({
        code: "INVALID_DOCUMENT",
      });
    }
    expect(executions).toBe(0);
  });

  it.each([
    SandboxCode.MALFORMED_PDF,
    SandboxCode.ENCRYPTED_PDF,
    SandboxCode.EMBEDDED_FILE,
    SandboxCode.DECOMPRESSION_LIMIT,
  ])(
    "returns the fixed bounded worker error %s without leaking diagnostics",
    async (code) => {
      const privateText =
        "/private/vault/tenant-a statement.pdf SECRET=provider";
      const sandbox = new PdfRasterSandbox(
        runner(async () => {
          const failure = new PdfRasterSandboxError(code);
          Object.defineProperty(failure, "cause", {
            value: new Error(privateText.repeat(20)),
          });
          throw failure;
        }),
        testRoot,
      );

      const caught = await sandbox
        .rasterize({
          mimeType: "application/pdf",
          bytes: PDF,
        })
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(PdfRasterSandboxError);
      expect(caught).toMatchObject({ code });
      expect(String(caught)).not.toContain(privateText);
      expect(String(caught).length).toBeLessThan(100);
    },
  );

  it.each([0, 11])(
    "rejects a %i-page manifest and removes every raster",
    async (count) => {
      let runDirectory = "";
      const sandbox = new PdfRasterSandbox(
        runner(async (run) => {
          runDirectory = run.runDirectory;
          await emitManifest(
            run,
            Array.from({ length: count }, (_, index) => ({
              pageNumber: index + 1,
              file: `page-${String(index + 1).padStart(4, "0")}.png`,
              width: 1,
              height: 1,
            })),
          );
        }),
        testRoot,
      );

      await expect(
        sandbox.rasterize({ mimeType: "application/pdf", bytes: PDF }),
      ).rejects.toMatchObject({ code: "PAGE_LIMIT_EXCEEDED" });
      await expect(lstat(runDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("enforces dimensions, pixels, raw bytes and encoded output independently", async () => {
    const cases: Array<{
      page: ManifestPage;
      png?: Buffer;
      code: string;
    }> = [
      {
        page: {
          pageNumber: 1,
          file: "page-0001.png",
          width: PDF_RASTER_SANDBOX_LIMITS.maxDimension + 1,
          height: 1,
        },
        code: "RASTER_LIMIT_EXCEEDED",
      },
      {
        page: {
          pageNumber: 1,
          file: "page-0001.png",
          width: PDF_RASTER_SANDBOX_LIMITS.maxPixelsPerPage,
          height: 2,
        },
        code: "RASTER_LIMIT_EXCEEDED",
      },
      {
        page: {
          pageNumber: 1,
          file: "page-0001.png",
          width: Math.floor(PDF_RASTER_SANDBOX_LIMITS.maxRawBytes / 4) + 1,
          height: 1,
        },
        code: "RASTER_LIMIT_EXCEEDED",
      },
      {
        page: {
          pageNumber: 1,
          file: "page-0001.png",
          width: 1,
          height: 1,
        },
        png: Buffer.alloc(PDF_RASTER_SANDBOX_LIMITS.maxOutputBytes + 1),
        code: "RASTER_LIMIT_EXCEEDED",
      },
    ];
    for (const item of cases) {
      const sandbox = new PdfRasterSandbox(
        runner(async (run) => {
          await emitManifest(run, [item.page]);
          if (item.png)
            await writeFile(
              join(run.runDirectory, "output", item.page.file),
              item.png,
            );
        }),
        testRoot,
      );
      await expect(
        sandbox.rasterize({ mimeType: "application/pdf", bytes: PDF }),
      ).rejects.toMatchObject({ code: item.code });
    }
  });

  it("returns deterministic bytes in page order and leaves no temporary run", async () => {
    const sandbox = new PdfRasterSandbox(runner(), testRoot);
    const first = await sandbox.rasterize({
      mimeType: "application/pdf",
      bytes: PDF,
    });
    const second = await sandbox.rasterize({
      mimeType: "application/pdf",
      bytes: PDF,
    });

    expect(first.pages.map((page) => page.png)).toEqual(
      second.pages.map((page) => page.png),
    );
    expect(await readdir(testRoot)).toEqual([]);
  });

  it("rejects a symlink raster without following it and cleans the run", async () => {
    const outside = join(testRoot, "outside.png");
    await writeFile(outside, PNG_1X1);
    const sandbox = new PdfRasterSandbox(
      runner(async (run) => {
        await mkdir(join(run.runDirectory, "output"), { mode: 0o700 });
        await symlink(outside, join(run.runDirectory, "output/page-0001.png"));
        await writeFile(
          join(run.runDirectory, "manifest.json"),
          JSON.stringify({
            version: 1,
            pages: [
              {
                pageNumber: 1,
                file: "page-0001.png",
                width: 1,
                height: 1,
              },
            ],
          }),
        );
      }),
      testRoot,
    );

    await expect(
      sandbox.rasterize({ mimeType: "application/pdf", bytes: PDF }),
    ).rejects.toMatchObject({ code: "INVALID_SANDBOX_OUTPUT" });
    expect(await lstat(outside)).toBeDefined();
    expect(await readdir(testRoot)).toEqual(["outside.png"]);
  });

  it("propagates abort, waits for child cleanup, and removes partial output", async () => {
    let runDirectory = "";
    let childFinished = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const sandbox = new PdfRasterSandbox(
      runner(async (run) => {
        runDirectory = run.runDirectory;
        await mkdir(join(run.runDirectory, "output"));
        await writeFile(join(run.runDirectory, "output/partial.png"), PNG_1X1);
        markStarted?.();
        await new Promise<void>((resolve) => {
          run.signal.addEventListener(
            "abort",
            () => {
              childFinished = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new PdfRasterSandboxError(SandboxCode.ABORTED);
      }),
      testRoot,
    );
    const abort = new AbortController();
    const pending = sandbox.rasterize({
      mimeType: "application/pdf",
      bytes: PDF,
      signal: abort.signal,
    });
    await started;
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(childFinished).toBe(true);
    await expect(lstat(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins a detached, bounded Linux process group with a secret-free environment", () => {
    process.env.GEMINI_API_KEY = "must-not-cross";
    process.env.DATABASE_URL = "file:/private/tenant.db";
    const spawn = buildLinuxSandboxSpawn("/tmp/run", "/app/worker.mjs");

    expect(spawn.command).toBe("/bin/bash");
    expect(spawn.options.detached).toBe(true);
    expect(spawn.options.shell).toBe(false);
    expect(spawn.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(spawn.options.env).toEqual({
      PATH: "/usr/bin:/bin",
      PDF_SANDBOX_RUN_DIR: "/tmp/run",
      PDF_SANDBOX_WORKER: "/app/worker.mjs",
    });
    expect(spawn.args).toContain("--no-network");
    expect(spawn.args).toContain(
      String(PDF_RASTER_SANDBOX_LIMITS.maxAddressSpaceBytes),
    );
    expect(spawn.args).toContain(
      String(PDF_RASTER_SANDBOX_LIMITS.maxOpenFiles),
    );
    expect(spawn.options.env).not.toHaveProperty("GEMINI_API_KEY");
    expect(spawn.options.env).not.toHaveProperty("DATABASE_URL");
    expect(fsConstants.O_NOFOLLOW).toBeGreaterThan(0);
    delete process.env.GEMINI_API_KEY;
    delete process.env.DATABASE_URL;
  });
});
