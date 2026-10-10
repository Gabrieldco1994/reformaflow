require("../../../../../../scripts/test-db-env.cjs");

import fs, { existsSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MODULE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  bootVaultApp,
  createVaultTestDatabase,
  CANONICAL_VAULT,
  fileSeed,
  finishVaultFixture,
  fullDigest,
  getContent,
  getVaultGate,
  canonicalVaultFixture,
  loadVaultGate,
  pdfBytes,
  putContent,
  rawSocket,
  RECOVERY_ORIGIN,
  readStoredBlob,
  refsOf,
  reserve,
  seedArtifact,
  seedRef,
  sha256Hex,
  storedMode,
  UI_HEADERS,
  wire,
  type RecoveryApp,
  type GateContract,
} from "../../../test-utils/import-session-vault-harness";
import {
  bounded,
  gate,
  observeIo,
  outcome,
} from "../../../test-utils/vault-foundation-harness";
import {
  seedImportWorld,
  seedSession,
  FIXED_NOW,
  type ImportWorld,
} from "../../../test-utils/import-session-harness";
import { parseStoredDraft } from "../import-session.projection";
import { parseStoredImportSearch } from "../import-session.search";
import { ImportSessionController } from "../import-session.controller";
import { ImportSessionModule } from "../import-session.module";
import { ImportChatGuard } from "../import-chat.guard";
import { ImportChatBridge } from "../import-chat.bridge";
import { CardPurchaseBatchAdapter } from "../card-purchase-batch.adapter";
import { CARD_PURCHASE_BATCH_PORT } from "../card-purchase-batch.port";
import { ImportSessionWorkflowService } from "../import-session-workflow.service";
import type {
  VaultArtifactRead,
  VaultArtifactRecheck,
  VaultReadConsumer,
} from "./vault-storage";
import { VaultIoError } from "./vault-storage";
import type { VaultPurgeTarget, VaultPurgeResult } from "./vault-purger";
import type { ImportSessionClock } from "../import-session.capability";
import { ImportRawExecutions } from "../import-session.raw-executions";
import { ImportVaultGate } from "./vault-state";

type ReaperInput = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  limit: number;
}>;
type ReaperResult = Readonly<{
  sessions: readonly Readonly<{
    id: string;
    outcome: "CLEANED" | "NOT_ELIGIBLE";
  }>[];
  purges: readonly Readonly<{
    target: VaultPurgeTarget;
    outcome: VaultPurgeResult;
  }>[];
}>;
interface ReaperExports {
  VaultReaper: new (
    db: PrismaService,
    clock: ImportSessionClock,
    authority: GateContract,
    raw: ImportRawExecutions,
  ) => {
    runCycle(input: ReaperInput): Promise<ReaperResult>;
  };
}
function assertReaper(value: unknown): asserts value is ReaperExports {
  expect(value).toEqual(
    expect.objectContaining({
      VaultReaper: expect.objectContaining({
        prototype: expect.objectContaining({ runCycle: expect.any(Function) }),
      }),
    }),
  );
}
function loadReaper(): ReaperExports {
  const file = join(__dirname, "vault-reaper.ts");
  expect({
    missingExportModule: existsSync(file) ? null : "vault-reaper.ts",
  }).toEqual({ missingExportModule: null });
  const exports: unknown = require(file);
  assertReaper(exports);
  return exports;
}

