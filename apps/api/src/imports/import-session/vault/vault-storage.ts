import * as fs from "node:fs";
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FileHandle } from "node:fs/promises";
import type { ImportArtifact } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
} from "@reformaflow/domain";
import type { ImportSessionClock } from "../import-session.capability";
import type { VaultBootHandle, VaultRuntime } from "./vault-boot";
import {
  availableBytes,
  boundedCode,
  fsyncProbe,
  type VaultErrno,
} from "./vault-durability";
import { VaultFdRegistry } from "./vault-fd-registry";

export type VaultDeclaredMime =
  | "application/pdf"
  | "text/csv"
  | "text/plain"
  | "application/vnd.ms-excel"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/x-ofx"
  | "application/vnd.ofx"
  | "image/png"
  | "image/jpeg"
  | "image/webp";
export type VaultUploadClaim = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  ownerUserId: string;
  sessionId: string;
  refId: string;
  uploadGeneration: 2;
  temporaryStorageKey: string;
  declaredBytes: number;
  declaredMime: VaultDeclaredMime;
  uploadSessionVersion: number;
  tokenExpiresAtMs: number;
  uploadTokenExpiresAtMs: number;
  uploadLeaseExpiresAtMs: number;
  sessionExpiresAtMs: number;
  claimedAtMs: number;
  claimedAtMonotonicMs: number;
}>;
export type VaultArtifactRead = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  ownerUserId: string;
  sessionId: string;
  refId: string;
  artifactId: string;
  storageKey: string;
}>;
export type StoredVaultUpload = Readonly<{
  storageKey: string;
  documentSha256: string;
  verifiedBytes: number;
  detectedFormat: ImportArtifact["detectedFormat"];
}>;
export type CapturedVaultPurge =
  | Readonly<{
      kind: "ref";
      tenantId: string;
      ownerProjectId: string;
      id: string;
      key: `R:${string}`;
      temporaryStorageKey: string;
      sourceKey: string;
      trashKey: string;
    }>
  | Readonly<{
      kind: "artifact";
      tenantId: string;
      ownerProjectId: string;
      id: string;
      key: `A:${string}`;
      storageKey: string;
      sourceKey: string;
      trashKey: string;
    }>;
export type VaultUploadRecheck = (claim: VaultUploadClaim) => Promise<void>;
export type VaultArtifactRecheck = (
  capture: VaultArtifactRead,
) => Promise<void>;
export type VaultReadConsumer<T> = (source: Readable) => Promise<T>;
export type VaultIoErrorKind =
  | "UNAVAILABLE"
  | "FENCED"
  | "INVALID_CAPTURE"
  | "ANOMALY"
  | "FS_ERROR"
  | "STREAM_ERROR"
  | "SIZE_MISMATCH"
  | "UNSUPPORTED_DOCUMENT"
  | "DEADLINE_EXCEEDED"
  | "IDLE_TIMEOUT"
  | "HEADROOM_INSUFFICIENT";
export type VaultIoStep =
  | "runtime"
  | "capture"
  | "recheck"
  | "headroom"
  | "mkdir"
  | "open"
  | "stream"
  | "sync-file"
  | "close-file"
  | "sync-directory"
  | "close-directory"
  | "lstat-source"
  | "lstat-trash"
  | "rename"
  | "remove-trash"
  | "remove-owner"
  | "absence-proof";
