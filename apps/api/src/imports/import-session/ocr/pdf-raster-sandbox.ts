import { spawn, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

const PDF_MIME = "application/pdf";
const PDF_HEADER = Buffer.from("%PDF-");
const PDF_TRAILER = /%%EOF[\t\n\f\r ]*$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MANIFEST_FILE = "manifest.json";
const OUTPUT_DIRECTORY = "output";
const RUN_PREFIX = "run-";
const DEFAULT_RUN_ROOT = "/tmp/reformaflow-pdf-raster";
const WORKER_FILE = "pdf-raster-sandbox.worker.sh";
const LAUNCHER_FILE = "pdf-raster-sandbox.launcher.sh";
const MANIFEST_VERSION = 1;
const MANIFEST_MAX_BYTES = 64 * 1024;
const PROCESS_OUTPUT_MAX_BYTES = 4 * 1024;
const TERMINATION_GRACE_MS = 500;
const BYTES_PER_PIXEL = 4;

export const PDF_RASTER_SANDBOX_LIMITS = Object.freeze({
  maxInputBytes: 10 * 1024 * 1024,
  maxPages: 10,
  maxDimension: 4096,
  maxPixelsPerPage: 8_000_000,
  maxTotalPixels: 32_000_000,
  maxRawBytes: 128 * 1024 * 1024,
  maxOutputBytes: 32 * 1024 * 1024,
  maxAddressSpaceBytes: 384 * 1024 * 1024,
  maxOpenFiles: 32,
  deadlineMs: 45_000,
});

export enum PdfRasterSandboxErrorCode {
  INVALID_DOCUMENT = "INVALID_DOCUMENT",
  MALFORMED_PDF = "MALFORMED_PDF",
  ENCRYPTED_PDF = "ENCRYPTED_PDF",
  EMBEDDED_FILE = "EMBEDDED_FILE",
  PAGE_LIMIT_EXCEEDED = "PAGE_LIMIT_EXCEEDED",
  DECOMPRESSION_LIMIT = "DECOMPRESSION_LIMIT",
  RASTER_LIMIT_EXCEEDED = "RASTER_LIMIT_EXCEEDED",
  INVALID_SANDBOX_OUTPUT = "INVALID_SANDBOX_OUTPUT",
  SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE",
  SANDBOX_TIMEOUT = "SANDBOX_TIMEOUT",
  ABORTED = "ABORTED",
  SANDBOX_FAILED = "SANDBOX_FAILED",
}

const WORKER_CODES: ReadonlySet<PdfRasterSandboxErrorCode> = new Set([
  PdfRasterSandboxErrorCode.MALFORMED_PDF,
  PdfRasterSandboxErrorCode.ENCRYPTED_PDF,
  PdfRasterSandboxErrorCode.EMBEDDED_FILE,
  PdfRasterSandboxErrorCode.PAGE_LIMIT_EXCEEDED,
  PdfRasterSandboxErrorCode.DECOMPRESSION_LIMIT,
  PdfRasterSandboxErrorCode.RASTER_LIMIT_EXCEEDED,
  PdfRasterSandboxErrorCode.INVALID_SANDBOX_OUTPUT,
]);

/** Fixed public failure: no source bytes, tool diagnostics or filesystem paths. */
export class PdfRasterSandboxError extends Error {
  constructor(readonly code: PdfRasterSandboxErrorCode) {
    super("PDF sandbox rejected document");
    this.name = "PdfRasterSandboxError";
  }
}

export interface PdfRasterPage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly png: Buffer;
}

export interface PdfRasterResult {
  readonly pages: readonly PdfRasterPage[];
}

export interface PdfRasterInput {
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly signal?: AbortSignal;
}

export interface PdfSandboxRun {
  readonly runDirectory: string;
  readonly signal: AbortSignal;
}

export interface PdfSandboxProcessRunner {
  execute(run: PdfSandboxRun): Promise<void>;
}

export interface LinuxSandboxSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

/**
 * This is deliberately data-only so tests can pin the OS boundary. The child
 * receives an allow-listed environment rather than a filtered copy.
 */
export function buildLinuxSandboxSpawn(
  runDirectory: string,
  workerPath: string,
  launcherPath: string = join(__dirname, LAUNCHER_FILE),
): LinuxSandboxSpawn {
  return {
    command: "/bin/bash",
    args: [
      launcherPath,
      "--no-network",
      String(PDF_RASTER_SANDBOX_LIMITS.maxAddressSpaceBytes),
      String(PDF_RASTER_SANDBOX_LIMITS.maxOpenFiles),
    ],
    options: {
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        PDF_SANDBOX_RUN_DIR: runDirectory,
        PDF_SANDBOX_WORKER: workerPath,
      },
    },
  };
}