describe("G1 explicit scoped reaper cycle", () => {
  let ordinal = 0;
  async function context() {
    const { VaultReaper } = loadReaper();
    loadVaultGate();
    const database = await createVaultTestDatabase();
    const db = database.setup;
    let fixture: Awaited<ReturnType<typeof canonicalVaultFixture>> | undefined;
    try {
      const world = await seedImportWorld(db, `reaper-qa-${++ordinal}`);
      fixture = await canonicalVaultFixture();
      const ownedFixture = fixture;
      const clock = { now: () => new Date(FIXED_NOW) };
      const authority = fixture.createGate(db, clock);
      if (!(authority instanceof ImportVaultGate)) throw new Error("Expected real vault gate");
      await bounded(authority.boot.settled);
      const cycle = new VaultReaper(db, clock, authority,
        new ImportRawExecutions(authority, clock, { writesEnabled: () => false, newImportFormats: () => [] }, null));
      const input = {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        limit: 3,
      };
      return {
        db,
        world,
        fixture,
        clock,
        authority,
        cycle,
        input,
        async pending(
          id: string,
          session: { id: string; tenantId: string; ownerProjectId: string },
          position = 0,
        ) {
          await seedRef(db, session, world.users.restricted, {
            id,
            position,
            state: "FAILED",
            generation: 3,
            reservedBytes: 1000,
            temporaryStorageKey: `t/${id}`,
            temporaryPurgePending: true,
            leaseExpiresAt: null,
            tokenExpiresAt: null,
          });
          await fsp.mkdir(join(ownedFixture.root, `t/${id}/g2`), {
            recursive: true,
            mode: 0o700,
          });
          await fsp.writeFile(
            join(ownedFixture.root, `t/${id}/g2/blob`),
            pdfBytes(1000, id),
            { mode: 0o600 },
          );
          return {
            kind: "ref",
            tenantId: session.tenantId,
            ownerProjectId: session.ownerProjectId,
            id,
          } as const;
        },
        async finish() {
          await finishVaultFixture(
            () => ownedFixture.close(),
            () => database.close(),
          );
        },
      };
    } catch (error) {
      try {
        await finishVaultFixture(
          () => fixture?.close(),
          () => database.close(),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Reaper fixture setup and cleanup failed",
        );
      }
      throw error;
    }
  }

  it.each([
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { limit: NaN },
    { limit: Infinity },
    { tenantId: "" },
    { tenantId: "../outside" },
    { ownerProjectId: "" },
  ])(
    "G1 invalid capture %j rejects with the real VaultIoError before DB or FS",
    async (invalid) => {
      const c = await context();
      let watching = false;
      const queries: string[] = [];
      let io: ReturnType<typeof observeIo> | undefined;
      const spies: jest.SpyInstance[] = [];
      try {
        c.db.$use(async (params, next) => {
          if (watching) queries.push(params.action);
          return next(params);
        });
        io = observeIo(c.fixture.root);
        const probe = jest.spyOn(fs, "fstat");
        spies.push(probe);
        const transaction = jest.spyOn(c.db, "$transaction");
        spies.push(transaction);
        watching = true;
        const result = await outcome(
          c.cycle.runCycle({ ...c.input, ...invalid }),
        );
        expect(result).toMatchObject({ ok: false });
        if (result.ok) throw new Error("invalid reaper input accepted");
        expect(result.error).toBeInstanceOf(VaultIoError);
        expect(result.error).toMatchObject(
          new VaultIoError({ kind: "INVALID_CAPTURE", step: "capture" }),
        );
        expect(queries).toEqual([]);
        expect(transaction).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
        expect(io.events).toEqual([]);
      } finally {
        watching = false;
        await finishVaultFixture(
          ...spies.reverse().map((spy) => () => spy.mockRestore()),
          () => io?.restore(),
          () => c.finish(),
        );
      }
    },
  );

  it("G1 cycle is explicit, scoped, bounded and ordered; session units consume the same budget as purges", async () => {
    const c = await context();
    const discoveries: Prisma.MiddlewareParams[] = [];
    let watching = false;
    let purge: jest.SpyInstance | undefined;
    c.db.$use(async (params, next) => {
      if (
        watching &&
        params.action === "findMany" &&
        !params.args?.where?.sessionId &&
        ["ImportSession", "ImportSessionArtifact", "ImportArtifact"].includes(
          params.model ?? "",
        )
      )
        discoveries.push(params);
      return next(params);
    });
    try {
      const live = await seedSession(c.db, c.world, {
        ownerUserId: c.world.users.restricted.id,
      });
      const expired = await Promise.all(
        ["a", "b"].map((suffix) =>
          seedSession(c.db, c.world, {
            id: `${c.world.prefix}-expired-${suffix}`,
            expiresAt: new Date(FIXED_NOW.getTime() - 1),
          }),
        ),
      );
      const targets = [];
      for (const [position, id] of [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ].entries())
        targets.push(await c.pending(id, live, position));
      const otherProject = await seedSession(c.db, c.world, {
        ownerProjectId: c.world.projects.casa,
        cardId: c.world.cards.casa,
      });
      const protectedTarget = await c.pending(
        "44444444-4444-4444-8444-444444444444",
        otherProject,
      );
      const foreignWorld = await seedImportWorld(
        c.db,
        `${c.world.prefix}-foreign`,
      );
      const foreign = await seedSession(c.db, foreignWorld, {
        expiresAt: new Date(FIXED_NOW.getTime() - 1),
      });
      const protectedRef = await c.db.importSessionArtifact.findUniqueOrThrow({
        where: { id: protectedTarget.id },
      });
      const beforeUnattempted = await c.db.importSessionArtifact.findMany({
        where: { id: { in: targets.slice(1).map((t) => t.id) } },
        orderBy: { id: "asc" },
      });
      purge = jest.spyOn(c.authority.requirePurger(), "purge");
      expect(purge).not.toHaveBeenCalled();
      watching = true;
      const result = await c.cycle.runCycle(c.input);
      watching = false;
      expect(result).toEqual({
        sessions: expired.map((s) => ({ id: s.id, outcome: "CLEANED" })),
        purges: [{ target: targets[0], outcome: "PURGED" }],
      });
      expect(result.sessions.length + result.purges.length).toBe(c.input.limit);
      expect(purge.mock.calls).toEqual([[targets[0]]]);
      purge.mockRestore();
      expect(discoveries.length).toBeGreaterThan(0);
      for (const query of discoveries) {
        expect(query.args.where).toMatchObject({
          tenantId: c.input.tenantId,
          ownerProjectId: c.input.ownerProjectId,
        });
        expect(Number.isSafeInteger(query.args.take)).toBe(true);
        expect(query.args.take).toBeGreaterThan(0);
        expect(query.args.take).toBeLessThanOrEqual(c.input.limit);
      }
      expect(
        await c.db.importSession.findUniqueOrThrow({
          where: { id: foreign.id },
        }),
      ).toEqual(foreign);
      expect(
        await c.db.importSessionArtifact.findUniqueOrThrow({
          where: { id: protectedTarget.id },
        }),
      ).toEqual(protectedRef);
      expect(
        await c.db.importSessionArtifact.findMany({
          where: { id: { in: targets.slice(1).map((t) => t.id) } },
          orderBy: { id: "asc" },
        }),
      ).toEqual(beforeUnattempted);
      for (const target of [...targets.slice(1), protectedTarget])
        expect(
          await fsp.readFile(join(c.fixture.root, `t/${target.id}/g2/blob`)),
        ).toEqual(pdfBytes(1000, target.id));
    } finally {
      watching = false;
      purge?.mockRestore();
      await c.finish();
    }
  });

  it("G1 empty scope has exact empty arrays and no probe or purge; OFF is an error, not empty success", async () => {
    const c = await context();
    const spies: jest.SpyInstance[] = [];
    try {
      const probe = jest.spyOn(fs, "fstat");
      spies.push(probe);
      const purge = jest.spyOn(c.authority.requirePurger(), "purge");
      spies.push(purge);
      expect(await c.cycle.runCycle(c.input)).toEqual({
        sessions: [],
        purges: [],
      });
      expect(probe).not.toHaveBeenCalled();
      expect(purge).not.toHaveBeenCalled();
      await c.authority.shutdown();
      const transaction = jest.spyOn(c.db, "$transaction");
      try {
        const result = await outcome(c.cycle.runCycle(c.input));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("OFF reaper returned success");
        expect(result.error).toBeInstanceOf(VaultIoError);
        expect(result.error).toMatchObject(
          new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" }),
        );
        expect(transaction).not.toHaveBeenCalled();
        expect(purge).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
      }
    } finally {
      await finishVaultFixture(
        ...spies.reverse().map((spy) => () => spy.mockRestore()),
        () => c.finish(),
      );
    }
  });

  it("G1 real held probe permits a competing ATTACHED membership commit and the fresh coordinator refuses purge", async () => {
    const c = await context(),
      entered = gate(),
      resume = gate();
    let work: Promise<ReaperResult> | undefined;
    let purge: jest.SpyInstance | undefined;
    const io = observeIo(c.fixture.root, {
      beforeLstat: async (path) => {
        if (path === join(c.fixture.root, ".lock")) {
          entered.release();
          await resume.promise;
        }
      },
    });
    try {
      const session = await seedSession(c.db, c.world, {
        ownerUserId: c.world.users.restricted.id,
      });
      const id = await seedArtifact(c.db, session);
      const artifact = await c.db.importArtifact.findUniqueOrThrow({
        where: { id },
      });
      await fsp.mkdir(join(c.fixture.root, artifact.storageKey!, ".."), {
        recursive: true,
        mode: 0o700,
      });
      const payload = pdfBytes(1000, "reaper-winner");
      await fsp.writeFile(join(c.fixture.root, artifact.storageKey!), payload, {
        mode: 0o600,
      });
      const input = { ...c.input, limit: 1 };
      work = c.cycle.runCycle(input);
      await bounded(
        Promise.race([
          entered.promise,
          work.then(() => {
            throw new Error("cycle ended before real membership probe");
          }),
        ]),
      );
      input.tenantId = c.world.otherTenantId;
      input.ownerProjectId = c.world.projects.casa;
      const refId = randomUUID();
      await bounded(
        c.db.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.world.tenantId}`;
          await tx.importSessionArtifact.create({
            data: {
              id: refId,
              tenantId: c.world.tenantId,
              ownerProjectId: session.ownerProjectId,
              sessionId: session.id,
              artifactId: id,
              position: 0,
              fileName: "winner.pdf",
              declaredMime: "application/pdf",
              declaredBytes: 1000,
              state: "ATTACHED",
              reservedBytes: 0,
              uploadGeneration: 2,
              verifiedAt: FIXED_NOW,
            },
          });
        }),
        "membership writer commits while native lock probe is held",
      );
      const winner = await c.db.importSessionArtifact.findUniqueOrThrow({
        where: { id: refId },
      });
      purge = jest.spyOn(c.authority.requirePurger(), "purge");
      resume.release();
      expect(await bounded(work)).toEqual({
        sessions: [],
        purges: [
          {
            target: {
              kind: "artifact",
              tenantId: c.world.tenantId,
              ownerProjectId: session.ownerProjectId,
              id,
            },
            outcome: "NOT_ELIGIBLE",
          },
        ],
      });
      expect(purge).toHaveBeenCalledTimes(1);
      purge.mockRestore();
      expect(
        await c.db.importArtifact.findUniqueOrThrow({ where: { id } }),
      ).toEqual(artifact);
      expect(
        await c.db.importSessionArtifact.findUniqueOrThrow({
          where: { id: refId },
        }),
      ).toEqual(winner);
      expect(
        await fsp.readFile(join(c.fixture.root, artifact.storageKey!)),
      ).toEqual(payload);
      expect(io.events.filter((e) => /^(rename|rm|rmdir)/.test(e.op))).toEqual(
        [],
      );
    } finally {
      resume.release();
      if (work) await bounded(outcome(work));
      purge?.mockRestore();
      io.restore();
      await c.finish();
    }
  });

  it.each([false, true])(
    "G1 expiry without refs cleans a real session; renewal during the probe=%s is freshly respected",
    async (renew) => {
      const c = await context(),
        entered = gate(),
        resume = gate();
      let work: Promise<ReaperResult> | undefined;
      let spy: jest.SpyInstance | undefined;
      const purge = jest.spyOn(c.authority.requirePurger(), "purge");
      try {
        const id = randomUUID();
        let transients: Parameters<typeof seedSession>[2] = {};
        if (!renew) {
          // Zero refs supplies no authorized observation for a nonempty line.
          const draftJson =
            '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}';
          const draft = parseStoredDraft(draftJson);
          const search = {
            version: 1,
            revision: 2,
            complete: false,
            candidates: [],
            coverage: {
              recipe: "CARD_PURCHASE_V1",
              inputHash: "a".repeat(64),
              steps: [],
            },
          };
          const leaseExpiresAt = new Date(
            FIXED_NOW.getTime() - 1,
          ).toISOString();
          transients = {
            state: "ANALYZING",
            revision: 2,
            draftJson,
            searchJson: JSON.stringify(search),
            preflightHash: "d".repeat(64),
            prepareGeneration: 3,
            prepareLeaseJson: JSON.stringify({
              generation: 3,
              sessionVersion: 0,
              tokenExpiresAt: leaseExpiresAt,
              expiresAt: leaseExpiresAt,
            }),
          };
          expect(
            parseStoredImportSearch(transients.searchJson!, 2, draft),
          ).toEqual({ kind: "SEARCH", value: search });
        }
        const session = await seedSession(c.db, c.world, {
          id,
          expiresAt: new Date(FIXED_NOW.getTime() - 1),
          ...transients,
        });
        expect(
          await c.db.importSessionArtifact.count({
            where: { tenantId: c.world.tenantId, sessionId: session.id },
          }),
        ).toBe(0);
        const native = fsp.lstat.bind(fsp);
        spy = jest.spyOn(fsp, "lstat").mockImplementation((async (
          ...args: Parameters<typeof fsp.lstat>
        ) => {
          if (String(args[0]) === join(c.fixture.root, ".lock")) {
            entered.release();
            await resume.promise;
          }
          return native(...args);
        }) as typeof fsp.lstat);
        work = c.cycle.runCycle({ ...c.input, limit: 1 });
        await bounded(
          Promise.race([
            entered.promise,
            work.then(() => {
              throw new Error("expiry skipped probe");
            }),
          ]),
        );
        let expected = session;
        if (renew)
          expected = await bounded(
            c.db.$transaction(async (tx) => {
              await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.world.tenantId}`;
              return tx.importSession.update({
                where: { id: session.id },
                data: { expiresAt: new Date(FIXED_NOW.getTime() + 60_000) },
              });
            }),
            "expiry renewal writer commits during real probe",
          );
        resume.release();
        expect(await bounded(work)).toEqual({
          sessions: [
            { id: session.id, outcome: renew ? "NOT_ELIGIBLE" : "CLEANED" },
          ],
          purges: [],
        });
        const row = await c.db.importSession.findUnique({
          where: { id: session.id },
        });
        if (renew) expect(row).toEqual(expected);
        else
          expect(row).toEqual({
            ...session,
            state: "EXPIRED",
            revision: 3,
            closedAt: FIXED_NOW,
            updatedAt: expect.any(Date),
            draftJson:
              '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
            searchJson: null,
            proposalJson: null,
            preflightHash: null,
            challengeJson: null,
            prepareLeaseJson: null,
            prepareGeneration: 4,
          });
        expect(purge).not.toHaveBeenCalled();
      } finally {
        resume.release();
        if (work) await bounded(outcome(work));
        spy?.mockRestore();
        purge.mockRestore();
        await c.finish();
      }
    },
  );

  it("G1 one actual R close timeout retains charge while another eligible target completes in the same cycle", async () => {
    const c = await context();
    const firstId = "66666666-6666-4666-8666-666666666666";
    const secondId = "77777777-7777-4777-8777-777777777777";
    const held = gate(),
      resume = gate();
    const io = observeIo(c.fixture.root, {
      beforeClose: async (path) => {
        if (path.endsWith(`/${firstId}/g2/blob`)) {
          held.release();
          await resume.promise;
        }
      },
    });
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    let close: Promise<void> | undefined;
    let work: Promise<ReaperResult> | undefined;
    let drainSpy: jest.SpyInstance | undefined;
    let lease: ReturnType<GateContract["registry"]["enter"]> | undefined;
    try {
      const session = await seedSession(c.db, c.world);
      const first = await c.pending(firstId, session);
      const second = await c.pending(secondId, session, 1);
      handle = await fsp.open(
        join(c.fixture.root, `t/${first.id}/g2/blob`),
        "r",
      );
      lease = c.authority.registry.enter(`R:${first.id}`, {
        tenantId: c.world.tenantId,
        ownerProjectId: session.ownerProjectId,
        ownerUserId: session.ownerUserId,
      });
      expect(lease.ok).toBe(true);
      if (!lease.ok) throw new Error("fixture R admission refused");
      const admitted = lease.lease;
      lease.lease.signal.addEventListener(
        "abort",
        () => {
          close = handle!.close().then(() => admitted.exit());
        },
        { once: true },
      );
      const armed = gate();
      const nativeDrain = c.authority.registry.abortAndDrain.bind(
        c.authority.registry,
      );
      drainSpy = jest
        .spyOn(c.authority.registry, "abortAndDrain")
        .mockImplementation((key, timeout) => {
          const result = nativeDrain(key, timeout);
          if (key === `R:${first.id}`) armed.release();
          return result;
        });
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      work = c.cycle.runCycle({ ...c.input, limit: 2 });
      await bounded(Promise.all([armed.promise, held.promise]));
      await jest.advanceTimersByTimeAsync(36);
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(await bounded(work)).toEqual({
        sessions: [],
        purges: [
          { target: first, outcome: "DRAIN_TIMEOUT" },
          { target: second, outcome: "PURGED" },
        ],
      });
      drainSpy.mockRestore();
      jest.useRealTimers();
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      expect(
        c.authority.registry.snapshotUploads().map((entry) => entry.refId),
      ).toEqual([first.id]);
      expect(
        await c.db.importSessionArtifact.findUniqueOrThrow({
          where: { id: first.id },
        }),
      ).toMatchObject({
        temporaryStorageKey: `t/${first.id}`,
        reservedBytes: 1000,
        temporaryPurgePending: true,
      });
      expect(
        await fsp.readFile(join(c.fixture.root, `t/${first.id}/g2/blob`)),
      ).toEqual(pdfBytes(1000, first.id));
      expect(
        await c.db.importSessionArtifact.findUniqueOrThrow({
          where: { id: second.id },
        }),
      ).toMatchObject({
        temporaryStorageKey: null,
        reservedBytes: 0,
        temporaryPurgePending: false,
      });
      resume.release();
      await bounded(close!);
      expect(handle.fd).toBe(-1);
    } finally {
      resume.release();
      jest.useRealTimers();
      if (close) await bounded(close);
      else if (handle && handle.fd !== -1) await handle.close();
      if (lease?.ok) lease.lease.exit();
      if (work) await bounded(outcome(work));
      drainSpy?.mockRestore();
      io.restore();
      await io.closeRemaining();
      await c.finish();
    }
  });

  it("G1 stop while a real probe is held prevents dispatch of a new writer or purge", async () => {
    const c = await context(),
      entered = gate(),
      resume = gate();
    let work: Promise<ReaperResult> | undefined;
    let spy: jest.SpyInstance | undefined;
    let transaction: jest.SpyInstance | undefined;
    const purge = jest.spyOn(c.authority.requirePurger(), "purge");
    try {
      const session = await seedSession(c.db, c.world, {
        expiresAt: new Date(FIXED_NOW.getTime() - 1),
      });
      const native = fsp.lstat.bind(fsp);
      spy = jest.spyOn(fsp, "lstat").mockImplementation((async (
        ...args: Parameters<typeof fsp.lstat>
      ) => {
        if (String(args[0]) === join(c.fixture.root, ".lock")) {
          entered.release();
          await resume.promise;
        }
        return native(...args);
      }) as typeof fsp.lstat);
      work = c.cycle.runCycle({ ...c.input, limit: 1 });
      await bounded(
        Promise.race([
          entered.promise,
          work.then(() => {
            throw new Error("stop case skipped native probe");
          }),
        ]),
      );
      await c.authority.shutdown();
      transaction = jest.spyOn(c.db, "$transaction");
      resume.release();
      const result = await outcome(work);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("stopped reaper returned success");
      expect(result.error).toBeInstanceOf(VaultIoError);
      expect(result.error).toMatchObject(
        new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" }),
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(purge).not.toHaveBeenCalled();
      expect(
        await c.db.importSession.findUniqueOrThrow({
          where: { id: session.id },
        }),
      ).toEqual(session);
    } finally {
      resume.release();
      if (work) await bounded(outcome(work));
      transaction?.mockRestore();
      spy?.mockRestore();
      purge.mockRestore();
      await c.finish();
    }
  });
});

