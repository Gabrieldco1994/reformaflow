import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { platform } from "node:os";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { validateDocumentExtraction } from "./statement-document";
import type {
  BinaryDocumentExtractionError,
  CardStatementBinaryDocumentInputV1,
  DocumentExtractionV1,
} from "./types";

export interface X2NativeConfig {
  readonly runtimeRoot: string;
  readonly runtimeSeal: string;
  readonly workerUid: number;
  readonly workerGid: number;
  readonly memoryBytes: bigint;
  readonly cpuQuotaUs: bigint;
  readonly cpuPeriodUs: bigint;
  readonly cpuBudgetNs: bigint;
  readonly cpuPollMs: number;
  readonly pidsMax: number;
  readonly cleanupMs: number;
}
export interface X2RunInput {
  readonly document: CardStatementBinaryDocumentInputV1;
  readonly originalSha256: string;
  readonly tenantId: string;
  readonly config: X2NativeConfig;
  readonly signal?: AbortSignal;
}
export type X2Failure =
  | Readonly<{
      kind: "DOCUMENT";
      code: "INVALID_INPUT" | "LIMIT_EXCEEDED" | "INVALID_RESULT";
      reason: null;
    }>
  | Readonly<{
      kind: "DOCUMENT";
      code: "UNSUPPORTED_DOCUMENT";
      reason: BinaryDocumentExtractionError["reason"] | null;
    }>
  | Readonly<{
      kind: "EXECUTION";
      code:
        | "UNAVAILABLE"
        | "PROTOCOL_ERROR"
        | "DEADLINE"
        | "WORKER_FAILED"
        | "CANCELLED"
        | "CALLER_GONE"
        | "QUARANTINED"
        | "BUSY";
      resource: null;
    }>
  | Readonly<{
      kind: "EXECUTION";
      code: "RESOURCE_LIMIT";
      resource: "MEMORY" | "PIDS" | "CPU";
    }>;
export type X2RunResult =
  | Readonly<{ kind: "SUCCESS"; document: DocumentExtractionV1 }>
  | Readonly<{ kind: "FAILURE"; failure: X2Failure }>;
export interface X2Settlement {
  readonly cleanup: "NOT_STARTED" | "CLEAN" | "QUARANTINED" | "UNCONFIRMED";
  readonly nativeFailure: X2Failure | null;
  readonly exitCode: number | null;
}
export interface X2RunHandle {
  readonly result: Promise<X2RunResult>;
  readonly settled: Promise<X2Settlement>;
}

export const X2_WIRE = Object.freeze({
  maxBytes: 10485760,
  headerBytes: 12,
  deadlineMs: 60000,
  hello: 1,
  start: 2,
  armed: 3,
  document: 4,
  result: 5,
  done: 6,
  error: 7,
  cancel: 8,
  workerInit: 9,
  workerReady: 10,
});
const VERSIONS = [
  "",
  "card-local-pdf-v1",
  "card-local-xls-v1",
  "card-local-xlsx-v1",
];
const REASONS = [
  null,
  "PASSWORD_PROTECTED",
  "NO_TEXT_LAYER",
  "UNSUPPORTED_LAYOUT",
  "MULTIPLE_SHEETS",
  "UNSUPPORTED_CONTAINER",
  "CORRUPT_DOCUMENT",
] as const;
const EXECUTIONS = {
  20: "UNAVAILABLE",
  21: "PROTOCOL_ERROR",
  22: "DEADLINE",
  24: "WORKER_FAILED",
  25: "CANCELLED",
  26: "CALLER_GONE",
  27: "QUARANTINED",
  28: "BUSY",
} as const;
export interface X2Frame {
  readonly kind: number;
  readonly profile: number;
  readonly body: Buffer;
}

export function x2Frame(kind: number, profile: number, body: Buffer): Buffer {
  const h = Buffer.alloc(X2_WIRE.headerBytes);
  h.write("X2N1", "ascii");
  h[4] = kind;
  h[5] = profile;
  h.writeUInt32BE(body.length, 8);
  return Buffer.concat([h, body]);
}

