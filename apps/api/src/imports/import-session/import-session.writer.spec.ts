require("../../../../../scripts/test-db-env.cjs");

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { mintImportAuthContext } from "./import-session.auth";
import type { AuthenticatedImportContext } from "./import-session.contract";
import type { ImportSessionClock } from "./import-session.capability";

type Writer = <T>(
  prisma: Pick<PrismaService, "$transaction">,
  clock: ImportSessionClock,
  auth: AuthenticatedImportContext,
  work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
) => Promise<T>;

function exportsUnderTest(): {
  runImportSessionWrite: Writer;
  isRetryableWriteFailure: (error: unknown) => boolean;
} {
  expect(existsSync(join(__dirname, "import-session.writer.ts"))).toBe(true);
  const value = require("./import-session.writer");
  expect(typeof value.runImportSessionWrite).toBe("function");
  expect(typeof value.isRetryableWriteFailure).toBe("function");
  return value;
}

const auth = mintImportAuthContext({
  tenantId: "writer-unit-no-persisted-tenant",
  userId: "owner",
  presentedSessionVersion: 7,
  tokenExpiresAt: "2026-10-07T04:00:00.000Z",
});
const NOW = new Date("2026-10-07T03:00:00.000Z");
const knownError = (code: string, message = "conflict") =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe("shared import writer extraction", () => {
  const prisma = new PrismaService();
  const events: Array<{ action: string; args: unknown }> = [];
  beforeAll(async () => {
    await prisma.onModuleInit();
    const [fk] = await prisma.$queryRaw<
      Array<{ foreign_keys: bigint }>
    >`PRAGMA foreign_keys`;
    expect(Number(fk.foreign_keys)).toBe(1);
    prisma.$use(async (params, next) => {
      events.push({ action: params.action, args: params.args });
      return next(params);
    });
  });
  beforeEach(() => {
    events.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => prisma.onModuleDestroy());

  it("exports concrete writer and classifier (not a failed module import)", () => {
    exportsUnderTest();
  });

  it("locks the exact tenant first, then reads the trusted clock, with unchanged options", async () => {
    const { runImportSessionWrite } = exportsUnderTest();
    const spy = jest.spyOn(prisma, "$transaction");
    const clock = {
      now: jest.fn(() => {
        expect(events).toEqual([
          {
            action: "executeRaw",
            args: [
              ["UPDATE tenants SET id = id WHERE id = ", ""],
              auth.tenantId,
            ],
          },
        ]);
        return NOW;
      }),
    };
    const result = await runImportSessionWrite(
      prisma,
      clock,
      auth,
      async (tx, now) => {
        expect(now).toBe(NOW);
        expect(tx).not.toBe(prisma);
        return tx.$queryRaw<Array<{ value: bigint }>>`SELECT 42 AS value`;
      },
    );
    expect(Number(result[0].value)).toBe(42);
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ maxWait: 5000, timeout: 20000 });
    expect(events.map((event) => event.action)).toEqual([
      "executeRaw",
      "queryRaw",
    ]);
  });

  it("retries each callback with a new transaction and post-lock time, up to three attempts", async () => {
    const { runImportSessionWrite } = exportsUnderTest();
    const transactions = new Set<Prisma.TransactionClient>();
    const clock = {
      now: jest.fn(() => new Date(NOW.getTime() + transactions.size)),
    };
    const times: number[] = [];
    const work = jest.fn(async (tx: Prisma.TransactionClient, now: Date) => {
      transactions.add(tx);
      times.push(now.getTime());
      if (transactions.size < 3) throw knownError("P2034");
      return "committed";
    });
    await expect(
      runImportSessionWrite(prisma, clock, auth, work),
    ).resolves.toBe("committed");
    expect(transactions.size).toBe(3);
    expect(times).toEqual([
      NOW.getTime(),
      NOW.getTime() + 1,
      NOW.getTime() + 2,
    ]);
    expect(events.map((event) => event.action)).toEqual([
      "executeRaw",
      "executeRaw",
      "executeRaw",
    ]);
    expect(clock.now).toHaveBeenCalledTimes(3);
  });

  it("preserves the bounded final error, and propagates non-retryable errors by identity", async () => {
    const { runImportSessionWrite } = exportsUnderTest();
    const clock = { now: jest.fn(() => NOW) };
    const work = jest.fn(async () => {
      throw knownError("P2002");
    });
    await expect(
      runImportSessionWrite(prisma, clock, auth, work),
    ).rejects.toMatchObject({
      code: "RETRYABLE_WRITE_CONFLICT",
      status: 503,
      retryable: true,
    });
    expect(work).toHaveBeenCalledTimes(3);
    const error = new Error("do not translate");
    const failure = jest.fn(async () => {
      throw error;
    });
    await expect(
      runImportSessionWrite(prisma, clock, auth, failure),
    ).rejects.toBe(error);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("does not run work or sample the clock when transaction acquisition fails", async () => {
    const { runImportSessionWrite } = exportsUnderTest();
    const spy = jest
      .spyOn(prisma, "$transaction")
      .mockRejectedValue(knownError("P2034"));
    const clock = { now: jest.fn(() => NOW) };
    const work = jest.fn();
    await expect(
      runImportSessionWrite(prisma, clock, auth, work),
    ).rejects.toMatchObject({ code: "RETRYABLE_WRITE_CONFLICT" });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(work).not.toHaveBeenCalled();
    expect(clock.now).not.toHaveBeenCalled();
  });

  it.each([
    [knownError("P2034"), true],
    [knownError("P2002"), true],
    [knownError("P2028", "SQLITE_BUSY"), false],
    [new Error("SQLITE_BUSY"), true],
    [new Error("database is locked"), true],
    [new Error("DATABASE TABLE IS LOCKED"), true],
    [new Error("other"), false],
    [{ code: "P2034" }, false],
    ["SQLITE_BUSY", false],
    [null, false],
  ])("preserves classifier behavior for %p", (error, expected) => {
    expect(exportsUnderTest().isRetryableWriteFailure(error)).toBe(expected);
  });
});