const ROUTES = [
  ["POST", ""],
  ["GET", ""],
  ["GET", "/:id"],
  ["GET", "/:id/result"],
  ["POST", "/:id/cancel"],
  ["PATCH", "/:id/draft"],
  ["POST", "/:id/prepare"],
  ["GET", "/:id/observations"],
  ["GET", "/:id/candidates"],
  ["POST", "/:id/confirmation-challenge"],
  ["POST", "/:id/confirm"],
  ["POST", "/:id/execute"],
] as const;

function routes(controller: { prototype: object }): string[] {
  const prefix: string = Reflect.getMetadata(PATH_METADATA, controller) ?? "";
  expect(typeof prefix).toBe("string");
  return Object.getOwnPropertyNames(controller.prototype)
    .flatMap((name) => {
      const method = Reflect.get(controller.prototype, name);
      if (typeof method !== "function") return [];
      const verb: RequestMethod | undefined = Reflect.getMetadata(
        METHOD_METADATA,
        method,
      );
      if (verb === undefined) return [];
      const path: string = Reflect.getMetadata(PATH_METADATA, method);
      expect(typeof path).toBe("string");
      const suffix = `/${prefix}/${path}`
        .replace(/\/+/g, "/")
        .replace(/^\/import-sessions(?=\/|$)/, "")
        .replace(/\/$/, "");
      return [`${RequestMethod[verb]} ${suffix}`];
    })
    .sort();
}