// The worker shares the codec here; no Node IPC or arbitrary object decoding.
export class X2FrameReader {
  private header = Buffer.alloc(12);
  private headerUsed = 0;
  private body = Buffer.alloc(0);
  private bodyUsed = 0;
  private failed = false;
  constructor(
    private readonly lengthAllowed: (
      kind: number,
      profile: number,
      length: number,
    ) => boolean,
    private readonly receive: (frame: X2Frame) => void,
  ) {}
  push(chunk: Buffer): void {
    if (this.failed) throw new Error("X2_PROTOCOL");
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.headerUsed < 12) {
          const count = Math.min(12 - this.headerUsed, chunk.length - offset);
          chunk.copy(this.header, this.headerUsed, offset, offset + count);
          this.headerUsed += count;
          offset += count;
          if (this.headerUsed !== 12) continue;
          const kind = this.header[4];
          const profile = this.header[5];
          const length = this.header.readUInt32BE(8);
          if (
            this.header.toString("ascii", 0, 4) !== "X2N1" ||
            this.header.readUInt16BE(6) !== 0 ||
            kind < 1 ||
            kind > 10 ||
            profile > 3 ||
            !this.lengthAllowed(kind, profile, length)
          ) {
            throw new Error("X2_PROTOCOL");
          }
          this.body = Buffer.alloc(length);
          this.bodyUsed = 0;
        }
        const count = Math.min(
          this.body.length - this.bodyUsed,
          chunk.length - offset,
        );
        chunk.copy(this.body, this.bodyUsed, offset, offset + count);
        offset += count;
        this.bodyUsed += count;
        if (this.bodyUsed === this.body.length) {
          const frame = {
            kind: this.header[4],
            profile: this.header[5],
            body: this.body,
          };
          this.headerUsed = 0;
          this.body = Buffer.alloc(0);
          this.receive(frame);
        }
      }
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  get complete(): boolean {
    return !this.failed && this.headerUsed === 0;
  }
}

function execution(code: keyof typeof EXECUTIONS): X2Failure {
  return { kind: "EXECUTION", code: EXECUTIONS[code], resource: null };
}
export function x2DecodeError(
  body: Buffer,
  internal: boolean,
): {
  failure: X2Failure;
  primary: number;
  cleanup: number;
} {
  if (body.length !== 12) throw new Error("X2_PROTOCOL");
  const [primary, resource, code, reason, cleanup, reserved] = Array.from(
    { length: 6 },
    (_, i) => body.readUInt16BE(i * 2),
  );
  if (
    reserved !== 0 ||
    (internal
      ? cleanup !== 0 || ![10, 24].includes(primary)
      : ![1, 2].includes(cleanup) || (primary === 27 && cleanup !== 2))
  )
    throw new Error("X2_PROTOCOL");
  let failure: X2Failure;
  if (primary === 10) {
    if (
      resource !== 0 ||
      code < 1 ||
      code > 4 ||
      reason > 6 ||
      (code !== 2 && reason !== 0)
    )
      throw new Error("X2_PROTOCOL");
    if (code === 2)
      failure = {
        kind: "DOCUMENT",
        code: "UNSUPPORTED_DOCUMENT",
        reason: REASONS[reason],
      };
    else
      failure = {
        kind: "DOCUMENT",
        code:
          code === 1
            ? "INVALID_INPUT"
            : code === 3
              ? "LIMIT_EXCEEDED"
              : "INVALID_RESULT",
        reason: null,
      };
  } else if (primary === 23) {
    if (code !== 0 || reason !== 0 || resource < 1 || resource > 3)
      throw new Error("X2_PROTOCOL");
    failure = {
      kind: "EXECUTION",
      code: "RESOURCE_LIMIT",
      resource: resource === 1 ? "MEMORY" : resource === 2 ? "PIDS" : "CPU",
    };
  } else {
    if (
      resource !== 0 ||
      code !== 0 ||
      reason !== 0 ||
      !(primary in EXECUTIONS)
    )
      throw new Error("X2_PROTOCOL");
    failure = execution(primary as keyof typeof EXECUTIONS);
  }
  return { failure, primary, cleanup };
}

