import { isUtf8 } from "node:buffer";
import * as childProcess from "node:child_process";
import crypto = require("node:crypto");
import os = require("node:os");
import { performance as monotonicPerformance } from "node:perf_hooks";
import { Duplex, PassThrough, Writable } from "node:stream";
import {
  runCardStatementBinaryDocument,
  type X2Failure,
  type X2NativeConfig,
  type X2RunHandle,
  type X2RunInput,
  type X2RunResult,
  type X2Settlement,
} from "./statement-document.runner";
import { validateDocumentExtraction } from "./statement-document";
import type {
  CardStatementBinaryDocumentInputV1,
  DocumentExtractionV1,
} from "./types";

// ABI083 peer only: no launcher, parser invocation, DB, or isolation evidence.
jest.mock("child_process", () => {
  const actual: typeof childProcess = jest.requireActual("node:child_process");
  const forbidden = () => {
    throw new Error("Only the mocked X2 spawn is permitted in this spec");
  };
  return {
    ...actual,
    spawn: jest.fn(),
    spawnSync: jest.fn(forbidden),
    exec: jest.fn(forbidden),
    execSync: jest.fn(forbidden),
    execFile: jest.fn(forbidden),
    execFileSync: jest.fn(forbidden),
    fork: jest.fn(forbidden),
  };
});
jest.mock("node:child_process", () => jest.requireMock("child_process"));

const NONCE = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const OTHER_NONCE = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
const TENANT_KEY =
  "601f0579a77af18a82a32aefe656309f21652d4b89355cb7234133888a388d15";

// Syntactic fixture, NOT an approved resource profile or runtime seal.
function config(): X2NativeConfig {
  return {
    runtimeRoot: "/x2-qa/runtime",
    runtimeSeal: "ab".repeat(32),
    workerUid: 65534,
    workerGid: 65534,
    memoryBytes: 67108864n,
    cpuQuotaUs: 50000n,
    cpuPeriodUs: 100000n,
    cpuBudgetNs: 1000000000n,
    cpuPollMs: 10,
    pidsMax: 32,
    cleanupMs: 1000,
  };
}

function input(
  profile: 1 | 2 | 3 = 1,
  bytes = Buffer.from("synthetic-document"),
  signal?: AbortSignal,
): X2RunInput {
  const common = { version: 1, context: "CARD_INVOICE", bytes } as const;
  const document: CardStatementBinaryDocumentInputV1 =
    profile === 1
      ? { ...common, format: "PDF", profile: "PDF_TEXT_CARD" }
      : profile === 2
        ? { ...common, format: "XLS", profile: "XLS_CARD" }
        : { ...common, format: "XLSX", profile: "XLSX_CARD" };
  return {
    document,
    originalSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    tenantId: "x2-native-qa-tenant",
    config: config(),
    signal,
  };
}

function dto(profile: 1 | 2 | 3 = 1, raw = "LOJA"): DocumentExtractionV1 {
  return {
    version: 1,
    parserVersion:
      profile === 1
        ? "card-local-pdf-v1"
        : profile === 2
          ? "card-local-xls-v1"
          : "card-local-xlsx-v1",
    documentKind: "INVOICE",
    invoiceDueMonth: null,
    metrics: {
      pages: profile === 1 ? 1 : 0,
      rows: 1,
      expandedBytes: 0,
      archiveEntries: profile === 1 ? 0 : 1,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: [
      {
        reference:
          profile === 1
            ? "pdf:page:1:line:1"
            : profile === 2
              ? "xls:sheet:1:row:1"
              : "xlsx:sheet:1:row:1",
        sourceOrdinal: 0,
        section: "UNKNOWN",
        raw: {
          date: null,
          description: raw,
          amount: "206,96",
          installment: null,
        },
        cycle: null,
        dateOnly: null,
        merchant: "LOJA",
        amountCents: 20696,
        amountMeaning: "UNKNOWN",
        installmentCount: null,
        installmentIndex: null,
        fitId: null,
        identityOrdinal: null,
      },
    ],
    diagnostics: [],
  };
}

function frame(
  kind: number,
  profile: number,
  body: Buffer,
  length = body.length,
) {
  const header = Buffer.alloc(12);
  header.write("X2N1", 0, "ascii");
  header.writeUInt8(kind, 4);
  header.writeUInt8(profile, 5);
  header.writeUInt32BE(length, 8);
  return Buffer.concat([header, body]);
}

type ErrorWords = readonly [number, number, number, number, number, number];

function errorFrame(profile: number, words: ErrorWords) {
  const body = Buffer.alloc(12);
  words.forEach((word, index) => body.writeUInt16BE(word, index * 2));
  return frame(7, profile, body);
}

function execution(
  code:
    | "UNAVAILABLE"
    | "PROTOCOL_ERROR"
    | "DEADLINE"
    | "WORKER_FAILED"
    | "CANCELLED"
    | "CALLER_GONE"
    | "QUARANTINED"
    | "BUSY",
): X2Failure {
  return { kind: "EXECUTION", code, resource: null };
}

function failure(value: X2Failure): X2RunResult {
  return { kind: "FAILURE", failure: value };
}

function observe<T>(promise: Promise<T>) {
  const values: T[] = [];
  void promise.then((value) => values.push(value));
  return values;
}

async function turn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class DocumentSink extends Writable {
  readonly chunks: Buffer[] = [];
  submittedBytes = 0;
  acceptedBytes = 0;
  stopAfter = Infinity;

  constructor() {
    super({ highWaterMark: 16 });
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ) {
    this.submittedBytes += chunk.length;
    const accepted = Math.max(
      0,
      Math.min(chunk.length, this.stopAfter - this.acceptedBytes),
    );
    this.chunks.push(Buffer.from(chunk.subarray(0, accepted)));
    this.acceptedBytes += accepted;
    if (this.acceptedBytes < this.stopAfter) callback();
    // Holding the callback models a native reader blocked mid-DOCUMENT.
  }

  bytes() {
    return Buffer.concat(this.chunks);
  }
}

class ControlChannel extends Duplex {
  readonly sent: Buffer[] = [];
  holdWrites = false;
  held: ((error?: Error) => void) | undefined;

  _read() {}

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ) {
    this.sent.push(Buffer.from(chunk));
    if (this.holdWrites) this.held = callback;
    else callback();
  }

  bytes() {
    return Buffer.concat(this.sent);
  }
}

class NativePeer extends childProcess.ChildProcess {
  readonly stdin = new DocumentSink();
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly control = new ControlChannel();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = jest.fn(() => true);