describe("CONTROL existing twelve-route HTTP authority and private real factories", () => {
  let database: Awaited<ReturnType<typeof createVaultTestDatabase>> | undefined;
  let setup: PrismaService;
  let api: RecoveryApp | undefined;
  let world: ImportWorld;
  beforeAll(async () => {
    database = await createVaultTestDatabase();
    setup = database.setup;
    world = await seedImportWorld(setup, "attachment-controls");
    api = await bootVaultApp(setup, {
      writes: false,
      vault: "real",
      framing: true,
    });
  });
  afterAll(async () => {
    await finishVaultFixture(
      () => api?.close(),
      () => database?.close(),
    );
  });

  it.each(ROUTES)(
    "CONTROL %s %s remains authenticated while vault is OFF",
    async (method, suffix) => {
      const response = await api!.call(
        method,
        "/import-sessions" + suffix.replace(":id", randomUUID()),
        {
          headers: UI_HEADERS,
          ...(method === "GET" ? {} : { body: {} }),
        },
      );
      expect([response.status, response.json]).toEqual([
        401,
        wire("UNAUTHENTICATED"),
      ]);
    },
  );
  it("CONTROL the original controller still has exactly its twelve literal routes", () => {
    expect(routes(ImportSessionController)).toEqual(
      ROUTES.map(([verb, path]) => `${verb} ${path}`).sort(),
    );
  });
  it("CONTROL workflow and financial adapter are real private factories, not fixture stand-ins", () => {
    expect(api!.app.get(CARD_PURCHASE_BATCH_PORT)).toBeInstanceOf(
      CardPurchaseBatchAdapter,
    );
    expect(api!.app.get(ImportSessionWorkflowService)).toBeInstanceOf(
      ImportSessionWorkflowService,
    );
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, ImportSessionModule) ?? [],
    ).toEqual([ImportChatGuard, ImportChatBridge]);
  });
  it("CONTROL FRAMING rejects malformed JSON before the real Nest parser, with CORS and zero SQL while OFF", async () => {
    const queries: string[] = [];
    let watching = true;
    api!.app.get(PrismaService).$use(async (params, next) => {
      if (watching) queries.push(params.action);
      return next(params);
    });
    try {
      const response = await rawSocket(
        api!,
        [
          "PUT /import-sessions/missing/attachments/missing/content HTTP/1.1",
          "Host: 127.0.0.1",
          `Origin: ${RECOVERY_ORIGIN}`,
          "Content-Type: application/json",
          "Content-Length: 3",
          "Connection: close",
          "",
          "{x}",
        ].join("\r\n"),
      );
      expect(response.status).toBe(422);
      const body = /\{[\s\S]*\}/.exec(
        response.text.slice(response.text.indexOf("\r\n\r\n") + 4),
      );
      expect(body).not.toBeNull();
      expect(JSON.parse(body![0])).toEqual(wire("UNSUPPORTED_DOCUMENT"));
      expect(response.text).toMatch(
        /^Access-Control-Allow-Origin: http:\/\/localhost:3000\r?$/im,
      );
      expect(response.text).toMatch(
        /^Access-Control-Allow-Credentials: true\r?$/im,
      );
      expect(queries).toEqual([]);
    } finally {
      watching = false;
    }
  });
  it("CONTROL writes remain OFF while list/get/cancel recovery stays usable", async () => {
    const token = await api!.tokenFor(world.users.restricted);
    const session = await seedSession(setup, world, {
      ownerUserId: world.users.restricted.id,
    });
    expect((await api!.call("GET", "/import-sessions", { token })).status).toBe(
      200,
    );
    expect(
      (await api!.call("GET", `/import-sessions/${session.id}`, { token }))
        .status,
    ).toBe(200);
    const create = await api!.call("POST", "/import-sessions", {
      token,
      headers: UI_HEADERS,
      body: {},
    });
    expect([create.status, create.json]).toEqual([
      503,
      wire("CAPABILITY_DISABLED"),
    ]);
    expect(
      (
        await api!.call("POST", `/import-sessions/${session.id}/cancel`, {
          token,
          headers: UI_HEADERS,
          body: { expectedRevision: 1 },
        })
      ).status,
    ).toBe(200);
  });
});