function positive(value: number, max = 2147483647): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}
function environment(c: X2NativeConfig): NodeJS.ProcessEnv | null {
  if (
    !c ||
    typeof c.runtimeRoot !== "string" ||
    !c.runtimeRoot.startsWith("/") ||
    c.runtimeRoot.includes("\0") ||
    c.runtimeRoot.split("/").some((s) => s === "." || s === "..") ||
    typeof c.runtimeSeal !== "string" ||
    !/^[a-f0-9]{64}$/.test(c.runtimeSeal) ||
    !positive(c.workerUid, 4294967294) ||
    !positive(c.workerGid, 4294967294) ||
    !positive(c.cpuPollMs) ||
    !positive(c.cleanupMs) ||
    !positive(c.pidsMax) ||
    c.pidsMax < 2
  )
    return null;
  for (const v of [c.memoryBytes, c.cpuQuotaUs, c.cpuPeriodUs, c.cpuBudgetNs])
    if (typeof v !== "bigint" || v <= 0n || v > 9223372036854775807n)
      return null;
  // The native side checks actual page alignment and kernel-effective values.
  return {
    X2_RUNTIME_ROOT: c.runtimeRoot,
    X2_RUNTIME_SEAL: c.runtimeSeal,
    X2_WORKER_UID: String(c.workerUid),
    X2_WORKER_GID: String(c.workerGid),
    X2_MEMORY_BYTES: String(c.memoryBytes),
    X2_CPU_QUOTA_US: String(c.cpuQuotaUs),
    X2_CPU_PERIOD_US: String(c.cpuPeriodUs),
    X2_CPU_BUDGET_NS: String(c.cpuBudgetNs),
    X2_CPU_POLL_MS: String(c.cpuPollMs),
    X2_PIDS_MAX: String(c.pidsMax),
    X2_CLEANUP_MS: String(c.cleanupMs),
  };
}