export type VaultIoFailure = Readonly<{
  kind: VaultIoErrorKind;
  step: VaultIoStep;
  code?: VaultErrno;
  closeCode?: VaultErrno;
}>;
export class VaultIoError extends Error {
  readonly kind: VaultIoErrorKind;
  readonly step: VaultIoStep;
  readonly code?: VaultErrno;
  readonly closeCode?: VaultErrno;
  constructor(failure: VaultIoFailure) {
    super(`${failure.kind}:${failure.step}`);
    this.name = "VaultIoError";
    this.kind = failure.kind;
    this.step = failure.step;
    this.code = failure.code;
    this.closeCode = failure.closeCode;
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const PREFIX_BYTES = 4096;
const READ_CHUNK_BYTES = 64 * 1024;
const LEASE_MS = IMPORT_SESSION_LIMITS.uploadLeaseSeconds * 1000;
export const MIME_FORMAT: Readonly<
  Record<VaultDeclaredMime, readonly string[]>
> = {
  "application/pdf": ["PDF"],
  "text/csv": ["CSV"],
  "text/plain": ["CSV", "OFX"],
  "application/vnd.ms-excel": ["XLS"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["XLSX"],
  "application/x-ofx": ["OFX"],
  "application/vnd.ofx": ["OFX"],
  "image/png": ["PNG"],
  "image/jpeg": ["JPEG"],
  "image/webp": ["WEBP"],
};
const failure = (kind: VaultIoErrorKind, step: VaultIoStep): VaultIoError =>
  new VaultIoError({ kind, step });
function validIds(...ids: string[]): boolean {
  return ids.every((id) => typeof id === "string" && ID.test(id));
}
function blobParts(key: string): {
  owner: string;
  generation: string;
  source: string;
} {
  const parts = typeof key === "string" ? key.split("/") : [];
  if (
    parts.length !== 4 ||
    parts[0] !== "t" ||
    !UUID.test(parts[1]) ||
    !/^g[1-9][0-9]*$/.test(parts[2]) ||
    parts[3] !== "blob"
  )
    throw failure("INVALID_CAPTURE", "capture");
  return {
    owner: parts[1],
    generation: parts[2],
    source: parts.slice(0, 3).join("/"),
  };
}
function detect(prefix: Buffer): string {
  if (prefix.subarray(0, 1024).includes(Buffer.from("%PDF-"))) return "PDF";
  if (prefix.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
    return "PNG";
  if (prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "JPEG";
  if (
    prefix.toString("ascii", 0, 4) === "RIFF" &&
    prefix.toString("ascii", 8, 12) === "WEBP"
  )
    return "WEBP";
  if (prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    return "XLSX";
  if (prefix.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")))
    return "XLS";
  if (!prefix.includes(0))
    return /<OFX|OFXHEADER/i.test(prefix.toString("utf8", 0, 600))
      ? "OFX"
      : "CSV";
  throw failure("UNSUPPORTED_DOCUMENT", "stream");
}
async function io<T>(step: VaultIoStep, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new VaultIoError({
      kind: "FS_ERROR",
      step,
      code: boundedCode(error),
    });
  }
}

export class VaultStorage {
  constructor(
    private readonly boot: VaultBootHandle,
    private readonly registry: VaultFdRegistry,
    private readonly clock: ImportSessionClock,
  ) {}

  private runtime(): Readonly<VaultRuntime> {
    const runtime = this.boot.runtime();
    if (!runtime) throw failure("UNAVAILABLE", "runtime");
    return runtime;
  }
  private current(runtime: Readonly<VaultRuntime>): void {
    if (this.boot.runtime() !== runtime)
      throw failure("UNAVAILABLE", "runtime");
  }
  private async directory(
    path: string,
    check: () => void,
    optional = false,
  ): Promise<boolean> {
    check();
    let stat;
    try {
      stat = await fs.promises.lstat(path);
    } catch (error) {
      if (optional && boundedCode(error) === "ENOENT") return false;
      throw new VaultIoError({
        kind: "FS_ERROR",
        step: "lstat-source",
        code: boundedCode(error),
      });
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    )
      throw failure("ANOMALY", "lstat-source");
    return true;
  }
  private async parents(
    runtime: Readonly<VaultRuntime>,
    check: () => void,
  ): Promise<void> {
    for (const key of ["", "t", "trash"])
      await this.directory(posix.join(runtime.config.rootDir, key), check);
  }
  private async syncDirectory(
    path: string,
    check: () => void,
    uncertainClose?: () => void,
  ): Promise<void> {
    check();
    if (uncertainClose) {
      // Registered owners need positive close evidence even on sync failure; the
      // probe's FS_ERROR alone cannot distinguish a lone close failure.
      const handle = await io("open", () =>
        fs.promises.open(
          path,
          fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW,
        ),
      );
      let primary: unknown,
        closed = false;
      try {
        check();
        await io("sync-directory", () => handle.sync());
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        try {
          await this.finishFile(
            handle,
            primary,
            () => {
              closed = true;
            },
            "close-directory",
          );
        } finally {
          if (!closed) uncertainClose();
        }
      }
      check();
      return;
    }
    const result = await fsyncProbe(
      path,
      () => {
        check();
        return false;
      },
      (error) => {
        throw new VaultIoError({
          kind: "FS_ERROR",
          step: "close-directory",
          code: error.code,
        });
      },
    );
    if (!result.ok) {
      if (result.outcome === "FS_ERROR")
        throw new VaultIoError({
          kind: "FS_ERROR",
          step: "sync-directory",
          code: result.code,
          closeCode: result.closeCode,
        });
      throw failure("UNAVAILABLE", "sync-directory");
    }
    check();
  }
  private async finishFile(
    handle: FileHandle | undefined,
    primary: unknown,
    onClosed: () => void,
    step: "close-file" | "close-directory" = "close-file",
  ): Promise<void> {
    if (!handle) return;
    try {
      await handle.close();
      onClosed();
    } catch (error) {
      const code = boundedCode(error);
      if (primary instanceof VaultIoError)
        throw new VaultIoError({
          kind: primary.kind,
          step: primary.step,
          code: primary.code,
          closeCode: code,
        });
      throw new VaultIoError({ kind: "FS_ERROR", step, code });
    }
  }

  async writeClaim(
    input: VaultUploadClaim,
    source: Readable,
    recheck: VaultUploadRecheck,
  ): Promise<StoredVaultUpload> {
    const runtime = this.runtime(),
      claim = Object.freeze({ ...input });
    if (
      !validIds(
        claim.tenantId,
        claim.ownerProjectId,
        claim.ownerUserId,
        claim.sessionId,
      ) ||
      !UUID.test(claim.refId) ||
      claim.temporaryStorageKey !== `t/${claim.refId}` ||
      claim.uploadGeneration !== 2 ||
      !Number.isSafeInteger(claim.declaredBytes) ||
      claim.declaredBytes < 1 ||
      claim.declaredBytes > IMPORT_SESSION_LIMITS.bytesPerFile ||
      !Object.prototype.hasOwnProperty.call(MIME_FORMAT, claim.declaredMime) ||
      !Number.isSafeInteger(claim.uploadSessionVersion) ||
      claim.uploadSessionVersion < 0 ||
      ![
        claim.tokenExpiresAtMs,
        claim.uploadTokenExpiresAtMs,
        claim.uploadLeaseExpiresAtMs,
        claim.sessionExpiresAtMs,
        claim.claimedAtMs,
        claim.claimedAtMonotonicMs,
      ].every(Number.isFinite)
    )
      throw failure("INVALID_CAPTURE", "capture");
    const wallEnd = Math.min(
      claim.claimedAtMs + LEASE_MS,
      claim.uploadLeaseExpiresAtMs,
      claim.uploadTokenExpiresAtMs,
      claim.tokenExpiresAtMs,
      claim.sessionExpiresAtMs,
    );
    const monoEnd = claim.claimedAtMonotonicMs + (wallEnd - claim.claimedAtMs);
    const admission = this.registry.enter(`R:${claim.refId}`, claim);
    if (!admission.ok) throw failure("FENCED", "recheck");
    const lease = admission.lease;
    let handle: FileHandle | undefined,
      closed = true,
      uncertainDirectory = false;
    let primary: unknown,
      timer: ReturnType<typeof setTimeout> | undefined,
      idle: ReturnType<typeof setTimeout> | undefined;
    let stopError: VaultIoError | undefined, sourceError: unknown;
    const check = (): void => {
      this.current(runtime);
      if (lease.signal.aborted) throw failure("FENCED", "stream");
      if (performance.now() >= monoEnd || this.clock.now().getTime() >= wallEnd)
        throw failure("DEADLINE_EXCEEDED", "stream");
      if (stopError) throw stopError;
    };
    const stop = (error: VaultIoError): void => {
      stopError ??= error;
      source.destroy(stopError);
    };
    const onAbort = (): void => stop(failure("FENCED", "stream"));
    const onError = (error: unknown): void => {
      sourceError = error;
    };
    source.on("error", onError);
    lease.signal.addEventListener("abort", onAbort, { once: true });
    const armDeadline = (): void => {
      const delay = Math.max(
        1,
        Math.ceil(
          Math.min(
            monoEnd - performance.now(),
            wallEnd - this.clock.now().getTime(),
          ),
        ),
      );
      timer = setTimeout(() => {
        try {
          check();
          armDeadline();
        } catch (error) {
          stop(
            error instanceof VaultIoError
              ? error
              : failure("DEADLINE_EXCEEDED", "stream"),
          );
        }
      }, delay);
      timer.unref();
    };
    let lastProgress = 0;
    const armIdle = (): void => {
      clearTimeout(idle);
      if (runtime.config.idleTimeoutMs >= LEASE_MS) return;
      idle = setTimeout(
        () => {
          try {
            check();
          } catch (error) {
            stop(
              error instanceof VaultIoError
                ? error
                : failure("DEADLINE_EXCEEDED", "stream"),
            );
            return;
          }
          if (performance.now() - lastProgress > runtime.config.idleTimeoutMs)
            stop(failure("IDLE_TIMEOUT", "stream"));
          else armIdle();
        },
        Math.max(
          1,
          Math.ceil(
            runtime.config.idleTimeoutMs -
              (performance.now() - lastProgress) +
              1,
          ),
        ),
      );
      idle.unref();
    };
    try {
      await recheck(claim);
      check();
      armDeadline();
      await this.parents(runtime, check);
      check();
      const space = await availableBytes(
        posix.join(runtime.config.rootDir, "t"),
        () => {
          check();
          return false;
        },
      );
      check();
      if (!space.ok) {
        if (space.outcome === "FS_ERROR")
          throw new VaultIoError({
            kind: "FS_ERROR",
            step: "headroom",
            code: space.code,
          });
        throw failure("UNAVAILABLE", "headroom");
      }
      if (space.available < BigInt(runtime.config.headroomBytes))
        throw failure("HEADROOM_INSUFFICIENT", "headroom");
      for (const relative of [
        claim.temporaryStorageKey,
        `${claim.temporaryStorageKey}/g2`,
      ]) {
        check();
        const path = posix.join(runtime.config.rootDir, relative);
        try {
          await fs.promises.mkdir(path, { mode: 0o700 });
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "EEXIST"
            )
          )
            throw new VaultIoError({
              kind: "FS_ERROR",
              step: "mkdir",
              code: boundedCode(error),
            });
        }
        await this.directory(path, check);
      }
      const storageKey = `${claim.temporaryStorageKey}/g2/blob`;
      check();
      handle = await io("open", () =>
        fs.promises.open(
          posix.join(runtime.config.rootDir, storageKey),
          fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_WRONLY |
            fs.constants.O_NOFOLLOW,
          0o600,
        ),
      );
      closed = false;
      check();
      let verifiedBytes = 0,
        prefix = Buffer.alloc(0);
      const hash = createHash("sha256");
      lastProgress = performance.now();
      armIdle();
      try {
        for await (const raw of source) {
          check();
          if (
            !Buffer.isBuffer(raw) &&
            typeof raw !== "string" &&
            !(raw instanceof Uint8Array)
          )
            throw failure("STREAM_ERROR", "stream");
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (chunk.length === 0) continue;
          verifiedBytes += chunk.length;
          if (verifiedBytes > claim.declaredBytes)
            throw failure("SIZE_MISMATCH", "stream");
          if (prefix.length < PREFIX_BYTES)
            prefix = Buffer.concat([
              prefix,
              chunk.subarray(0, PREFIX_BYTES - prefix.length),
            ]);
          hash.update(chunk);
          lastProgress = performance.now();
          armIdle();
          let offset = 0;
          while (offset < chunk.length) {
            check();
            const written = await io("stream", () =>
              handle!.write(chunk, offset, chunk.length - offset),
            );
            if (written.bytesWritten === 0) throw failure("FS_ERROR", "stream");
            offset += written.bytesWritten;
          }
        }
      } catch (error) {
        if (error instanceof VaultIoError) throw error;
        if (stopError) throw stopError;
        throw new VaultIoError({
          kind: "STREAM_ERROR",
          step: "stream",
          code: boundedCode(error),
        });
      }
      check();
      if (sourceError)
        throw new VaultIoError({
          kind: "STREAM_ERROR",
          step: "stream",
          code: boundedCode(sourceError),
        });
      if (verifiedBytes !== claim.declaredBytes)
        throw failure("SIZE_MISMATCH", "stream");
      const detectedFormat = detect(prefix);
      if (!MIME_FORMAT[claim.declaredMime].includes(detectedFormat))
        throw failure("UNSUPPORTED_DOCUMENT", "stream");
      clearTimeout(idle);
      check();
      await io("sync-file", () => handle!.sync());
      const completed = handle;
      handle = undefined;
      await this.finishFile(completed, undefined, () => {
        closed = true;
      });
      for (const dir of [
        `${claim.temporaryStorageKey}/g2`,
        claim.temporaryStorageKey,
        "t",
        "",
      ])
        await this.syncDirectory(
          posix.join(runtime.config.rootDir, dir),
          check,
          () => {
            uncertainDirectory = true;
          },
        );
      check();
      return Object.freeze({
        storageKey,
        verifiedBytes,
        documentSha256: hash.digest("hex"),
        detectedFormat,
      });
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(idle);
      lease.signal.removeEventListener("abort", onAbort);
      try {
        await this.finishFile(handle, primary, () => {
          closed = true;
        });
      } finally {
        source.off("error", onError);
        if (closed && !uncertainDirectory) lease.exit();
      }
    }
  }

  async withArtifactReader<T>(
    input: VaultArtifactRead,
    recheck: VaultArtifactRecheck,
    consume: VaultReadConsumer<T>,
  ): Promise<T> {
    const runtime = this.runtime(),
      capture = Object.freeze({ ...input });
    if (
      !validIds(
        capture.tenantId,
        capture.ownerProjectId,
        capture.ownerUserId,
        capture.sessionId,
      ) ||
      !UUID.test(capture.refId) ||
      !UUID.test(capture.artifactId)
    )
      throw failure("INVALID_CAPTURE", "capture");
    const parts = blobParts(capture.storageKey);
    const admission = this.registry.enter(`A:${capture.artifactId}`, capture);
    if (!admission.ok) throw failure("FENCED", "recheck");
    const lease = admission.lease;
    const check = (): void => {
      this.current(runtime);
      if (lease.signal.aborted) throw failure("FENCED", "stream");
    };
    let handle: FileHandle | undefined,
      source: Readable | undefined,
      sourceClosed: Promise<void> | undefined,
      closed = true,
      primary: unknown,
      readError: unknown;
    const observeError = (error: unknown): void => {
      readError = error;
    };
    const abort = (): void => {
      source?.destroy(failure("FENCED", "stream"));
    };
    lease.signal.addEventListener("abort", abort, { once: true });
    try {
      await recheck(capture);
      check();
      await this.parents(runtime, check);
      await this.directory(
        posix.join(runtime.config.rootDir, "t", parts.owner),
        check,
      );
      await this.directory(
        posix.join(runtime.config.rootDir, parts.source),
        check,
      );
      check();
      handle = await io("open", () =>
        fs.promises.open(
          posix.join(runtime.config.rootDir, capture.storageKey),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        ),
      );
      closed = false;
      check();
      const stat = await io("open", () => handle!.stat());
      if (!stat.isFile()) throw failure("ANOMALY", "open");
      check();
      const reader = handle;
      // FileHandle ReadStream.destroy closes its FD even with autoClose:false.
      // This iterator keeps close ownership here, including abort/consumer errors.
      source = Readable.from(
        (async function* () {
          let position = 0;
          for (;;) {
            check();
            const buffer = Buffer.alloc(READ_CHUNK_BYTES);
            const { bytesRead } = await io("stream", () =>
              reader.read(buffer, 0, buffer.length, position),
            );
            check();
            if (bytesRead === 0) return;
            position += bytesRead;
            yield buffer.subarray(0, bytesRead);
          }
        })(),
        { objectMode: false },
      );
      sourceClosed = new Promise<void>((resolve) =>
        source!.once("close", resolve),
      );
      source.on("error", observeError);
      const result = await consume(source);
      check();
      if (readError)
        throw new VaultIoError({
          kind: "STREAM_ERROR",
          step: "stream",
          code: boundedCode(readError),
        });
      return result;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      lease.signal.removeEventListener("abort", abort);
      source?.destroy();
      try {
        await sourceClosed;
        await this.finishFile(handle, primary, () => {
          closed = true;
        });
      } finally {
        source?.off("error", observeError);
        if (closed) lease.exit();
      }
      if (!primary && readError)
        throw new VaultIoError({
          kind: "STREAM_ERROR",
          step: "stream",
          code: boundedCode(readError),
        });
    }
  }

  async eraseCaptured(input: CapturedVaultPurge): Promise<void> {
    const runtime = this.runtime(),
      capture = Object.freeze({ ...input });
    const check = (): void => this.current(runtime);
    if (
      !validIds(capture.tenantId, capture.ownerProjectId) ||
      !UUID.test(capture.id)
    )
      throw failure("INVALID_CAPTURE", "capture");
    let owner: string | undefined;
    if (capture.kind === "ref") {
      if (
        capture.key !== `R:${capture.id}` ||
        capture.temporaryStorageKey !== `t/${capture.id}` ||
        capture.sourceKey !== capture.temporaryStorageKey ||
        capture.trashKey !== `trash/r-${capture.id}`
      )
        throw failure("INVALID_CAPTURE", "capture");
    } else if (capture.kind === "artifact") {
      const parts = blobParts(capture.storageKey);
      owner = parts.owner;
      if (
        capture.key !== `A:${capture.id}` ||
        capture.sourceKey !== parts.source ||
        capture.trashKey !==
          `trash/a-${capture.id}-${parts.owner}-${parts.generation}`
      )
        throw failure("INVALID_CAPTURE", "capture");
    } else throw failure("INVALID_CAPTURE", "capture");
    await this.parents(runtime, check);
    const root = runtime.config.rootDir,
      source = posix.join(root, capture.sourceKey),
      trash = posix.join(root, capture.trashKey);
    const ownerPath = owner ? posix.join(root, "t", owner) : undefined;
    const ownerExists = ownerPath
      ? await this.directory(ownerPath, check, true)
      : false;
    const inspect = async (
      path: string,
      step: VaultIoStep,
    ): Promise<boolean> => {
      check();
      try {
        const stat = await fs.promises.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw failure("ANOMALY", step);
        return true;
      } catch (error) {
        if (error instanceof VaultIoError) throw error;
        if (boundedCode(error) === "ENOENT") return false;
        throw new VaultIoError({
          kind: "FS_ERROR",
          step,
          code: boundedCode(error),
        });
      }
    };
    const sourceExists = await inspect(source, "lstat-source"),
      trashExists = await inspect(trash, "lstat-trash");
    if (sourceExists && trashExists) throw failure("ANOMALY", "rename");
    if (sourceExists) {
      check();
      await io("rename", () => fs.promises.rename(source, trash));
    }
    if (ownerPath && ownerExists) await this.syncDirectory(ownerPath, check);
    await this.syncDirectory(posix.join(root, "t"), check);
    await this.syncDirectory(posix.join(root, "trash"), check);
    if (sourceExists || trashExists) {
      check();
      await io("remove-trash", () =>
        fs.promises.rm(trash, { recursive: true, force: false }),
      );
    }
    await this.syncDirectory(posix.join(root, "trash"), check);
    if (ownerPath && ownerExists) {
      check();
      try {
        await fs.promises.rmdir(ownerPath);
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOTEMPTY"
          )
        )
          throw new VaultIoError({
            kind: "FS_ERROR",
            step: "remove-owner",
            code: boundedCode(error),
          });
      }
    }
    await this.syncDirectory(posix.join(root, "t"), check);
    await this.parents(runtime, check);
    const remainingSource = await inspect(source, "absence-proof"),
      remainingTrash = await inspect(trash, "absence-proof");
    if (remainingSource || remainingTrash)
      throw failure("ANOMALY", "absence-proof");
    check();
  }
}