  constructor() {
    super();
    Object.defineProperty(this, "pid", { value: 424242 });
    // Node's typings reserve five entries; this invocation has only four FDs.
    Object.defineProperty(this, "stdio", {
      value: [this.stdin, this.stdout, null, this.control],
    });
  }

  sendControl(bytes: Buffer) {
    this.control.push(bytes);
  }

  async hello() {
    this.sendControl(frame(1, 0, NONCE));
    await turn();
  }

  async armed(profile = 1) {
    this.sendControl(frame(3, profile, NONCE));
    await turn();
  }

  async ready(profile = 1) {
    await this.hello();
    await this.armed(profile);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin.destroy();
    this.emit("exit", code, signal);
  }

  async close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exit(code, signal);
    this.stdout.end();
    this.control.push(null);
    await turn();
    this.emit("close", code, signal);
    await turn();
  }

  async success(profile: 1 | 2 | 3 = 1, document = dto(profile)) {
    this.stdout.write(frame(5, profile, Buffer.from(JSON.stringify(document))));
    this.sendControl(frame(6, profile, NONCE));
    await this.close(0);
  }

  dispose() {
    this.stdin.destroy();
    this.stdout.destroy();
    this.control.destroy();
  }
}

describe("X2 native runner / private ABI083 (synthetic peer, not Linux)", () => {
  let peer: NativePeer;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const spawn = jest.mocked(childProcess.spawn);
  const originalMonotonicNow = monotonicPerformance.now;

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date("2026-10-08T12:00:00.000Z"),
      doNotFake: ["nextTick", "setImmediate"],
    });
    jest
      .spyOn(monotonicPerformance, "now")
      .mockImplementation(
        globalThis.performance.now.bind(globalThis.performance),
      );
    Object.defineProperty(process, "platform", { value: "linux" });
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("No real PID may be signalled by a protocol spec");
    });
    peer = new NativePeer();
    spawn.mockReset().mockImplementation(() => {
      const child = peer;
      setImmediate(() => child.emit("spawn"));
      return child;
    });
  });

  afterEach(() => {
    peer.dispose();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    expect(monotonicPerformance.now).toBe(originalMonotonicNow);
    if (platform) Object.defineProperty(process, "platform", platform);
  });

  async function expectLocal(handle: X2RunHandle, expected: X2Failure) {
    await expect(handle.result).resolves.toEqual(failure(expected));
    await expect(handle.settled).resolves.toEqual({
      cleanup: "NOT_STARTED",
      nativeFailure: null,
      exitCode: null,
    });
    expect(spawn).not.toHaveBeenCalled();
  }

  async function expectProtocol(handle: X2RunHandle) {
    await peer.close(21);
    await expect(handle.result).resolves.toEqual(
      failure(execution("PROTOCOL_ERROR")),
    );
    expect((await handle.settled).cleanup).not.toBe("CLEAN");
  }

  it("exports the actual function and returns two typed promises, not a Promise handle", async () => {
    expect(typeof runCardStatementBinaryDocument).toBe("function");
    const handle: X2RunHandle = runCardStatementBinaryDocument(input());
    expect(handle.result).toBeInstanceOf(Promise);
    expect(handle.settled).toBeInstanceOf(Promise);
    expect(handle).not.toBeInstanceOf(Promise);
    await peer.ready();
    await peer.success();
    await expect(handle.result).resolves.toEqual({
      kind: "SUCCESS",
      document: dto(),
    });
  });

  it.each([
    ["runtimeRoot", ""],
    ["runtimeRoot", "relative"],
    ["runtimeSeal", ""],
    ["runtimeSeal", "a".repeat(63)],
    ["runtimeSeal", "g".repeat(64)],
    ["workerUid", 0],
    ["workerUid", -1],
    ["workerUid", 1.5],
    ["workerUid", 4294967296],
    ["workerGid", 0],
    ["memoryBytes", 0n],
    ["memoryBytes", -1n],
    ["memoryBytes", 9223372036854775808n],
    ["memoryBytes", 18446744073709551616n],
    ["cpuQuotaUs", -1n],
    ["cpuQuotaUs", 0n],
    ["cpuPeriodUs", 0n],
    ["cpuBudgetNs", 0n],
    ["cpuPollMs", 0],
    ["cpuPollMs", Infinity],
    ["pidsMax", 1],
    ["pidsMax", 2.5],
    ["pidsMax", Number.MAX_SAFE_INTEGER + 1],
    ["cleanupMs", 0],
    ["cleanupMs", -1],
    ["cleanupMs", NaN],
    ["workerUid", "65534"],
    ["memoryBytes", "67108864"],
    ["cpuQuotaUs", " 50000"],
    ["cpuPollMs", "+10"],
  ])(
    "missing_or_invalid_policy_starts_no_worker: %s=%s",
    async (key, value) => {
      const request = input();
      Reflect.set(request.config, key, value);
      await expectLocal(
        runCardStatementBinaryDocument(request),
        execution("UNAVAILABLE"),
      );
    },
  );

  it.each([
    [4097n, "4097"],
    [9223372036854775807n, "9223372036854775807"],
  ] as const)(
    "memory policy forwarding %s is refused natively before HELLO",
    async (memoryBytes, decimal) => {
      const handle = runCardStatementBinaryDocument({
        ...input(),
        config: { ...config(), memoryBytes },
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][2]?.env?.X2_MEMORY_BYTES).toBe(decimal);
      expect(peer.stdin.bytes()).toHaveLength(0);
      peer.sendControl(errorFrame(0, [20, 0, 0, 0, 1, 0]));
      await peer.close(20);
      await expect(handle.result).resolves.toEqual(
        failure(execution("UNAVAILABLE")),
      );
      await expect(handle.settled).resolves.toEqual({
        cleanup: "CLEAN",
        nativeFailure: execution("UNAVAILABLE"),
        exitCode: 20,
      });
      expect(peer.stdin.bytes()).toHaveLength(0);
    },
  );

  it.each([
    "runtimeRoot",
    "runtimeSeal",
    "workerUid",
    "workerGid",
    "memoryBytes",
    "cpuQuotaUs",
    "cpuPeriodUs",
    "cpuBudgetNs",
    "cpuPollMs",
    "pidsMax",
    "cleanupMs",
  ])("missing policy %s has no default", async (key) => {
    const request = input();
    Reflect.deleteProperty(request.config, key);
    await expectLocal(
      runCardStatementBinaryDocument(request),
      execution("UNAVAILABLE"),
    );
  });

  it.each([
    ["version", 2],
    ["context", "BANK_STATEMENT"],
    ["format", "CSV"],
    ["profile", "XLS_CARD"],
    ["bytes", new Uint8Array([1])],
  ])("rejects malformed X2 document %s before spawn", async (key, value) => {
    const request = input();
    Reflect.set(request.document, key, value);
    await expectLocal(runCardStatementBinaryDocument(request), {
      kind: "DOCUMENT",
      code: "INVALID_INPUT",
      reason: null,
    });
  });

  it.each([
    "",
    "a".repeat(63),
    "A".repeat(64),
    "g".repeat(64),
    ` ${"a".repeat(64)}`,
  ])("rejects malformed originalSha256 %s", async (originalSha256) => {
    await expectLocal(
      runCardStatementBinaryDocument({ ...input(), originalSha256 }),
      {
        kind: "DOCUMENT",
        code: "INVALID_INPUT",
        reason: null,
      },
    );
  });

  it("hash mismatch is INVALID_RESULT before spawn, not an empty extraction", async () => {
    await expectLocal(
      runCardStatementBinaryDocument({
        ...input(),
        originalSha256: "0".repeat(64),
      }),
      { kind: "DOCUMENT", code: "INVALID_RESULT", reason: null },
    );
  });

  it("empty server tenant identity is INVALID_INPUT before spawn", async () => {
    await expectLocal(
      runCardStatementBinaryDocument({ ...input(), tenantId: "" }),
      { kind: "DOCUMENT", code: "INVALID_INPUT", reason: null },
    );
  });

  it("already aborted is CANCELLED without spawn", async () => {
    const abort = new AbortController();
    abort.abort();
    await expectLocal(
      runCardStatementBinaryDocument(input(1, undefined, abort.signal)),
      execution("CANCELLED"),
    );
  });

  it("zero document is INVALID_INPUT, either locally or before native ARMED", async () => {
    const handle = runCardStatementBinaryDocument(input(1, Buffer.alloc(0)));
    const expected: X2Failure = {
      kind: "DOCUMENT",
      code: "INVALID_INPUT",
      reason: null,
    };
    if (spawn.mock.calls.length === 0) {
      await expectLocal(handle, expected);
    } else {
      await peer.hello();
      expect(peer.stdin.bytes().readUInt32BE(60)).toBe(0);
      expect(peer.stdin.bytes()).toHaveLength(64);
      peer.sendControl(errorFrame(1, [10, 0, 1, 0, 1, 0]));
      await peer.close(10);
      await expect(handle.result).resolves.toEqual(failure(expected));
      await expect(handle.settled).resolves.toEqual({
        cleanup: "CLEAN",
        nativeFailure: expected,
        exitCode: 10,
      });
    }
  });

  it("document boundary 10485761 is rejected before copying or spawn", async () => {
    const request = input(1, Buffer.alloc(10485761, 65));
    const copy = jest.spyOn(Buffer, "from");
    const handle = runCardStatementBinaryDocument(request);
    expect(
      copy.mock.calls.some(([source]) =>
        Object.is(source, request.document.bytes),
      ),
    ).toBe(false);
    await expectLocal(handle, {
      kind: "DOCUMENT",
      code: "LIMIT_EXCEEDED",
      reason: null,
    });
  });

  it.each([10485759, 10485760])(
    "document boundary %i transports exact bytes; peer still decides validity",
    async (length) => {
      const bytes = Buffer.alloc(length, 65);
      const handle = runCardStatementBinaryDocument(input(1, bytes));
      await peer.ready();
      const sent = peer.stdin.bytes();
      expect(sent.subarray(0, 12).toString("hex")).toBe(
        "58324e310201000000000034",
      );
      expect(sent.readUInt32BE(60)).toBe(length);
      expect(sent.subarray(64, 72).toString("hex")).toBe("58324e3104010000");
      expect(sent.readUInt32BE(72)).toBe(length);
      const body = sent.subarray(76);
      expect(Buffer.isBuffer(body)).toBe(true);
      expect(body.length).toBe(length);
      expect(body.equals(bytes)).toBe(true);
      expect(peer.stdin.writableFinished).toBe(true);
      peer.sendControl(errorFrame(1, [10, 0, 2, 6, 1, 0]));
      await peer.close(10);
      await expect(handle.result).resolves.toEqual(
        failure({
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "CORRUPT_DOCUMENT",
        }),
      );
    },
  );

  it("private snapshot is made synchronously before caller mutation and HELLO", async () => {
    const request = input();
    const expected = Buffer.from(request.document.bytes);
    const handle = runCardStatementBinaryDocument(request);
    request.document.bytes.fill(90);
    await peer.ready();
    expect(peer.stdin.bytes().subarray(76)).toEqual(expected);
    await peer.success();
    await expect(handle.result).resolves.toEqual({
      kind: "SUCCESS",
      document: dto(),
    });
  });

  it("spawns only the fixed executable, empty argv, clean allowlisted env and duplex FD3", async () => {
    const handle = runCardStatementBinaryDocument(input());
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawn.mock.calls[0];
    expect(file).toBe("/usr/local/libexec/reformaflow-x2");
    expect(args).toEqual([]);
    expect(options?.shell ?? false).toBe(false);
    expect(options?.stdio).toEqual(["pipe", "pipe", "ignore", "pipe"]);
    expect(peer.stdio).toEqual([peer.stdin, peer.stdout, null, peer.control]);
    expect(options?.env).toEqual({
      X2_RUNTIME_ROOT: "/x2-qa/runtime",
      X2_RUNTIME_SEAL: "ab".repeat(32),
      X2_WORKER_UID: "65534",
      X2_WORKER_GID: "65534",
      X2_MEMORY_BYTES: "67108864",
      X2_CPU_QUOTA_US: "50000",
      X2_CPU_PERIOD_US: "100000",
      X2_CPU_BUDGET_NS: "1000000000",
      X2_CPU_POLL_MS: "10",
      X2_PIDS_MAX: "32",
      X2_CLEANUP_MS: "1000",
    });
    await peer.ready();
    await peer.success();
    await expect(handle.result).resolves.toEqual({
      kind: "SUCCESS",
      document: dto(),
    });
  });

  it.each([1, 2, 3] as const)(
    "wire codes 1..6 and fixed profile %i",
    async (profile) => {
      const bytes = Buffer.from("abc");
      const handle = runCardStatementBinaryDocument(input(profile, bytes));
      expect(peer.stdin.bytes()).toHaveLength(0);
      await peer.hello();
      const start = peer.stdin.bytes();
      expect(start).toEqual(
        Buffer.from(
          `58324e31020${profile}00000000003400112233445566778899aabbccddeeff${TENANT_KEY}00000003`,
          "hex",
        ),
      );
      expect(peer.control.bytes()).toHaveLength(0);
      await peer.armed(profile);
      expect(peer.stdin.bytes().subarray(64)).toEqual(
        Buffer.from(`58324e31040${profile}000000000003616263`, "hex"),
      );
      expect(peer.stdin.writableFinished).toBe(true);
      const document = validateDocumentExtraction(dto(profile));
      await peer.success(profile, document);
      await expect(handle.result).resolves.toEqual({
        kind: "SUCCESS",
        document,
      });
      await expect(handle.settled).resolves.toEqual({
        cleanup: "CLEAN",
        nativeFailure: null,
        exitCode: 0,
      });
      expect(peer.control.bytes()).toHaveLength(0);
    },
  );

  it.each([1, 4, 5, 6, 8, 11, 12, 27])(
    "partial HELLO/ARMED headers and bodies split at %i do not advance early",
    async (split) => {
      const handle = runCardStatementBinaryDocument(input());
      const hello = frame(1, 0, NONCE);
      peer.sendControl(hello.subarray(0, split));
      await turn();
      expect(peer.stdin.bytes()).toHaveLength(0);
      peer.sendControl(hello.subarray(split));
      await turn();
      expect(peer.stdin.bytes()).toHaveLength(64);
      const armed = frame(3, 1, NONCE);
      peer.sendControl(armed.subarray(0, split));
      await turn();
      expect(peer.stdin.bytes()).toHaveLength(64);
      peer.sendControl(armed.subarray(split));
      await turn();
      expect(peer.stdin.bytes().subarray(76).toString()).toBe(
        "synthetic-document",
      );
      await peer.success();
      await expect(handle.result).resolves.toEqual({
        kind: "SUCCESS",
        document: dto(),
      });
    },
  );

  it.each([
    [
      "bad magic",
      Buffer.from(
        "59324e31010000000000001000112233445566778899aabbccddeeff",
        "hex",
      ),
    ],
    [
      "reserved",
      Buffer.from(
        "58324e31010000010000001000112233445566778899aabbccddeeff",
        "hex",
      ),
    ],
    ["zero nonce", frame(1, 0, Buffer.alloc(16))],
    ["profile 1", frame(1, 1, NONCE)],
    ["profile 4", frame(1, 4, NONCE)],
    ["profile 255", frame(1, 255, NONCE)],
    ["short nonce", frame(1, 0, NONCE.subarray(0, 15))],
    ["long nonce", frame(1, 0, Buffer.alloc(17, 1))],
  ])(
    "protocol_has_exact_lengths_profiles_and_order: %s",
    async (_name, bytes) => {
      const handle = runCardStatementBinaryDocument(input());
      peer.sendControl(bytes);
      await expectProtocol(handle);
      expect(peer.stdin.bytes()).toHaveLength(0);
    },
  );

  it.each([0, 2, 3, 4, 5, 6, 8, 9, 10, 11, 255])(
    "kind %i cannot replace HELLO (9/10 are worker-only, never external)",
    async (kind) => {
      const handle = runCardStatementBinaryDocument(input());
      peer.sendControl(frame(kind, 0, Buffer.alloc(0)));
      await expectProtocol(handle);
      expect(peer.stdin.bytes()).toHaveLength(0);
    },
  );

  it.each([
    ["nonce mismatch", frame(3, 1, OTHER_NONCE)],
    ["zero nonce after START", frame(3, 1, Buffer.alloc(16))],
    ["wrong profile", frame(3, 2, NONCE)],
    ["duplicate HELLO", frame(1, 0, NONCE)],
    ["early DONE", frame(6, 1, NONCE)],
  ])("invalid ARMED barrier: %s", async (_name, bytes) => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.hello();
    peer.sendControl(bytes);
    await expectProtocol(handle);
    expect(peer.stdin.bytes()).toHaveLength(64);
  });

  it.each([
    [9, "FD1"],
    [9, "FD3"],
    [10, "FD1"],
    [10, "FD3"],
  ] as const)(
    "worker-only kind %i with correct internal shape is forbidden on %s",
    async (kind, channel) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      const bytes = frame(kind, 1, Buffer.alloc(0));
      if (channel === "FD1") peer.stdout.write(bytes);
      else peer.sendControl(bytes);
      await expectProtocol(handle);
    },
  );

  it.each([0, 11, 255])(
    "unknown kind %i is also rejected after ARMED",
    async (kind) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.sendControl(frame(kind, 1, Buffer.alloc(0)));
      await expectProtocol(handle);
    },
  );

  it.each(["HELLO on FD1", "RESULT on FD3", "ERROR on FD1"])(
    "rejects wrong channel: %s",
    async (name) => {
      const handle = runCardStatementBinaryDocument(input());
      if (name === "HELLO on FD1") peer.stdout.write(frame(1, 0, NONCE));
      else {
        await peer.ready();
        if (name === "RESULT on FD3")
          peer.sendControl(frame(5, 1, Buffer.from(JSON.stringify(dto()))));
        else peer.stdout.write(errorFrame(1, [24, 0, 0, 0, 1, 0]));
      }
      await expectProtocol(handle);
    },
  );

  const errors: readonly (readonly [string, ErrorWords, number, X2Failure])[] =
    [
      [
        "INVALID_INPUT",
        [10, 0, 1, 0, 1, 0],
        10,
        { kind: "DOCUMENT", code: "INVALID_INPUT", reason: null },
      ],
      [
        "LIMIT_EXCEEDED",
        [10, 0, 3, 0, 1, 0],
        10,
        { kind: "DOCUMENT", code: "LIMIT_EXCEEDED", reason: null },
      ],
      [
        "INVALID_RESULT",
        [10, 0, 4, 0, 1, 0],
        10,
        { kind: "DOCUMENT", code: "INVALID_RESULT", reason: null },
      ],
      [
        "UNSUPPORTED no reason",
        [10, 0, 2, 0, 1, 0],
        10,
        { kind: "DOCUMENT", code: "UNSUPPORTED_DOCUMENT", reason: null },
      ],
      [
        "PASSWORD_PROTECTED",
        [10, 0, 2, 1, 1, 0],
        10,
        {
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "PASSWORD_PROTECTED",
        },
      ],
      [
        "NO_TEXT_LAYER",
        [10, 0, 2, 2, 1, 0],
        10,
        {
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "NO_TEXT_LAYER",
        },
      ],
      [
        "UNSUPPORTED_LAYOUT",
        [10, 0, 2, 3, 1, 0],
        10,
        {
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "UNSUPPORTED_LAYOUT",
        },
      ],
      [
        "MULTIPLE_SHEETS",
        [10, 0, 2, 4, 1, 0],
        10,
        {
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "MULTIPLE_SHEETS",
        },
      ],
      [
        "UNSUPPORTED_CONTAINER",
        [10, 0, 2, 5, 1, 0],
        10,
        {
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "UNSUPPORTED_CONTAINER",
        },
      ],
      [
        "CORRUPT_DOCUMENT",
        [10, 0, 2, 6, 1, 0],
        10,
        {
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "CORRUPT_DOCUMENT",
        },
      ],
      ["UNAVAILABLE", [20, 0, 0, 0, 1, 0], 20, execution("UNAVAILABLE")],
      ["PROTOCOL_ERROR", [21, 0, 0, 0, 1, 0], 21, execution("PROTOCOL_ERROR")],
      ["DEADLINE", [22, 0, 0, 0, 1, 0], 22, execution("DEADLINE")],
      [
        "MEMORY",
        [23, 1, 0, 0, 1, 0],
        23,
        { kind: "EXECUTION", code: "RESOURCE_LIMIT", resource: "MEMORY" },
      ],
      [
        "PIDS",
        [23, 2, 0, 0, 1, 0],
        23,
        { kind: "EXECUTION", code: "RESOURCE_LIMIT", resource: "PIDS" },
      ],
      [
        "CPU",
        [23, 3, 0, 0, 1, 0],
        23,
        { kind: "EXECUTION", code: "RESOURCE_LIMIT", resource: "CPU" },
      ],
      ["WORKER_FAILED", [24, 0, 0, 0, 1, 0], 24, execution("WORKER_FAILED")],
      ["CANCELLED", [25, 0, 0, 0, 1, 0], 25, execution("CANCELLED")],
      ["CALLER_GONE", [26, 0, 0, 0, 1, 0], 26, execution("CALLER_GONE")],
      ["QUARANTINED", [27, 0, 0, 0, 2, 0], 27, execution("QUARANTINED")],
      ["BUSY", [28, 0, 0, 0, 1, 0], 28, execution("BUSY")],
      [
        "document cause survives quarantine",
        [10, 0, 2, 2, 2, 0],
        27,
        {
          kind: "DOCUMENT",
          code: "UNSUPPORTED_DOCUMENT",
          reason: "NO_TEXT_LAYER",
        },
      ],
      [
        "CPU cause survives quarantine",
        [23, 3, 0, 0, 2, 0],
        27,
        { kind: "EXECUTION", code: "RESOURCE_LIMIT", resource: "CPU" },
      ],
    ];

  it.each(errors)(
    "wire_codes_and_error_vectors_are_literal: %s",
    async (_name, words, exit, expected) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.sendControl(errorFrame(1, words));
      await peer.close(exit);
      await expect(handle.result).resolves.toEqual(failure(expected));
      await expect(handle.settled).resolves.toEqual({
        cleanup: exit === 27 ? "QUARANTINED" : "CLEAN",
        nativeFailure: expected,
        exitCode: exit,
      });
    },
  );

  it("accepts the architect's literal NO_TEXT_LAYER vector, not a derived enum", async () => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.sendControl(
      Buffer.from("58324e31070100000000000c000a00000002000200010000", "hex"),
    );
    await peer.close(10);
    await expect(handle.result).resolves.toEqual(
      failure({
        kind: "DOCUMENT",
        code: "UNSUPPORTED_DOCUMENT",
        reason: "NO_TEXT_LAYER",
      }),
    );
  });

  it.each([
    [0, 0, 0, 0, 1, 0],
    [29, 0, 0, 0, 1, 0],
    [10, 1, 1, 0, 1, 0],
    [10, 0, 0, 0, 1, 0],
    [10, 0, 5, 0, 1, 0],
    [10, 0, 1, 1, 1, 0],
    [10, 0, 3, 1, 1, 0],
    [10, 0, 4, 1, 1, 0],
    [10, 0, 2, 7, 1, 0],
    [23, 0, 0, 0, 1, 0],
    [23, 4, 0, 0, 1, 0],
    [23, 1, 1, 0, 1, 0],
    [23, 1, 0, 1, 1, 0],
    [24, 1, 0, 0, 1, 0],
    [24, 0, 1, 0, 1, 0],
    [24, 0, 0, 1, 1, 0],
    [24, 0, 0, 0, 0, 0],
    [24, 0, 0, 0, 3, 0],
    [24, 0, 0, 0, 1, 1],
    [27, 0, 0, 0, 1, 0],
  ] satisfies ErrorWords[])(
    "rejects illegal six-u16 ERROR %j/%j/%j/%j/%j/%j",
    async (...words) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.sendControl(errorFrame(1, words));
      await expectProtocol(handle);
    },
  );

  it.each([11, 13])("ERROR length %i is not six u16", async (length) => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.sendControl(frame(7, 1, Buffer.alloc(length)));
    await expectProtocol(handle);
  });

  it.each([
    [20, "UNAVAILABLE"],
    [21, "PROTOCOL_ERROR"],
    [22, "DEADLINE"],
    [25, "CANCELLED"],
    [26, "CALLER_GONE"],
    [27, "QUARANTINED"],
  ] as const)(
    "pre-HELLO ERROR profile 0 allows primary %i",
    async (primary, code) => {
      const handle = runCardStatementBinaryDocument(input());
      peer.sendControl(
        errorFrame(0, [primary, 0, 0, 0, primary === 27 ? 2 : 1, 0]),
      );
      await peer.close(primary);
      await expect(handle.result).resolves.toEqual(failure(execution(code)));
      expect(peer.stdin.bytes()).toHaveLength(0);
    },
  );

  it.each([
    [1, 20, 0],
    [0, 10, 1],
    [0, 23, 0],
    [0, 24, 0],
    [0, 28, 0],
  ])(
    "pre-HELLO rejects ERROR profile=%i primary=%i document=%i",
    async (profile, primary, document) => {
      const handle = runCardStatementBinaryDocument(input());
      peer.sendControl(errorFrame(profile, [primary, 0, document, 0, 1, 0]));
      await expectProtocol(handle);
    },
  );

  it("after ARMED, ERROR profile 0 is invalid", async () => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.sendControl(errorFrame(0, [20, 0, 0, 0, 1, 0]));
    await expectProtocol(handle);
  });

  it.each([0, 1])(
    "START queued is not acceptance: cancellation before ARMED allows native ERROR profile %i",
    async (profile) => {
      const abort = new AbortController();
      const handle = runCardStatementBinaryDocument(
        input(1, undefined, abort.signal),
      );
      await peer.hello();
      expect(peer.stdin.bytes()).toHaveLength(64);
      abort.abort();
      await turn();
      expect(peer.control.bytes()).toEqual(
        Buffer.from(
          "58324e31080000000000001200112233445566778899aabbccddeeff0001",
          "hex",
        ),
      );
      await expect(handle.result).resolves.toEqual(
        failure(execution("CANCELLED")),
      );
      peer.sendControl(errorFrame(profile, [25, 0, 0, 0, 1, 0]));
      await peer.close(25);
      await expect(handle.settled).resolves.toEqual({
        cleanup: "CLEAN",
        nativeFailure: execution("CANCELLED"),
        exitCode: 25,
      });
      expect(peer.stdin.bytes()).toHaveLength(64);
    },
  );

  it("cancel_before_hello_uses_prestart_nonce_only: literal kind 8, cause 1, zero nonce", async () => {
    const abort = new AbortController();
    const handle = runCardStatementBinaryDocument(
      input(1, undefined, abort.signal),
    );
    abort.abort();
    await turn();
    expect(peer.control.bytes()).toEqual(
      Buffer.from(
        "58324e310800000000000012000000000000000000000000000000000001",
        "hex",
      ),
    );
    expect(peer.stdin.bytes()).toHaveLength(0);
    peer.sendControl(errorFrame(0, [25, 0, 0, 0, 1, 0]));
    await peer.close(25);
    await expect(handle.result).resolves.toEqual(
      failure(execution("CANCELLED")),
    );
    await expect(handle.settled).resolves.toEqual({
      cleanup: "CLEAN",
      nativeFailure: execution("CANCELLED"),
      exitCode: 25,
    });
  });

  it.each([1, 2] as const)(
    "cancel_interrupts_partial_document_without_inline_frame: cause %i",
    async (cause) => {
      const abort = new AbortController();
      peer.stdin.stopAfter = 80;
      const handle = runCardStatementBinaryDocument(
        input(1, Buffer.alloc(10485760, 65), abort.signal),
      );
      await peer.ready();
      expect(peer.stdin.acceptedBytes).toBe(80);
      expect(peer.stdin.writableNeedDrain).toBe(true);
      const submitted = peer.stdin.submittedBytes;
      if (cause === 1) abort.abort();
      else jest.advanceTimersByTime(60000);
      await turn();
      const primary = cause === 1 ? 25 : 22;
      const expected = execution(cause === 1 ? "CANCELLED" : "DEADLINE");
      expect(peer.control.bytes()).toEqual(
        Buffer.from(
          `58324e31080000000000001200112233445566778899aabbccddeeff000${cause}`,
          "hex",
        ),
      );
      expect(peer.stdin.submittedBytes).toBe(submitted);
      expect(peer.kill).not.toHaveBeenCalled();
      expect(peer.stdin.bytes().subarray(76).toString()).toBe("AAAA");
      await expect(handle.result).resolves.toEqual(failure(expected));
      peer.sendControl(errorFrame(1, [primary, 0, 0, 0, 1, 0]));
      await peer.close(primary);
      await expect(handle.settled).resolves.toEqual({
        cleanup: "CLEAN",
        nativeFailure: expected,
        exitCode: primary,
      });
    },
  );

  it("attempts control completion before closing DOCUMENT and does not claim failed CANCEL delivery", async () => {
    const abort = new AbortController();
    peer.stdin.stopAfter = 80;
    peer.control.holdWrites = true;
    const handle = runCardStatementBinaryDocument(
      input(1, Buffer.alloc(1024, 65), abort.signal),
    );
    await peer.ready();
    abort.abort();
    await turn();
    expect(peer.control.bytes()).toHaveLength(30);
    expect(peer.stdin.writableEnded).toBe(false);
    expect(peer.stdin.destroyed).toBe(false);
    expect(peer.control.held).toBeDefined();
    peer.control.held?.(new Error("synthetic control write failure"));
    await peer.close(null, "SIGKILL");
    await expect(handle.result).resolves.toEqual(
      failure(execution("CANCELLED")),
    );
    await expect(handle.settled).resolves.toEqual({
      cleanup: "UNCONFIRMED",
      nativeFailure: null,
      exitCode: null,
    });
  });

  it.each([59999, 60000, 60001])(
    "parent deadline exact acceptance boundary %i ms",
    async (elapsed) => {
      const monotonicStart = monotonicPerformance.now();
      const timerStart = globalThis.performance.now();
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      jest.advanceTimersByTime(elapsed);
      const sample = {
        timerDeltaMs: globalThis.performance.now() - timerStart,
        monotonicDeltaMs: monotonicPerformance.now() - monotonicStart,
      };
      console.info("X2 clock coupling", { expectedMs: elapsed, ...sample });
      expect(sample).toEqual({
        timerDeltaMs: elapsed,
        monotonicDeltaMs: elapsed,
      });
      await peer.success();
      await expect(handle.result).resolves.toEqual(
        elapsed === 59999
          ? { kind: "SUCCESS", document: dto() }
          : failure(execution("DEADLINE")),
      );
      if (elapsed >= 60000)
        expect(peer.control.bytes()).toEqual(
          Buffer.from(
            "58324e31080000000000001200112233445566778899aabbccddeeff0002",
            "hex",
          ),
        );
    },
  );

  it.each([59999, 60000, 60001])(
    "parent_deadline_starts_before_hash_and_spawn: hash ends at %i ms",
    async (elapsed) => {
      const request = input();
      const realCreateHash = crypto.createHash;
      jest
        .spyOn(crypto, "createHash")
        .mockImplementationOnce((algorithm, options) => {
          jest.advanceTimersByTime(elapsed);
          return realCreateHash(algorithm, options);
        });
      const handle = runCardStatementBinaryDocument(request);
      if (elapsed === 59999) {
        await peer.ready();
        await peer.success();
        await expect(handle.result).resolves.toEqual({
          kind: "SUCCESS",
          document: dto(),
        });
      } else {
        await expectLocal(handle, execution("DEADLINE"));
      }
    },
  );

  it("handshake and byte progress do not renew the absolute deadline", async () => {
    const handle = runCardStatementBinaryDocument(input());
    jest.advanceTimersByTime(30000);
    await peer.hello();
    jest.advanceTimersByTime(29999);
    await peer.armed();
    peer.stdout.write(frame(5, 1, Buffer.from("{"), 1000));
    jest.advanceTimersByTime(1);
    await expect(handle.result).resolves.toEqual(
      failure(execution("DEADLINE")),
    );
    peer.sendControl(errorFrame(1, [22, 0, 0, 0, 1, 0]));
    await peer.close(22);
    await expect(handle.settled).resolves.toEqual({
      cleanup: "CLEAN",
      nativeFailure: execution("DEADLINE"),
      exitCode: 22,
    });
  });

  it("deadline result keeps settlement pending; late native cause is not rewritten", async () => {
    const handle = runCardStatementBinaryDocument(input());
    const settlements = observe(handle.settled);
    await peer.ready();
    jest.advanceTimersByTime(60000);
    await expect(handle.result).resolves.toEqual(
      failure(execution("DEADLINE")),
    );
    await turn();
    expect(settlements).toEqual([]);
    expect(peer.control.destroyed).toBe(false);
    expect(peer.stdout.destroyed).toBe(false);
    peer.sendControl(errorFrame(1, [23, 3, 0, 0, 2, 0]));
    await peer.close(27);
    await expect(handle.result).resolves.toEqual(
      failure(execution("DEADLINE")),
    );
    await expect(handle.settled).resolves.toEqual({
      cleanup: "QUARANTINED",
      nativeFailure: {
        kind: "EXECUTION",
        code: "RESOURCE_LIMIT",
        resource: "CPU",
      },
      exitCode: 27,
    });
  });

  it.each([0, 10485761])(
    "RESULT declared length %i is PROTOCOL_ERROR from header alone",
    async (length) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.stdout.write(frame(5, 1, Buffer.alloc(0), length));
      await expectProtocol(handle);
    },
  );

  it.each([10485759, 10485760])(
    "RESULT exact compact UTF-8 envelope at %i bytes is admissible",
    async (length) => {
      const overhead = Buffer.byteLength(JSON.stringify(dto(1, "")));
      const document = dto(1, "a".repeat(length - overhead));
      const body = Buffer.from(JSON.stringify(document));
      expect(body.length).toBe(length);
      expect(validateDocumentExtraction(document)).toEqual(document);
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.stdout.write(frame(5, 1, body));
      peer.sendControl(frame(6, 1, NONCE));
      await peer.close(0);
      await expect(handle.result).resolves.toEqual({
        kind: "SUCCESS",
        document,
      });
    },
  );

  it.each([
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["incomplete JSON", Buffer.from("{")],
    ["wrong DTO", Buffer.from("{}")],
    ["wrong parserVersion", Buffer.from(JSON.stringify(dto(2)))],
    [
      "unknown field",
      Buffer.from(JSON.stringify({ ...dto(), secret: "synthetic" })),
    ],
  ])(
    "invalid RESULT never becomes an empty success: %s",
    async (_name, body) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.stdout.write(frame(5, 1, body));
      peer.sendControl(frame(6, 1, NONCE));
      await peer.close(0);
      const result = await handle.result;
      expect(result.kind).toBe("FAILURE");
      // ABI083 closes framing errors; it does not name one code for every invalid DTO.
      expect(result).not.toHaveProperty("document");
    },
  );

  it("rejects invalid UTF-8 inside raw.description even when tolerant decoding yields a valid DTO", async () => {
    const marker = Buffer.from("X2_UTF8_MARKER", "ascii");
    const original = Buffer.from(
      JSON.stringify(dto(1, marker.toString("ascii"))),
      "utf8",
    );
    const offset = original.indexOf(marker);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(original.indexOf(marker, offset + marker.length)).toBe(-1);
    const body = Buffer.concat([
      original.subarray(0, offset),
      Buffer.from([0xc3, 0x28]),
      original.subarray(offset + marker.length),
    ]);
    expect(isUtf8(body)).toBe(false);
    const tolerant: unknown = JSON.parse(body.toString("utf8"));
    expect(tolerant).toEqual(dto(1, "\ufffd("));
    expect(validateDocumentExtraction(tolerant)).toEqual(dto(1, "\ufffd("));

    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.stdout.write(frame(5, 1, body));
    peer.sendControl(frame(6, 1, NONCE));
    await peer.close(0);
    const result = await handle.result;
    expect(result.kind).toBe("FAILURE");
    expect(result).not.toHaveProperty("document");
  });

  it("accepts valid multibyte UTF-8 in raw.description without changing the DTO", async () => {
    const document = validateDocumentExtraction(
      dto(1, "Caf\u00e9 \u20ac \u{1f4b3}"),
    );
    const body = Buffer.from(JSON.stringify(document), "utf8");
    expect(isUtf8(body)).toBe(true);
    expect(
      body.includes(Buffer.from("436166c3a920e282ac20f09f92b3", "hex")),
    ).toBe(true);
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.stdout.write(frame(5, 1, body));
    peer.sendControl(frame(6, 1, NONCE));
    await peer.close(0);
    await expect(handle.result).resolves.toEqual({
      kind: "SUCCESS",
      document,
    });
    await expect(handle.settled).resolves.toEqual({
      cleanup: "CLEAN",
      nativeFailure: null,
      exitCode: 0,
    });
  });

  it.each([1, 11, 12, 13, 29])(
    "normal_eof_differs_from_truncation: RESULT cut at %i bytes",
    async (cut) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      const result = frame(5, 1, Buffer.from(JSON.stringify(dto())));
      peer.stdout.write(result.subarray(0, cut));
      peer.sendControl(frame(6, 1, NONCE));
      await peer.close(0);
      await expect(handle.result).resolves.toEqual(
        failure(execution("PROTOCOL_ERROR")),
      );
    },
  );

  it.each([1, 11, 12, 27])(
    "control EOF inside HELLO at byte %i is truncation",
    async (cut) => {
      const handle = runCardStatementBinaryDocument(input());
      peer.sendControl(frame(1, 0, NONCE).subarray(0, cut));
      await expectProtocol(handle);
    },
  );

  it("partial_result_does_not_hide_terminal_error on independent FD3", async () => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.stdout.write(frame(5, 1, Buffer.from('{"version":'), 10485760));
    peer.sendControl(errorFrame(1, [10, 0, 2, 2, 1, 0]));
    await peer.close(10);
    const expected: X2Failure = {
      kind: "DOCUMENT",
      code: "UNSUPPORTED_DOCUMENT",
      reason: "NO_TEXT_LAYER",
    };
    await expect(handle.result).resolves.toEqual(failure(expected));
    await expect(handle.settled).resolves.toEqual({
      cleanup: "CLEAN",
      nativeFailure: expected,
      exitCode: 10,
    });
  });

  it("done_before_result_drain_is_not_success, even after exit 0", async () => {
    const handle = runCardStatementBinaryDocument(input());
    const results = observe(handle.result);
    const settlements = observe(handle.settled);
    await peer.ready();
    const result = frame(5, 1, Buffer.from(JSON.stringify(dto())));
    peer.stdout.write(result.subarray(0, 20));
    peer.sendControl(frame(6, 1, NONCE));
    const exitState = jest.fn(() => ({
      exitCode: peer.exitCode,
      signalCode: peer.signalCode,
      stdinDestroyed: peer.stdin.destroyed,
      stdoutEnded: peer.stdout.writableEnded,
      controlEnded: peer.control.readableEnded,
    }));
    peer.once("exit", exitState);
    peer.exit(0);
    expect(exitState).toHaveBeenCalledWith(0, null);
    expect(exitState).toHaveReturnedWith({
      exitCode: 0,
      signalCode: null,
      stdinDestroyed: true,
      stdoutEnded: false,
      controlEnded: false,
    });
    await turn();
    expect(results).toEqual([]);
    expect(settlements).toEqual([]);
    expect(peer.stdout.writableEnded).toBe(false);
    expect(peer.control.readableEnded).toBe(false);
    peer.stdout.end(result.subarray(20));
    peer.control.push(null);
    await turn();
    peer.emit("close", 0, null);
    await expect(handle.result).resolves.toEqual({
      kind: "SUCCESS",
      document: dto(),
    });
    await expect(handle.settled).resolves.toEqual({
      cleanup: "CLEAN",
      nativeFailure: null,
      exitCode: 0,
    });
  });

  it("DONE cannot extend acceptance when RESULT drain crosses 60000 ms", async () => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    const result = frame(5, 1, Buffer.from(JSON.stringify(dto())));
    jest.advanceTimersByTime(59999);
    peer.stdout.write(result.subarray(0, 20));
    peer.sendControl(frame(6, 1, NONCE));
    await turn();
    jest.advanceTimersByTime(1);
    peer.stdout.write(result.subarray(20));
    await peer.close(0);
    await expect(handle.result).resolves.toEqual(
      failure(execution("DEADLINE")),
    );
  });

  it.each([
    "wrong DONE nonce",
    "wrong DONE profile",
    "duplicate DONE",
    "duplicate ARMED",
    "second RESULT",
    "trailing byte",
  ])("result_requires_valid_dto_done_and_zero_exit: %s", async (defect) => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    const result = frame(5, 1, Buffer.from(JSON.stringify(dto())));
    peer.stdout.write(result);
    peer.sendControl(
      frame(
        6,
        defect === "wrong DONE profile" ? 2 : 1,
        defect === "wrong DONE nonce" ? OTHER_NONCE : NONCE,
      ),
    );
    if (defect === "duplicate DONE") peer.sendControl(frame(6, 1, NONCE));
    if (defect === "duplicate ARMED") peer.sendControl(frame(3, 1, NONCE));
    if (defect === "second RESULT") peer.stdout.write(result);
    if (defect === "trailing byte") peer.stdout.write(Buffer.from([0]));
    await peer.close(0);
    await expect(handle.result).resolves.toEqual(
      failure(execution("PROTOCOL_ERROR")),
    );
  });

  it.each([1, 24, null])(
    "valid RESULT + DONE followed by exit %s never certifies CLEAN",
    async (exit) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.stdout.write(frame(5, 1, Buffer.from(JSON.stringify(dto()))));
      peer.sendControl(frame(6, 1, NONCE));
      await peer.close(exit, exit === null ? "SIGKILL" : null);
      expect((await handle.result).kind).toBe("FAILURE");
      await expect(handle.settled).resolves.toEqual({
        cleanup: "UNCONFIRMED",
        nativeFailure: null,
        exitCode: exit,
      });
    },
  );

  it("RESULT followed by crash without DONE is UNCONFIRMED, not CLEAN or MEMORY", async () => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.stdout.write(frame(5, 1, Buffer.from(JSON.stringify(dto()))));
    await peer.close(null, "SIGKILL");
    const result = await handle.result;
    expect(result.kind).toBe("FAILURE");
    expect(result).not.toEqual(
      failure({
        kind: "EXECUTION",
        code: "RESOURCE_LIMIT",
        resource: "MEMORY",
      }),
    );
    await expect(handle.settled).resolves.toEqual({
      cleanup: "UNCONFIRMED",
      nativeFailure: null,
      exitCode: null,
    });
  });

  it("missing_native_settlement_is_unconfirmed_not_clean after control loss", async () => {
    const handle = runCardStatementBinaryDocument(input());
    await peer.ready();
    peer.control.push(null);
    await turn();
    await peer.close(24);
    await expect(handle.result).resolves.toEqual(
      failure(execution("PROTOCOL_ERROR")),
    );
    await expect(handle.settled).resolves.toEqual({
      cleanup: "UNCONFIRMED",
      nativeFailure: null,
      exitCode: 24,
    });
  });

  it("cleanup deadline does not convert an unconfirmed unit into CLEAN", async () => {
    const abort = new AbortController();
    const handle = runCardStatementBinaryDocument(
      input(1, undefined, abort.signal),
    );
    await peer.ready();
    abort.abort();
    await expect(handle.result).resolves.toEqual(
      failure(execution("CANCELLED")),
    );
    const settlements = observe<X2Settlement>(handle.settled);
    jest.advanceTimersByTime(1001);
    await turn();
    expect(settlements.every((value) => value.cleanup === "UNCONFIRMED")).toBe(
      true,
    );
    await peer.close(null, "SIGKILL");
    await expect(handle.settled).resolves.toEqual({
      cleanup: "UNCONFIRMED",
      nativeFailure: null,
      exitCode: null,
    });
  });

  it.each([
    [1, 24, 0],
    [1, 24, 27],
    [2, 24, 24],
    [2, 23, 23],
  ])(
    "ERROR cleanup %i / primary %i / exit %i must agree",
    async (cleanup, primary, exit) => {
      const handle = runCardStatementBinaryDocument(input());
      await peer.ready();
      peer.sendControl(
        errorFrame(1, [primary, primary === 23 ? 1 : 0, 0, 0, cleanup, 0]),
      );
      await peer.close(exit);
      expect((await handle.result).kind).toBe("FAILURE");
      expect((await handle.settled).cleanup).not.toBe("CLEAN");
    },
  );

  it("result can end before cleanup, but neither ACK alone nor pipe close proves settlement", async () => {
    const handle = runCardStatementBinaryDocument(input());
    const settlements: X2Settlement[] = observe(handle.settled);
    await peer.ready();
    peer.sendControl(errorFrame(1, [24, 0, 0, 0, 1, 0]));
    await turn();
    expect(settlements).toEqual([]);
    await peer.close(null, "SIGKILL");
    await expect(handle.result).resolves.toEqual(
      failure(execution("WORKER_FAILED")),
    );
    await expect(handle.settled).resolves.toEqual({
      cleanup: "UNCONFIRMED",
      nativeFailure: execution("WORKER_FAILED"),
      exitCode: null,
    });
  });
});