export function runCardStatementBinaryDocument(input: X2RunInput): X2RunHandle {
  const t0 = performance.now();
  let resolveResult!: (value: X2RunResult) => void;
  let resolveSettled!: (value: X2Settlement) => void;
  const result = new Promise<X2RunResult>((resolve) => {
    resolveResult = resolve;
  });
  const settled = new Promise<X2Settlement>((resolve) => {
    resolveSettled = resolve;
  });
  const handle = Object.freeze({ result, settled });
  const notStarted = (failure: X2Failure) => {
    resolveResult({ kind: "FAILURE", failure });
    resolveSettled({
      cleanup: "NOT_STARTED",
      nativeFailure: null,
      exitCode: null,
    });
    return handle;
  };
  const invalid = (
    code: "INVALID_INPUT" | "INVALID_RESULT" | "LIMIT_EXCEEDED",
  ) => notStarted({ kind: "DOCUMENT", code, reason: null });
  const expired = () => performance.now() - t0 >= X2_WIRE.deadlineMs;
  if (
    !input ||
    !input.document ||
    !Buffer.isBuffer(input.document.bytes) ||
    input.document.version !== 1 ||
    input.document.context !== "CARD_INVOICE" ||
    typeof input.tenantId !== "string" ||
    input.tenantId.trim().length === 0 ||
    input.tenantId.includes("\0") ||
    typeof input.originalSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.originalSha256)
  )
    return invalid("INVALID_INPUT");
  const d = input.document;
  const profile =
    d.format === "PDF" && d.profile === "PDF_TEXT_CARD"
      ? 1
      : d.format === "XLS" && d.profile === "XLS_CARD"
        ? 2
        : d.format === "XLSX" && d.profile === "XLSX_CARD"
          ? 3
          : 0;
  if (
    !profile ||
    Object.keys(d).sort().join(",") !== "bytes,context,format,profile,version"
  )
    return invalid("INVALID_INPUT");
  if (!d.bytes.length) return invalid("INVALID_INPUT");
  if (d.bytes.length > X2_WIRE.maxBytes) return invalid("LIMIT_EXCEEDED");
  if (input.signal?.aborted) return notStarted(execution(25));
  const env = environment(input.config);
  if (!env || platform() !== "linux") return notStarted(execution(20));
  if (expired()) return notStarted(execution(22));
  const bytes = Buffer.from(d.bytes);
  if (expired()) return notStarted(execution(22));
  if (createHash("sha256").update(bytes).digest("hex") !== input.originalSha256)
    return invalid("INVALID_RESULT");
  const tenant = createHash("sha256")
    .update("x2-tenant-v1\0")
    .update(input.tenantId)
    .digest();
  if (expired()) return notStarted(execution(22));

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("/usr/local/libexec/reformaflow-x2", [], {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
  } catch {
    return notStarted(execution(20));
  }
  const control = child.stdio[3];
  let finished = false;
  let resultResolved = false;
  let stopped = false;
  let wireFailed = false;
  let nonce: Buffer | null = null;
  let startQueued = false;
  let armed = false;
  let done = false;
  let dataEnded = false;
  let controlEnded = false;
  let output: Buffer | null = null;
  let native: ReturnType<typeof x2DecodeError> | null = null;
  const fail = (failure: X2Failure) => {
    stopped = true;
    if (!resultResolved) {
      resultResolved = true;
      resolveResult({ kind: "FAILURE", failure });
    }
  };
  const protocolError = () => {
    wireFailed = true;
    fail(execution(21));
    child.stdin?.end();
  };
  const cancel = (cause: 1 | 2) => {
    if (finished || resultResolved) return;
    fail(execution(cause === 1 ? 25 : 22));
    if (control instanceof Duplex && !control.destroyed) {
      const body = Buffer.alloc(18);
      nonce?.copy(body);
      body.writeUInt16BE(cause, 16);
      control.write(x2Frame(X2_WIRE.cancel, 0, body), () => child.stdin?.end());
    } else child.stdin?.end();
  };
  const aborted = () => cancel(1);
  const timer = setTimeout(
    () => cancel(2),
    Math.max(0, X2_WIRE.deadlineMs - (performance.now() - t0)),
  );
  input.signal?.addEventListener("abort", aborted, { once: true });
  const sendDocument = () => {
    const sink = child.stdin;
    if (!sink) return protocolError();
    const h = Buffer.alloc(12);
    h.write("X2N1", "ascii");
    h[4] = X2_WIRE.document;
    h[5] = profile;
    h.writeUInt32BE(bytes.length, 8);
    let offset = -1;
    const pump = () => {
      while (!stopped && !finished) {
        if (expired()) return cancel(2);
        if (offset >= bytes.length) {
          sink.end();
          return;
        }
        const chunk =
          offset === -1
            ? h
            : bytes.subarray(offset, Math.min(offset + 65536, bytes.length));
        offset = offset === -1 ? 0 : offset + chunk.length;
        if (!sink.write(chunk)) {
          sink.once("drain", pump);
          return;
        }
      }
    };
    pump();
  };
  const resultReader = new X2FrameReader(
    (kind, p, length) =>
      armed &&
      output === null &&
      kind === X2_WIRE.result &&
      p === profile &&
      length > 0 &&
      length <= X2_WIRE.maxBytes,
    (frame) => {
      if (!armed || output !== null) throw new Error("X2_PROTOCOL");
      output = frame.body;
    },
  );
  const controlReader = new X2FrameReader(
    (kind, _p, length) =>
      kind === X2_WIRE.error
        ? length === 12
        : (kind === X2_WIRE.hello ||
            kind === X2_WIRE.armed ||
            kind === X2_WIRE.done) &&
          length === 16,
    (frame) => {
      if (native || done) throw new Error("X2_PROTOCOL");
      if (frame.kind === X2_WIRE.error) {
        const decoded = x2DecodeError(frame.body, false);
        // Enqueued START cannot distinguish the two native phases before ARMED.
        const preStart =
          !armed &&
          frame.profile === 0 &&
          [20, 21, 22, 25, 26, 27].includes(decoded.primary);
        const postStart = startQueued && frame.profile === profile;
        if (!preStart && !postStart) throw new Error("X2_PROTOCOL");
        native = decoded;
        fail(decoded.failure);
        child.stdin?.end();
        return;
      }
      if (frame.kind === X2_WIRE.hello) {
        if (
          nonce ||
          frame.profile !== 0 ||
          frame.body.every((byte) => byte === 0)
        )
          throw new Error("X2_PROTOCOL");
        nonce = frame.body;
        if (stopped) return;
        if (expired()) return cancel(2);
        const start = Buffer.alloc(52);
        nonce.copy(start);
        tenant.copy(start, 16);
        start.writeUInt32BE(bytes.length, 48);
        startQueued = true;
        child.stdin?.write(x2Frame(X2_WIRE.start, profile, start));
      } else {
        if (
          !nonce ||
          !nonce.equals(frame.body) ||
          frame.profile !== profile ||
          !startQueued
        )
          throw new Error("X2_PROTOCOL");
        if (frame.kind === X2_WIRE.armed) {
          if (armed) throw new Error("X2_PROTOCOL");
          armed = true;
          if (!stopped) sendDocument();
        } else {
          if (!armed) throw new Error("X2_PROTOCOL");
          done = true;
        }
      }
    },
  );
  child.on("error", () => {
    fail(execution(20));
    if (!child.pid && !finished) {
      finished = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", aborted);
      resolveSettled({
        cleanup: "NOT_STARTED",
        nativeFailure: null,
        exitCode: null,
      });
    }
  });
  child.stdin?.on("error", () => {
    // Native ERROR may follow EPIPE on the independent control channel.
    stopped = true;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (native || wireFailed) return;
    try {
      resultReader.push(chunk);
    } catch {
      protocolError();
    }
  });
  child.stdout?.on("end", () => {
    dataEnded = true;
  });
  child.stdout?.on("error", protocolError);
  if (control instanceof Duplex && control.readable && control.writable) {
    control.on("data", (chunk: Buffer) => {
      if (wireFailed) return;
      try {
        controlReader.push(chunk);
      } catch {
        protocolError();
      }
    });
    control.on("end", () => {
      controlEnded = true;
      if (!controlReader.complete || (!native && !done)) protocolError();
    });
    control.on("error", protocolError);
  } else protocolError();
  child.on(
    "close",
    (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", aborted);
      let cleanup: X2Settlement["cleanup"] = "UNCONFIRMED";
      if (
        !wireFailed &&
        !signal &&
        controlEnded &&
        dataEnded &&
        controlReader.complete
      ) {
        if (native && exitCode === (native.cleanup === 2 ? 27 : native.primary))
          cleanup = native.cleanup === 2 ? "QUARANTINED" : "CLEAN";
        else if (
          !native &&
          done &&
          exitCode === 0 &&
          resultReader.complete &&
          output
        )
          cleanup = "CLEAN";
      }
      if (!resultResolved) {
        if (expired()) fail(execution(22));
        else if (native) fail(native.failure);
        // FD1 EOF alone cannot preempt a terminal ERROR still draining on FD3.
        else if (dataEnded && !resultReader.complete) fail(execution(21));
        else if (cleanup === "CLEAN" && output) {
          try {
            if (!isUtf8(output)) throw new Error("X2_PROTOCOL");
            const document = validateDocumentExtraction(
              JSON.parse(output.toString("utf8")),
            );
            if (document.parserVersion !== VERSIONS[profile])
              throw new Error("X2_PROTOCOL");
            if (expired()) fail(execution(22));
            else {
              resultResolved = true;
              resolveResult({ kind: "SUCCESS", document });
            }
          } catch {
            fail(execution(21));
          }
        } else fail(execution(wireFailed ? 21 : 24));
      }
      resolveSettled({
        cleanup,
        nativeFailure: native?.failure ?? null,
        exitCode,
      });
    },
  );
  if (input.signal?.aborted) aborted();
  if (expired()) cancel(2);
  return handle;
}