export class LinuxPdfSandboxProcessRunner implements PdfSandboxProcessRunner {
  constructor(
    private readonly workerPath: string = join(__dirname, WORKER_FILE),
  ) {}

  async execute(run: PdfSandboxRun): Promise<void> {
    if (process.platform !== "linux")
      throw new PdfRasterSandboxError(
        PdfRasterSandboxErrorCode.SANDBOX_UNAVAILABLE,
      );
    const launch = buildLinuxSandboxSpawn(run.runDirectory, this.workerPath);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args], launch.options);
      let output = "";
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const append = (chunk: Buffer): void => {
        if (Buffer.byteLength(output) >= PROCESS_OUTPUT_MAX_BYTES) return;
        output += chunk
          .subarray(
            0,
            Math.max(0, PROCESS_OUTPUT_MAX_BYTES - Buffer.byteLength(output)),
          )
          .toString("ascii");
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const killGroup = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The close event is authoritative; ESRCH means the group is gone.
        }
      };
      const terminate = (): void => {
        killGroup("SIGTERM");
        killTimer = setTimeout(
          () => killGroup("SIGKILL"),
          TERMINATION_GRACE_MS,
        );
        killTimer.unref();
      };
      const abort = (): void => terminate();
      run.signal.addEventListener("abort", abort, { once: true });
      if (run.signal.aborted) terminate();
      const deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, PDF_RASTER_SANDBOX_LIMITS.deadlineMs);
      deadline.unref();

      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        run.signal.removeEventListener("abort", abort);
        reject(
          new PdfRasterSandboxError(
            PdfRasterSandboxErrorCode.SANDBOX_UNAVAILABLE,
          ),
        );
      });
      child.once("close", (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        run.signal.removeEventListener("abort", abort);
        if (run.signal.aborted) {
          reject(new PdfRasterSandboxError(PdfRasterSandboxErrorCode.ABORTED));
          return;
        }
        if (timedOut) {
          reject(
            new PdfRasterSandboxError(
              PdfRasterSandboxErrorCode.SANDBOX_TIMEOUT,
            ),
          );
          return;
        }
        if (exitCode === 0) {
          resolve();
          return;
        }
        const code = output
          .split(/\s+/)
          .find((token): token is PdfRasterSandboxErrorCode =>
            WORKER_CODES.has(token as PdfRasterSandboxErrorCode),
          );
        reject(
          new PdfRasterSandboxError(
            code ?? PdfRasterSandboxErrorCode.SANDBOX_FAILED,
          ),
        );
      });
    });
  }
}

interface ManifestPage {
  readonly pageNumber: number;
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

function invalidOutput(): never {
  throw new PdfRasterSandboxError(
    PdfRasterSandboxErrorCode.INVALID_SANDBOX_OUTPUT,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => key === keys[index])
  );
}

function parseManifest(value: unknown): readonly ManifestPage[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "pages"]) ||
    value.version !== MANIFEST_VERSION ||
    !Array.isArray(value.pages)
  )
    return invalidOutput();
  if (
    value.pages.length < 1 ||
    value.pages.length > PDF_RASTER_SANDBOX_LIMITS.maxPages
  )
    throw new PdfRasterSandboxError(
      PdfRasterSandboxErrorCode.PAGE_LIMIT_EXCEEDED,
    );
  return value.pages.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["pageNumber", "file", "width", "height"]) ||
      candidate.pageNumber !== index + 1 ||
      candidate.file !== `page-${String(index + 1).padStart(4, "0")}.png` ||
      !Number.isSafeInteger(candidate.width) ||
      !Number.isSafeInteger(candidate.height) ||
      (candidate.width as number) < 1 ||
      (candidate.height as number) < 1
    )
      return invalidOutput();
    return candidate as unknown as ManifestPage;
  });
}

