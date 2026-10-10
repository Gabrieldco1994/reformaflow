import { Duplex, PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { validateDocumentExtraction } from "./statement-document";
import type { DocumentExtractionV1 } from "./types";
import {
  runCardStatementBinaryDocument,
  x2DecodeError,
  type X2RunInput,
} from "./statement-document.runner";

jest.mock("node:child_process", () => ({
  ...jest.requireActual<typeof import("node:child_process")>(
    "node:child_process",
  ),
  spawn: jest.fn(),
}));
jest.mock("node:os", () => ({ platform: () => "linux" }));
jest.mock("node:perf_hooks", () => ({
  performance: { now: jest.fn(() => 0) },
}));

const nonce = Buffer.alloc(16, 7);
const frame = (kind: number, profile: number, payload = Buffer.alloc(0)) => {
  const header = Buffer.from("58324e310000000000000000", "hex");
  header[4] = kind;
  header[5] = profile;
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
};
const error = (primary: number, cleanup = 1, code = 0, reason = 0) => {
  const payload = Buffer.alloc(12);
  [primary, 0, code, reason, cleanup, 0].forEach((v, i) =>
    payload.writeUInt16BE(v, i * 2),
  );
  return payload;
};
function input(): X2RunInput {
  const bytes = Buffer.from("synthetic");
  return {
    document: {
      version: 1,
      context: "CARD_INVOICE",
      format: "PDF",
      profile: "PDF_TEXT_CARD",
      bytes,
    },
    originalSha256: createHash("sha256").update(bytes).digest("hex"),
    tenantId: "synthetic-tenant",
    config: {
      runtimeRoot: "/synthetic/x2",
      runtimeSeal: "a".repeat(64),
      workerUid: 12001,
      workerGid: 12001,
      memoryBytes: 67108864n,
      cpuQuotaUs: 10000n,
      cpuPeriodUs: 100000n,
      cpuBudgetNs: 100000000n,
      cpuPollMs: 10,
      pidsMax: 32,
      cleanupMs: 1000,
    },
  };
}
function peer(holdDocument = false) {
  const data: Buffer[] = [];
  const controls: Buffer[] = [];
  let releaseWrite = () => {};
  const stdin = new Writable({
    write(chunk, _encoding, cb) {
      data.push(Buffer.from(chunk));
      if (holdDocument && data.length >= 3) releaseWrite = cb;
      else cb();
    },
  });
  const stdout = new PassThrough();
  const control = new Duplex({
    read() {},
    write(chunk, _encoding, cb) {
      controls.push(Buffer.from(chunk));
      cb();
    },
  });
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stdio: [stdin, stdout, null, control],
    pid: 12345,
  });
  jest.mocked(spawn).mockReturnValue(child);
  const close = (code: number) => {
    stdout.end();
    control.push(null);
    setImmediate(() => child.emit("close", code, null));
  };
  return {
    child,
    data,
    controls,
    control,
    stdout,
    close,
    release: () => releaseWrite(),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function dto(description = "synthetic"): DocumentExtractionV1 {
  return {
    version: 1,
    parserVersion: "card-local-pdf-v1",
    documentKind: "UNKNOWN",
    invoiceDueMonth: null,
    metrics: {
      pages: 1,
      rows: 1,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: [
      {
        reference: "pdf:page:1:line:1",
        sourceOrdinal: 0,
        section: "UNKNOWN",
        raw: { date: null, description, amount: null, installment: null },
        cycle: null,
        dateOnly: null,
        merchant: null,
        amountCents: null,
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
async function armedPeer(request = input(), holdDocument = false) {
  const p = peer(holdDocument);
  const handle = runCardStatementBinaryDocument(request);
  p.control.push(frame(1, 0, nonce));
  p.control.push(frame(3, 1, nonce));
  await flush();
  return { ...p, handle };
}

describe("X2 native parent protocol (synthetic peer, not Linux isolation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(performance.now).mockReturnValue(0);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it.each(["end", "error"])(
    "latches control %s without a terminal while settlement remains pending",
    async (event) => {
      const p = await armedPeer();
      const results: unknown[] = [];
      const settlements: unknown[] = [];
      void p.handle.result.then((value) => results.push(value));
      void p.handle.settled.then((value) => settlements.push(value));
      if (event === "end") p.control.push(null);
      else p.control.emit("error", new Error("Synthetic control loss"));
      await flush();
      const early = results[0];
      const pending = settlements.length === 0;
      p.close(24);
      await p.handle.result;
      const settlement = await p.handle.settled;
      expect(early).toEqual({
        kind: "FAILURE",
        failure: { kind: "EXECUTION", code: "PROTOCOL_ERROR", resource: null },
      });
      expect(pending).toBe(true);
      expect(settlement.cleanup).toBe("UNCONFIRMED");
    },
  );
  it("preserves a late framed ERROR after truncated FD1 already reached EOF", async () => {
    const p = await armedPeer();
    const results: unknown[] = [];
    void p.handle.result.then((value) => results.push(value));
    const partial = frame(5, 1, Buffer.from("{"));
    partial.writeUInt32BE(1000, 8);
    p.stdout.end(partial);
    await flush();
    const pending = results.length === 0;
    p.control.push(frame(7, 1, error(10, 1, 2, 2)));
    p.close(10);
    expect(await p.handle.result).toEqual({
      kind: "FAILURE",
      failure: {
        kind: "DOCUMENT",
        code: "UNSUPPORTED_DOCUMENT",
        reason: "NO_TEXT_LAYER",
      },
    });
    expect(pending).toBe(true);
    expect(await p.handle.settled).toEqual({
      cleanup: "CLEAN",
      nativeFailure: {
        kind: "DOCUMENT",
        code: "UNSUPPORTED_DOCUMENT",
        reason: "NO_TEXT_LAYER",
      },
      exitCode: 10,
    });
  });
  it("rejects a changed original before spawn", async () => {
    const request = input();
    request.document.bytes[0] ^= 1;
    const handle = runCardStatementBinaryDocument(request);
    expect(await handle.result).toEqual({
      kind: "FAILURE",
      failure: { kind: "DOCUMENT", code: "INVALID_RESULT", reason: null },
    });
    expect((await handle.settled).cleanup).toBe("NOT_STARTED");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("checks the parent deadline after synchronous hashing, before spawn", async () => {
    jest
      .mocked(performance.now)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(60000);
    expect((await runCardStatementBinaryDocument(input()).result).kind).toBe(
      "FAILURE",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it("uses fixed invocation and sends no document before ARMED", async () => {
    const p = peer();
    const request = input();
    const handle = runCardStatementBinaryDocument(request);
    p.control.push(frame(1, 0, nonce));
    await flush();
    expect(Buffer.concat(p.data).length).toBe(64);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/libexec/reformaflow-x2",
      [],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "ignore", "pipe"],
        shell: false,
      }),
    );
    const options = jest.mocked(spawn).mock.calls[0][2];
    expect(options?.env).not.toHaveProperty("PATH");
    expect(options?.env).not.toHaveProperty("NODE_OPTIONS");
    p.control.push(frame(7, 1, error(20)));
    p.close(20);
    expect((await handle.result).kind).toBe("FAILURE");
    expect((await handle.settled).cleanup).toBe("CLEAN");
  });
  it("accepts pre-START ERROR while START is only enqueued", async () => {
    const p = peer();
    const handle = runCardStatementBinaryDocument(input());
    p.control.push(frame(1, 0, nonce));
    await flush();
    p.control.push(frame(7, 0, error(25)));
    p.close(25);
    expect(await handle.result).toEqual({
      kind: "FAILURE",
      failure: { kind: "EXECUTION", code: "CANCELLED", resource: null },
    });
    expect((await handle.settled).cleanup).toBe("CLEAN");
  });
  it("sends cancellation on FD3 before HELLO with the zero sentinel", async () => {
    const p = peer();
    const signal = new AbortController();
    const handle = runCardStatementBinaryDocument({
      ...input(),
      signal: signal.signal,
    });
    signal.abort();
    await flush();
    expect(Buffer.concat(p.controls)).toEqual(
      frame(8, 0, Buffer.concat([Buffer.alloc(16), Buffer.from([0, 1])])),
    );
    expect((await handle.result).kind).toBe("FAILURE");
    p.control.push(frame(7, 0, error(25)));
    p.close(25);
    expect((await handle.settled).cleanup).toBe("CLEAN");
  });
  it("preserves a terminal ERROR when RESULT was truncated", async () => {
    const p = peer();
    const handle = runCardStatementBinaryDocument(input());
    p.control.push(frame(1, 0, nonce));
    p.control.push(frame(3, 1, nonce));
    await flush();
    const partial = frame(5, 1, Buffer.from("123456"));
    p.stdout.write(partial.subarray(0, 14));
    p.control.push(frame(7, 1, error(22, 2)));
    p.close(27);
    expect(await handle.result).toEqual({
      kind: "FAILURE",
      failure: { kind: "EXECUTION", code: "DEADLINE", resource: null },
    });
    expect(await handle.settled).toEqual({
      cleanup: "QUARANTINED",
      nativeFailure: { kind: "EXECUTION", code: "DEADLINE", resource: null },
      exitCode: 27,
    });
  });
  it("does not call a crashed helper CLEAN", async () => {
    const p = peer();
    const handle = runCardStatementBinaryDocument(input());
    p.close(24);
    expect((await handle.result).kind).toBe("FAILURE");
    expect((await handle.settled).cleanup).toBe("UNCONFIRMED");
  });
  it("accepts success only after DONE, result drainage, EOFs and zero exit", async () => {
    const expected = validateDocumentExtraction(dto());
    const p = await armedPeer();
    let resolved = false;
    void p.handle.result.then(() => {
      resolved = true;
    });
    p.control.push(frame(6, 1, nonce));
    await flush();
    expect(resolved).toBe(false);
    const bytes = frame(5, 1, Buffer.from(JSON.stringify(expected)));
    for (const byte of bytes) p.stdout.write(Buffer.from([byte]));
    await flush();
    expect(resolved).toBe(false);
    p.close(0);
    expect(await p.handle.result).toEqual({
      kind: "SUCCESS",
      document: expected,
    });
    expect((await p.handle.settled).cleanup).toBe("CLEAN");
  });
  it.each([59999, 60000, 60001])(
    "applies the literal acceptance deadline at %i ms",
    async (time) => {
      const p = await armedPeer();
      p.stdout.write(frame(5, 1, Buffer.from(JSON.stringify(dto()))));
      p.control.push(frame(6, 1, nonce));
      jest.mocked(performance.now).mockReturnValue(time);
      p.close(0);
      const result = await p.handle.result;
      if (time === 59999) expect(result.kind).toBe("SUCCESS");
      else
        expect(result).toEqual({
          kind: "FAILURE",
          failure: { kind: "EXECUTION", code: "DEADLINE", resource: null },
        });
      await p.handle.settled;
    },
  );
  it("does not accept a valid DTO followed by a crash", async () => {
    const p = await armedPeer();
    p.stdout.write(frame(5, 1, Buffer.from(JSON.stringify(dto()))));
    p.control.push(frame(6, 1, nonce));
    p.close(24);
    expect((await p.handle.result).kind).toBe("FAILURE");
    expect((await p.handle.settled).cleanup).toBe("UNCONFIRMED");
  });
  it("rejects malformed UTF8 even when replacement would be valid JSON and DTO", async () => {
    const good = Buffer.from(JSON.stringify(dto("UTF8")));
    const start = good.indexOf("UTF8");
    expect(start).toBeGreaterThan(0);
    const bad = Buffer.concat([
      good.subarray(0, start),
      Buffer.from([0xff]),
      good.subarray(start + 4),
    ]);
    expect(
      validateDocumentExtraction(JSON.parse(bad.toString("utf8")))
        .occurrences[0].raw.description,
    ).toBe("\ufffd");
    const p = await armedPeer();
    p.stdout.write(frame(5, 1, bad));
    p.control.push(frame(6, 1, nonce));
    p.close(0);
    expect(await p.handle.result).toEqual({
      kind: "FAILURE",
      failure: { kind: "EXECUTION", code: "PROTOCOL_ERROR", resource: null },
    });
    await p.handle.settled;
  });
  it.each([0, 10485759, 10485760, 10485761])(
    "enforces document length %i before native admission",
    async (size) => {
      const request = input();
      const bytes = Buffer.alloc(size, 1);
      const p = peer();
      const handle = runCardStatementBinaryDocument({
        ...request,
        document: { ...request.document, bytes },
        originalSha256: createHash("sha256").update(bytes).digest("hex"),
      });
      if (size === 0 || size > 10485760) {
        expect(spawn).not.toHaveBeenCalled();
        expect(await handle.result).toEqual({
          kind: "FAILURE",
          failure: {
            kind: "DOCUMENT",
            code: size === 0 ? "INVALID_INPUT" : "LIMIT_EXCEEDED",
            reason: null,
          },
        });
      } else {
        p.control.push(frame(1, 0, nonce));
        await flush();
        expect(Buffer.concat(p.data).readUInt32BE(60)).toBe(size);
        p.control.push(frame(7, 1, error(20)));
        p.close(20);
        await handle.result;
      }
      await handle.settled;
    },
  );
  it.each([0, 10485761])(
    "rejects RESULT length %i from its header alone",
    async (size) => {
      const p = await armedPeer();
      const header = frame(5, 1);
      header.writeUInt32BE(size, 8);
      p.stdout.write(header);
      p.close(21);
      expect(await p.handle.result).toEqual({
        kind: "FAILURE",
        failure: { kind: "EXECUTION", code: "PROTOCOL_ERROR", resource: null },
      });
      await p.handle.settled;
    },
  );
  it("accepts a complete validated RESULT of exactly 10485760 bytes", async () => {
    const overhead = Buffer.byteLength(JSON.stringify(dto("")));
    const body = Buffer.from(
      JSON.stringify(dto("x".repeat(10485760 - overhead))),
    );
    expect(body.length).toBe(10485760);
    const p = await armedPeer();
    p.stdout.write(frame(5, 1, body));
    p.control.push(frame(6, 1, nonce));
    p.close(0);
    expect((await p.handle.result).kind).toBe("SUCCESS");
    await p.handle.settled;
  });
  it("rejects a duplicate RESULT header before allocating its advertised body", async () => {
    const p = await armedPeer();
    p.stdout.write(frame(5, 1, Buffer.from(JSON.stringify(dto()))));
    const duplicate = frame(5, 1);
    duplicate.writeUInt32BE(10485760, 8);
    const allocation = jest.spyOn(Buffer, "alloc");
    p.stdout.write(duplicate);
    const allocatedExtra = allocation.mock.calls.some(
      ([size]) => size === 10485760,
    );
    allocation.mockRestore();
    p.close(21);
    await p.handle.result;
    await p.handle.settled;
    expect(allocatedExtra).toBe(false);
  });
  it("cancels a backpressured DOCUMENT exclusively through FD3", async () => {
    const request = input();
    const signal = new AbortController();
    const bytes = Buffer.alloc(200000, 1);
    const p = await armedPeer(
      {
        ...request,
        document: { ...request.document, bytes },
        originalSha256: createHash("sha256").update(bytes).digest("hex"),
        signal: signal.signal,
      },
      true,
    );
    const before = Buffer.concat(p.data).length;
    signal.abort();
    await flush();
    expect(Buffer.concat(p.controls)).toEqual(
      frame(8, 0, Buffer.concat([nonce, Buffer.from([0, 1])])),
    );
    expect(Buffer.concat(p.data).length).toBe(before);
    expect(before).toBeLessThan(bytes.length);
    p.control.push(frame(7, 1, error(25)));
    p.release();
    p.close(25);
    expect((await p.handle.result).kind).toBe("FAILURE");
    expect((await p.handle.settled).cleanup).toBe("CLEAN");
  });
  it("keeps settlement pending after the parent deadline, including after EPIPE", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    const p = await armedPeer();
    let settled = false;
    void p.handle.settled.then(() => {
      settled = true;
    });
    p.child.stdin?.emit("error", new Error("synthetic EPIPE"));
    jest.mocked(performance.now).mockReturnValue(60000);
    jest.advanceTimersByTime(60000);
    expect(await p.handle.result).toEqual({
      kind: "FAILURE",
      failure: { kind: "EXECUTION", code: "DEADLINE", resource: null },
    });
    expect(settled).toBe(false);
    expect(Buffer.concat(p.controls)).toEqual(
      frame(8, 0, Buffer.concat([nonce, Buffer.from([0, 2])])),
    );
    p.control.push(frame(7, 1, error(22)));
    p.close(22);
    expect((await p.handle.settled).cleanup).toBe("CLEAN");
  });
  it.each([0n, -1n, 9223372036854775808n])(
    "refuses invalid memory policy %s without spawn",
    async (memoryBytes) => {
      const request = input();
      const handle = runCardStatementBinaryDocument({
        ...request,
        config: { ...request.config, memoryBytes },
      });
      expect(await handle.result).toEqual({
        kind: "FAILURE",
        failure: { kind: "EXECUTION", code: "UNAVAILABLE", resource: null },
      });
      expect((await handle.settled).cleanup).toBe("NOT_STARTED");
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("pins the literal ERROR vector and rejects invalid field relations", () => {
    expect(
      x2DecodeError(Buffer.from("000a00000002000200010000", "hex"), false),
    ).toEqual({
      primary: 10,
      cleanup: 1,
      failure: {
        kind: "DOCUMENT",
        code: "UNSUPPORTED_DOCUMENT",
        reason: "NO_TEXT_LAYER",
      },
    });
    for (const vector of [
      "000a00010002000200010000",
      "000a00000001000200010000",
      "001700000000000000010000",
      "001b00000000000000010000",
      "001400000000000000000000",
      "001400000000000000010001",
    ])
      expect(() => x2DecodeError(Buffer.from(vector, "hex"), false)).toThrow(
        "X2_PROTOCOL",
      );
  });
});