describe("P05 independent attachment finalization, transfer and fresh authority", () => {
  let ordinal = 0;
  async function context() {
    loadVaultGate();
    const database = await createVaultTestDatabase();
    const setup = database.setup;
    let api: RecoveryApp | undefined;
    try {
      const world = await seedImportWorld(
        setup,
        `attachment-lifecycle-${++ordinal}`,
      );
      api = await bootVaultApp(setup, { writes: true, vault: CANONICAL_VAULT });
      const ownedApp = api;
      const authority = getVaultGate(api);
      const root = authority.boot.runtime()!.config.rootDir;
      const owner = world.users.restricted;
      const token = await api.tokenFor(owner);
      return {
        setup,
        world,
        api,
        authority,
        root,
        owner,
        token,
        async target(sessionId?: string) {
          const session = sessionId
            ? await setup.importSession.findUniqueOrThrow({
                where: { id: sessionId },
              })
            : await seedSession(setup, world, { ownerUserId: owner.id });
          const positions = await setup.importSessionArtifact.aggregate({
            where: { sessionId: session.id },
            _max: { position: true },
          });
          const id = await seedRef(setup, session, owner, {
            position: (positions._max.position ?? -1) + 1,
          });
          return { session, id };
        },
        async finish() {
          await finishVaultFixture(
            () => ownedApp.close(),
            () => database.close(),
          );
        },
      };
    } catch (error) {
      try {
        await finishVaultFixture(
          () => api?.close(),
          () => database.close(),
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Attachment fixture setup and cleanup failed",
        );
      }
      throw error;
    }
  }

  async function completed(
    c: Awaited<ReturnType<typeof context>>,
    target: { session: { id: string }; id: string },
    payload: Buffer,
  ) {
    const response = await putContent(c.api, target.session.id, target.id, {
      token: c.token,
      body: payload,
    });
    expect(response.status).toBe(200);
    const ref = await c.setup.importSessionArtifact.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(ref.state).toBe("ATTACHED");
    expect(ref.artifactId).not.toBeNull();
    const artifact = await c.setup.importArtifact.findUniqueOrThrow({
      where: { id: ref.artifactId! },
    });
    expect(artifact).toMatchObject({
      documentSha256: sha256Hex(payload),
      verifiedBytes: payload.length,
      detectedFormat: "PDF",
    });
    expect(await readStoredBlob(c.root, artifact.storageKey!)).toEqual(payload);
    expect(await storedMode(c.root, artifact.storageKey!)).toBe(0o600);
    return { response, ref, artifact };
  }

  async function byteChargeOrProvenRemoval(
    c: Awaited<ReturnType<typeof context>>,
    id: string,
  ) {
    const row = await c.setup.importSessionArtifact.findUniqueOrThrow({
      where: { id },
    });
    if (row.temporaryStorageKey !== null) {
      expect(row).toMatchObject({
        temporaryStorageKey: `t/${id}`,
        reservedBytes: 1000,
        temporaryPurgePending: true,
      });
    } else {
      expect(row).toMatchObject({
        reservedBytes: 0,
        temporaryPurgePending: false,
      });
      await expect(fsp.lstat(join(c.root, `t/${id}`))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fsp.lstat(join(c.root, `trash/r-${id}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  }

  it("three attachment handlers and ANALYZE extend twelve to exactly sixteen, without replacing the original graph", () => {
    const controllers: { prototype: object }[] = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ImportSessionModule,
    );
    const all = controllers.flatMap(routes);
    expect(all.sort()).toEqual(
      [
        ...ROUTES.map(([verb, path]) => `${verb} ${path}`),
        "GET /:id/attachments/:attachmentId/content",
        "POST /:id/attachments",
        "POST /:id/attachments/:attachmentId/analyze",
        "PUT /:id/attachments/:attachmentId/content",
      ].sort(),
    );
    expect(routes(ImportSessionController)).toHaveLength(12);
    expect(all.filter((route) => route.includes("attachments")).sort()).toEqual(
      [
        "GET /:id/attachments/:attachmentId/content",
        "POST /:id/attachments",
        "POST /:id/attachments/:attachmentId/analyze",
        "PUT /:id/attachments/:attachmentId/content",
      ],
    );
  });

  it("finalize adopts exact durable bytes, transfers accounting and exposes only the public view", async () => {
    const c = await context();
    try {
      const target = await c.target(),
        payload = pdfBytes(1000, "adoption");
      const done = await completed(c, target, payload);
      expect(done.ref).toMatchObject({
        temporaryStorageKey: null,
        reservedBytes: 0,
        temporaryPurgePending: false,
      });
      expect(done.artifact).toMatchObject({
        state: "RAW_READY",
        storageKey: `t/${target.id}/g2/blob`,
      });
      expect(done.response.json.revision).toBe(2);
      expect(done.response.json.attachments).toEqual([
        {
          id: target.id,
          fileName: "fatura.pdf",
          declaredBytes: 1000,
          state: "ATTACHED",
          materializedInSession: true,
          canAnalyze: false,
        },
      ]);
      const read = await getContent(
        c.api,
        c.token,
        target.session.id,
        target.id,
      );
      expect(read.status).toBe(200);
      expect(read.headers["content-type"]).toBe("application/octet-stream");
      expect(read.headers["content-length"]).toBe("1000");
      expect(read.headers["cache-control"]).toContain("no-store");
      expect(read.headers["x-content-type-options"]).toBe("nosniff");
      expect(read.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(Buffer.from(read.text, "utf8")).toEqual(payload);
    } finally {
      await c.finish();
    }
  });

  it("dedupe keeps the canonical winner, while a same-session duplicate is RELEASED and replays without effects", async () => {
    const c = await context();
    try {
      const first = await c.target(),
        payload = pdfBytes(1000, "same-document");
      const winner = await completed(c, first, payload);
      const other = await c.target();
      const second = await completed(c, other, payload);
      expect(second.artifact.id).toBe(winner.artifact.id);
      expect(second.artifact.storageKey).toBe(winner.artifact.storageKey);
      await byteChargeOrProvenRemoval(c, other.id);
      const duplicate = await c.target(first.session.id);
      const response = await putContent(c.api, first.session.id, duplicate.id, {
        token: c.token,
        body: payload,
      });
      expect(response.status).toBe(200);
      const row = await c.setup.importSessionArtifact.findUniqueOrThrow({
        where: { id: duplicate.id },
      });
      expect(row).toMatchObject({ state: "RELEASED", artifactId: null });
      expect(row.verifiedAt).not.toBeNull();
      expect(row.releasedAt).not.toBeNull();
      await byteChargeOrProvenRemoval(c, duplicate.id);
      expect(
        await c.setup.importArtifact.count({
          where: { tenantId: c.world.tenantId },
        }),
      ).toBe(1);
      const before = await fullDigest(c.setup, first.session.id);
      const stat = await fsp.stat(join(c.root, winner.artifact.storageKey!));
      expect(
        (
          await putContent(c.api, first.session.id, duplicate.id, {
            token: c.token,
            body: payload,
          })
        ).status,
      ).toBe(200);
      expect(await fullDigest(c.setup, first.session.id)).toEqual(before);
      expect(
        await fsp.stat(join(c.root, winner.artifact.storageKey!)),
      ).toMatchObject({ ino: stat.ino, mtimeMs: stat.mtimeMs, size: 1000 });
      expect(await readStoredBlob(c.root, winner.artifact.storageKey!)).toEqual(
        payload,
      );
    } finally {
      await c.finish();
    }
  });

  it.each(["PURGED", "PURGING"] as const)(
    "finalize against %s re-adopts or rejects without overwriting the artifact",
    async (state) => {
      const c = await context();
      try {
        const target = await c.target(),
          payload = pdfBytes(1000, "retained-state");
        const id = await seedArtifact(c.setup, target.session, { state });
        await c.setup.importArtifact.update({
          where: { id },
          data: { documentSha256: sha256Hex(payload), parseGeneration: 7 },
        });
        const before = await c.setup.importArtifact.findUniqueOrThrow({
          where: { id },
        });
        const response = await putContent(c.api, target.session.id, target.id, {
          token: c.token,
          body: payload,
        });
        if (state === "PURGED") {
          expect(response.status).toBe(200);
          expect(
            await c.setup.importArtifact.findUniqueOrThrow({ where: { id } }),
          ).toMatchObject({
            id,
            state: "RAW_READY",
            storageKey: `t/${target.id}/g2/blob`,
            parseGeneration: 7,
            documentSha256: sha256Hex(payload),
            verifiedBytes: 1000,
          });
          expect((await refsOf(c.setup, target.session.id))[0].artifactId).toBe(
            id,
          );
        } else {
          expect([response.status, response.json]).toEqual([
            503,
            wire("RETRYABLE_WRITE_CONFLICT"),
          ]);
          expect(
            await c.setup.importArtifact.findUniqueOrThrow({ where: { id } }),
          ).toEqual(before);
          expect(
            await c.setup.importSessionArtifact.findUniqueOrThrow({
              where: { id: target.id },
            }),
          ).toMatchObject({
            state: "FAILED",
            uploadGeneration: 3,
            uploadLeaseExpiresAt: null,
            artifactId: null,
          });
          await byteChargeOrProvenRemoval(c, target.id);
        }
      } finally {
        await c.finish();
      }
    },
  );

  it.each(["cancel", "transfer"] as const)(
    "post-close finalize loses to %s without changing the committed winner",
    async (operation) => {
      const c = await context(),
        closed = gate(),
        resume = gate();
      const native = c.authority.storage.writeClaim.bind(c.authority.storage);
      const spy = jest
        .spyOn(c.authority.storage, "writeClaim")
        .mockImplementation(async (...args) => {
          const result = await native(...args);
          closed.release();
          await resume.promise;
          return result;
        });
      let work: ReturnType<typeof putContent> | undefined;
      try {
        const target = await c.target();
        work = putContent(c.api, target.session.id, target.id, {
          token: c.token,
          body: pdfBytes(1000, "loser"),
        });
        await bounded(closed.promise, "real write and close before finalize");
        expect(c.authority.registry.snapshotUploads()).toEqual([]);
        if (operation === "cancel") {
          expect(
            (
              await c.api.call(
                "POST",
                `/import-sessions/${target.session.id}/cancel`,
                {
                  token: c.token,
                  headers: UI_HEADERS,
                  body: { expectedRevision: 1 },
                },
              )
            ).status,
          ).toBe(200);
        } else {
          const successor = await seedSession(c.setup, c.world, {
            ownerUserId: c.owner.id,
          });
          await c.setup.importSessionArtifact.update({
            where: { id: target.id },
            data: {
              sessionId: successor.id,
              uploadGeneration: { increment: 1 },
            },
          });
        }
        const winner = await c.setup.importSessionArtifact.findUniqueOrThrow({
          where: { id: target.id },
        });
        resume.release();
        const reply = await bounded(work);
        expect([reply.status, reply.json]).toEqual([
          409,
          wire("LEASE_CONFLICT"),
        ]);
        expect(
          await c.setup.importSessionArtifact.findUniqueOrThrow({
            where: { id: target.id },
          }),
        ).toEqual(winner);
        expect(
          await c.setup.importArtifact.count({
            where: { tenantId: c.world.tenantId },
          }),
        ).toBe(0);
      } finally {
        resume.release();
        if (work) await bounded(outcome(work));
        spy.mockRestore();
        await c.finish();
      }
    },
  );

  it("G2 artifact readoption zero native rows rolls back the prior finalize ref CAS of one", async () => {
    const c = await context();
    const io = observeIo(c.root);
    let observing = false;
    try {
      const target = await c.target();
      const payload = pdfBytes(1000, "zero-artifact-cas");
      const id = await seedArtifact(c.setup, target.session, {
        state: "PURGED",
      });
      await c.setup.importArtifact.update({
        where: { id },
        data: { documentSha256: sha256Hex(payload), parseGeneration: 7 },
      });
      const beforeArtifact = await c.setup.importArtifact.findUniqueOrThrow({
        where: { id },
      });
      const beforeSession = await c.setup.importSession.findUniqueOrThrow({
        where: { id: target.session.id },
      });
      const steps: { model: string; count: number }[] = [];
      let injected = false;
      const db = c.api.app.get(PrismaService);
      db.$use(async (params, next) => {
        if (!observing || params.action !== "updateMany") return next(params);
        const closed = io.events.some(
          (e) =>
            e.op === "close:done" &&
            e.path === join(c.root, `t/${target.id}/g2/blob`),
        );
        if (!closed) return next(params);
        if (params.model === "ImportSessionArtifact" && !injected) {
          expect(params.runInTransaction).toBe(true);
          const result: { count: number } = await next(params);
          steps.push({ model: "finalize-ref", count: result.count });
          return result;
        }
        if (params.model === "ImportArtifact") {
          const args: Prisma.ImportArtifactUpdateManyArgs = params.args;
          if (args.data.state === "RAW_READY") {
            expect(params.runInTransaction).toBe(true);
            expect(steps).toEqual([{ model: "finalize-ref", count: 1 }]);
            expect(injected).toBe(false);
            injected = true;
            const result: { count: number } = await next({
              ...params,
              args: {
                ...args,
                where: { AND: [args.where ?? {}, { id }, { id: { not: id } }] },
              },
            });
            steps.push({ model: "artifact-readoption", count: result.count });
            return result;
          }
        }
        return next(params);
      });
      observing = true;
      const response = await putContent(c.api, target.session.id, target.id, {
        token: c.token,
        body: payload,
      });
      observing = false;
      expect(steps).toEqual([
        { model: "finalize-ref", count: 1 },
        { model: "artifact-readoption", count: 0 },
      ]);
      expect([response.status, response.json]).toEqual([
        503,
        wire("RETRYABLE_WRITE_CONFLICT"),
      ]);
      expect(
        await c.setup.importArtifact.findUniqueOrThrow({ where: { id } }),
      ).toEqual(beforeArtifact);
      expect(
        await c.setup.importSession.findUniqueOrThrow({
          where: { id: target.session.id },
        }),
      ).toEqual(beforeSession);
      expect(
        await c.setup.importSessionArtifact.findUniqueOrThrow({
          where: { id: target.id },
        }),
      ).toMatchObject({
        state: "FAILED",
        uploadGeneration: 3,
        artifactId: null,
        verifiedAt: null,
        uploadLeaseExpiresAt: null,
      });
      expect(
        await c.setup.importSessionArtifact.count({
          where: { sessionId: target.session.id, state: "ATTACHED" },
        }),
      ).toBe(0);
      expect(
        io.events.filter(
          (e) => e.op === "sync:done" && e.path.endsWith("/blob"),
        ),
      ).toHaveLength(1);
      expect(
        io.events.filter(
          (e) => e.op === "close:done" && e.path.endsWith("/blob"),
        ),
      ).toHaveLength(1);
      await byteChargeOrProvenRemoval(c, target.id);
    } finally {
      observing = false;
      io.restore();
      await io.closeRemaining();
      await c.finish();
    }
  });

  it("an open native blob holds no writer; a concurrent revision change survives relative finalize", async () => {
    const c = await context(),
      opened = gate(),
      resume = gate();
    const io = observeIo(c.root, {
      afterOpen: async (path) => {
        if (path.endsWith("/blob")) {
          opened.release();
          await resume.promise;
        }
      },
    });
    let work: ReturnType<typeof putContent> | undefined;
    try {
      const target = await c.target();
      work = putContent(c.api, target.session.id, target.id, {
        token: c.token,
      });
      await bounded(opened.promise);
      await bounded(
        c.setup.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.world.tenantId}`;
          await tx.importSession.update({
            where: { id: target.session.id },
            data: { revision: { increment: 7 } },
          });
        }),
        "competitor writer while native open is held",
      );
      resume.release();
      const result = await bounded(work);
      expect(result.status).toBe(200);
      expect(result.json.revision).toBe(9);
      expect(
        (
          await c.setup.importSession.findUniqueOrThrow({
            where: { id: target.session.id },
          })
        ).revision,
      ).toBe(9);
    } finally {
      resume.release();
      if (work) await bounded(outcome(work));
      io.restore();
      await io.closeRemaining();
      await c.finish();
    }
  });

  it.each(["reserve", "claim", "download"] as const)(
    "ADDENDUM %s releases its initial writer before the real probe and freshly rejects changed ACL",
    async (operation) => {
      const c = await context(),
        entered = gate(),
        resume = gate();
      const native = fsp.lstat.bind(fsp);
      let work: Promise<{ status: number; json: unknown }> | undefined;
      let spy: jest.SpyInstance | undefined;
      try {
        const target = await c.target();
        if (operation === "download")
          await completed(c, target, pdfBytes(1000, "download"));
        const before = await fullDigest(c.setup, target.session.id);
        spy = jest.spyOn(fsp, "lstat").mockImplementation((async (
          ...args: Parameters<typeof fsp.lstat>
        ) => {
          if (String(args[0]) === join(c.root, ".lock")) {
            entered.release();
            await resume.promise;
          }
          return native(...args);
        }) as typeof fsp.lstat);
        work =
          operation === "reserve"
            ? reserve(c.api, c.token, target.session.id, [fileSeed()], {
                expectedRevision: before.session.revision,
              })
            : operation === "claim"
              ? putContent(c.api, target.session.id, target.id, {
                  token: c.token,
                })
              : getContent(c.api, c.token, target.session.id, target.id);
        await bounded(
          Promise.race([
            entered.promise,
            work.then((reply) => {
              throw new Error(
                `request ended before real probe: ${reply.status} ${JSON.stringify(reply.json)}`,
              );
            }),
          ]),
        );
        await bounded(
          c.setup.$transaction(async (tx) => {
            await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.world.tenantId}`;
            await tx.user.update({
              where: { id: c.owner.id },
              data: {
                allowedProjects: JSON.stringify([c.world.projects.casa]),
              },
            });
          }),
          "competitor commits while the real probe is pending",
        );
        resume.release();
        const reply = await bounded(work);
        expect([reply.status, reply.json]).toEqual([404, wire("NOT_FOUND")]);
        expect(await fullDigest(c.setup, target.session.id)).toEqual(before);
      } finally {
        resume.release();
        if (work) await bounded(outcome(work));
        spy?.mockRestore();
        await c.finish();
      }
    },
  );

  it("ADDENDUM fresh post-enter callback rejects revoked ACL before any blob is opened", async () => {
    const c = await context(),
      entered = gate(),
      resume = gate();
    const native = c.authority.storage.writeClaim.bind(c.authority.storage);
    const io = observeIo(c.root);
    const spy = jest
      .spyOn(c.authority.storage, "writeClaim")
      .mockImplementation((claim, source, recheck) =>
        native(claim, source, async (capture) => {
          entered.release();
          await resume.promise;
          await recheck(capture);
        }),
      );
    let work: ReturnType<typeof putContent> | undefined;
    try {
      const target = await c.target();
      work = putContent(c.api, target.session.id, target.id, {
        token: c.token,
      });
      await bounded(entered.promise);
      expect(c.authority.registry.snapshotUploads()).toHaveLength(1);
      await c.setup.user.update({
        where: { id: c.owner.id },
        data: { allowedProjects: JSON.stringify([c.world.projects.casa]) },
      });
      resume.release();
      const reply = await bounded(work);
      expect([reply.status, reply.json]).toEqual([404, wire("NOT_FOUND")]);
      expect(
        io.events.filter((e) => e.op === "open" && e.path.endsWith("/blob")),
      ).toEqual([]);
      expect(
        await c.setup.importArtifact.count({
          where: { tenantId: c.world.tenantId },
        }),
      ).toBe(0);
    } finally {
      resume.release();
      if (work) await bounded(outcome(work));
      spy.mockRestore();
      io.restore();
      await io.closeRemaining();
      await c.finish();
    }
  });

  it("ADDENDUM shutdown after actual close starts no finalize, self-fence or refund transaction", async () => {
    const c = await context(),
      closed = gate(),
      resume = gate();
    const native = c.authority.storage.writeClaim.bind(c.authority.storage);
    const spy = jest
      .spyOn(c.authority.storage, "writeClaim")
      .mockImplementation(async (...args) => {
        const stored = await native(...args);
        closed.release();
        await resume.promise;
        return stored;
      });
    const db = c.api.app.get(PrismaService);
    let transaction: jest.SpyInstance | undefined;
    let work: ReturnType<typeof putContent> | undefined;
    try {
      const target = await c.target();
      work = putContent(c.api, target.session.id, target.id, {
        token: c.token,
      });
      await bounded(closed.promise);
      const before = await c.setup.importSessionArtifact.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(before).toMatchObject({
        state: "RESERVED",
        uploadGeneration: 2,
        reservedBytes: 1000,
        temporaryPurgePending: false,
      });
      expect(c.authority.registry.snapshotUploads()).toEqual([]);
      transaction = jest.spyOn(db, "$transaction");
      expect(await c.authority.shutdown()).toBe("DRAINED");
      resume.release();
      const response = await bounded(work);
      expect([response.status, response.json]).toEqual([
        503,
        wire("CAPABILITY_DISABLED"),
      ]);
      expect(transaction).not.toHaveBeenCalled();
      expect(
        await c.setup.importSessionArtifact.findUniqueOrThrow({
          where: { id: target.id },
        }),
      ).toEqual(before);
      expect(
        await c.setup.importArtifact.count({
          where: { tenantId: c.world.tenantId },
        }),
      ).toBe(0);
      expect(
        (await fsp.stat(join(c.root, `t/${target.id}/g2/blob`))).size,
      ).toBe(1000);
    } finally {
      resume.release();
      if (work) await bounded(outcome(work));
      transaction?.mockRestore();
      spy.mockRestore();
      await c.finish();
    }
  });

  it("G4 GET post-enter A callback freshly rejects revoked ACL before native reauthorization starts", async () => {
    const c = await context(),
      entered = gate(),
      resume = gate();
    let work: ReturnType<typeof getContent> | undefined;
    const spies: jest.SpyInstance[] = [];
    let io: ReturnType<typeof observeIo> | undefined;
    try {
      const target = await c.target();
      const payload = pdfBytes(1000, "post-enter-download");
      const done = await completed(c, target, payload);
      const before = await fullDigest(c.setup, target.session.id);
      io = observeIo(c.root);
      const nativeEnter = c.authority.registry.enter.bind(c.authority.registry);
      let admitted = false;
      spies.push(
        jest
          .spyOn(c.authority.registry, "enter")
          .mockImplementation((key, owner) => {
            const result = nativeEnter(key, owner);
            if (key === `A:${done.artifact.id}` && result.ok) admitted = true;
            return result;
          }),
      );
      const nativeRead = c.authority.storage.withArtifactReader.bind(
        c.authority.storage,
      );
      spies.push(
        jest
          .spyOn(c.authority.storage, "withArtifactReader")
          .mockImplementation(
            <T>(
              capture: VaultArtifactRead,
              recheck: VaultArtifactRecheck,
              consume: VaultReadConsumer<T>,
            ) =>
              nativeRead(
                capture,
                async (fresh) => {
                  expect(admitted).toBe(true);
                  entered.release();
                  await resume.promise;
                  await recheck(fresh);
                },
                consume,
              ),
          ),
      );
      work = getContent(c.api, c.token, target.session.id, target.id);
      await bounded(
        Promise.race([
          entered.promise,
          work.then((reply) => {
            throw new Error(
              `GET ended before admitted A recheck: ${reply.status}`,
            );
          }),
        ]),
      );
      await bounded(
        c.setup.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE tenants SET id=id WHERE id=${c.world.tenantId}`;
          await tx.user.update({
            where: { id: c.owner.id },
            data: { allowedProjects: JSON.stringify([c.world.projects.casa]) },
          });
        }),
        "ACL writer commits before original post-enter callback starts",
      );
      resume.release();
      const response = await bounded(work);
      expect([response.status, response.json]).toEqual([
        404,
        wire("NOT_FOUND"),
      ]);
      expect(
        io.events.filter((e) => e.op === "open" && e.path.endsWith("/blob")),
      ).toEqual([]);
      expect(await fullDigest(c.setup, target.session.id)).toEqual(before);
      expect(await readStoredBlob(c.root, done.artifact.storageKey!)).toEqual(
        payload,
      );
    } finally {
      resume.release();
      if (work) await bounded(outcome(work));
      spies.reverse().forEach((spy) => spy.mockRestore());
      io?.restore();
      await io?.closeRemaining();
      await c.finish();
    }
  });

  it("a fresh canonical coordinator recovers charged committed temporary state without touching an ATTACHED winner", async () => {
    const c = await context();
    let restart: Awaited<ReturnType<typeof canonicalVaultFixture>> | undefined;
    try {
      const winner = await c.target();
      const done = await completed(
        c,
        winner,
        pdfBytes(1000, "retained-winner"),
      );
      const failed = await c.target();
      await c.setup.importSessionArtifact.update({
        where: { id: failed.id },
        data: {
          state: "FAILED",
          uploadGeneration: 3,
          temporaryPurgePending: true,
          uploadLeaseExpiresAt: null,
        },
      });
      await fsp.mkdir(join(c.root, `t/${failed.id}/g2`), {
        recursive: true,
        mode: 0o700,
      });
      await fsp.writeFile(
        join(c.root, `t/${failed.id}/g2/blob`),
        pdfBytes(1000, "failed"),
        { mode: 0o600 },
      );
      const snapshot = await c.setup.importArtifact.findUniqueOrThrow({
        where: { id: done.artifact.id },
      });
      expect(await c.authority.shutdown()).toBe("DRAINED");
      expect(c.authority.registry.snapshotUploads()).toEqual([]);
      restart = await canonicalVaultFixture(c.root);
      const recovered = restart.createGate(c.setup, c.api.clock);
      await bounded(recovered.boot.settled);
      expect(recovered.registry).not.toBe(c.authority.registry);
      expect(await recovered.boot.recheckLock()).toMatchObject({ ok: true });
      expect(
        await recovered.requirePurger().purge({
          kind: "ref",
          tenantId: c.world.tenantId,
          ownerProjectId: failed.session.ownerProjectId,
          id: failed.id,
        }),
      ).toBe("PURGED");
      expect(
        await c.setup.importSessionArtifact.findUniqueOrThrow({
          where: { id: failed.id },
        }),
      ).toMatchObject({
        state: "FAILED",
        reservedBytes: 0,
        temporaryStorageKey: null,
        temporaryPurgePending: false,
      });
      expect(
        await c.setup.importArtifact.findUniqueOrThrow({
          where: { id: done.artifact.id },
        }),
      ).toEqual(snapshot);
      expect(await readStoredBlob(c.root, done.artifact.storageKey!)).toEqual(
        pdfBytes(1000, "retained-winner"),
      );
    } finally {
      try {
        await restart?.close();
      } finally {
        await c.finish();
      }
    }
  });
});