async function readNoFollow(path: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) invalidOutput();
    return await handle.readFile();
  } catch (error) {
    if (error instanceof PdfRasterSandboxError) throw error;
    return invalidOutput();
  } finally {
    await handle?.close();
  }
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  )
    return invalidOutput();
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validateAdmission(input: PdfRasterInput): void {
  if (
    input.mimeType !== PDF_MIME ||
    input.bytes.length < PDF_HEADER.length ||
    input.bytes.length > PDF_RASTER_SANDBOX_LIMITS.maxInputBytes ||
    !input.bytes.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) ||
    !PDF_TRAILER.test(input.bytes.toString("latin1"))
  )
    throw new PdfRasterSandboxError(PdfRasterSandboxErrorCode.INVALID_DOCUMENT);
}

async function prepareRunRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PdfRasterSandboxError(
      PdfRasterSandboxErrorCode.SANDBOX_UNAVAILABLE,
    );
  await realpath(root);
}

async function writeInput(runDirectory: string, bytes: Buffer): Promise<void> {
  const path = join(runDirectory, "input.pdf");
  const handle = await open(
    path,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Inert foundation: this service is intentionally not registered in Nest. */
export class PdfRasterSandbox {
  constructor(
    private readonly runner: PdfSandboxProcessRunner = new LinuxPdfSandboxProcessRunner(),
    private readonly runRoot: string = DEFAULT_RUN_ROOT,
  ) {}

  async rasterize(input: PdfRasterInput): Promise<PdfRasterResult> {
    validateAdmission(input);
    if (input.signal?.aborted)
      throw new PdfRasterSandboxError(PdfRasterSandboxErrorCode.ABORTED);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    let runDirectory: string | undefined;
    try {
      await prepareRunRoot(this.runRoot);
      if (controller.signal.aborted)
        throw new PdfRasterSandboxError(PdfRasterSandboxErrorCode.ABORTED);
      runDirectory = await mkdtemp(join(this.runRoot, RUN_PREFIX));
      await writeInput(runDirectory, input.bytes);
      await this.runner.execute({
        runDirectory,
        signal: controller.signal,
      });
      if (controller.signal.aborted)
        throw new PdfRasterSandboxError(PdfRasterSandboxErrorCode.ABORTED);
      return await this.readResult(runDirectory);
    } catch (error) {
      if (error instanceof PdfRasterSandboxError) throw error;
      throw new PdfRasterSandboxError(PdfRasterSandboxErrorCode.SANDBOX_FAILED);
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (runDirectory) {
        try {
          await rm(runDirectory, {
            recursive: true,
            force: true,
            maxRetries: 2,
          });
        } catch {
          throw new PdfRasterSandboxError(
            PdfRasterSandboxErrorCode.SANDBOX_FAILED,
          );
        }
      }
    }
  }

  private async readResult(runDirectory: string): Promise<PdfRasterResult> {
    const manifestBytes = await readNoFollow(
      join(runDirectory, MANIFEST_FILE),
      MANIFEST_MAX_BYTES,
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      return invalidOutput();
    }
    const manifest = parseManifest(decoded);
    const pages: PdfRasterPage[] = [];
    let totalPixels = 0;
    let totalRawBytes = 0;
    let totalOutputBytes = 0;
    for (const page of manifest) {
      const pixels = page.width * page.height;
      const rawBytes = pixels * BYTES_PER_PIXEL;
      totalPixels += pixels;
      totalRawBytes += rawBytes;
      if (
        page.width > PDF_RASTER_SANDBOX_LIMITS.maxDimension ||
        page.height > PDF_RASTER_SANDBOX_LIMITS.maxDimension ||
        pixels > PDF_RASTER_SANDBOX_LIMITS.maxPixelsPerPage ||
        totalPixels > PDF_RASTER_SANDBOX_LIMITS.maxTotalPixels ||
        totalRawBytes > PDF_RASTER_SANDBOX_LIMITS.maxRawBytes
      )
        throw new PdfRasterSandboxError(
          PdfRasterSandboxErrorCode.RASTER_LIMIT_EXCEEDED,
        );
      const path = join(runDirectory, OUTPUT_DIRECTORY, page.file);
      const png = await readNoFollow(
        path,
        PDF_RASTER_SANDBOX_LIMITS.maxOutputBytes + 1,
      );
      totalOutputBytes += png.length;
      if (totalOutputBytes > PDF_RASTER_SANDBOX_LIMITS.maxOutputBytes)
        throw new PdfRasterSandboxError(
          PdfRasterSandboxErrorCode.RASTER_LIMIT_EXCEEDED,
        );
      const dimensions = pngDimensions(png);
      if (dimensions.width !== page.width || dimensions.height !== page.height)
        invalidOutput();
      pages.push({ ...page, png });
    }
    return { pages };
  }
}
