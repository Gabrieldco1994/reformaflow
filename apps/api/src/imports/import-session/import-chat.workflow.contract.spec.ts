const testDbGuard: {
  REPO_ROOT: string;
  ACTIVE_DB_PATH: string;
} = require("../../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { HttpException, type CanActivate } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Prisma } from "@prisma/client";
import {
  ExpenseType,
  type ImportChatOutcomeV1,
  type ImportChatTurnV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  computeImportOrdinals,
  fileContentHash,
} from "../../credit-card/parsers/dedupe-key";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import { PrismaService } from "../../prisma/prisma.service";
import {
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootRecoveryApp,
  UI_HEADERS,
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";
import {
  ImportAuthGuard,
  assertMintedImportContext,
} from "./import-session.auth";
import type { AuthenticatedImportContext } from "./import-session.contract";
import type { StoredImportObservationEvidenceV1 } from "./import-session.observation";
import * as writer from "./import-session.writer";
import { AgentController } from "../../agent/agent.controller";
import { ImportSessionError } from "./import-session.errors";

const evidenceRoot =
  process.env.P08_QA_EVIDENCE ??
  resolve(testDbGuard.REPO_ROOT, ".agents/p08-contextual-evidence");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidenceDirectory = mkdtempSync(resolve(evidenceRoot, "workflow-"));
const suiteRun = basename(evidenceDirectory);

type Operation = "EDIT" | "PREPARE";
type Binding = Readonly<{
  admission: object;
  operation: Operation;
  sessionId: string;
  expectedRevision: number;
}>;
interface LiveModule {
  assertLiveImportConversationWrite(
    binding: Binding,
    auth: AuthenticatedImportContext,
    now: Date,
  ): void;
}
interface Bridge {
  contextForRequest(request: object): object | null;
  editAnswer(
    admission: object,
    interpretation: unknown,
  ): Promise<ImportChatOutcomeV1>;
  prepare(admission: object): Promise<ImportChatOutcomeV1>;
  release(admission: object): void;
}

function requiredExport(file: string, name: string): Function {
  const path = resolve(__dirname, file);
  expect({ file, implemented: existsSync(path) }).toEqual({
    file,
    implemented: true,
  });
  const exports: object = require(path);
  const value: unknown = Reflect.get(exports, name);
  expect(typeof value).toBe("function");
  if (typeof value !== "function") throw new Error(`Missing ${name}`);
  return value;
}

function liveModule(): LiveModule {
  requiredExport(
    "import-chat.admission.ts",
    "assertLiveImportConversationWrite",
  );
  return require("./import-chat.admission");
}

function proveDb(label: string) {
  const expected = testDbGuard.ACTIVE_DB_PATH;
  expect(process.env.DATABASE_URL).toBe(`file:${expected}`);
  const raw = execFileSync(
    "lsof",
    ["-nP", "-a", "-p", String(process.pid), "-Fn"],
    { encoding: "utf8" },
  );
  writeFileSync(resolve(evidenceDirectory, `${label}.lsof`), raw, {
    mode: 0o600,
    flag: "wx",
  });
  const names = raw
    .split("\n")
    .filter((line) => /^n.*\.(db|sqlite3?)(-(wal|shm|journal))?$/.test(line))
    .map((line) => line.slice(1));
  expect(names).toContain(expected);
  expect(
    names.filter(
      (name) =>
        ![
          expected,
          `${expected}-wal`,
          `${expected}-shm`,
          `${expected}-journal`,
        ].includes(name),
    ),
  ).toEqual([]);
}

describe("P08 complementary workflow: live admission in the real writer", () => {
  const setup = new PrismaService();
  let h: RecoveryApp;
  let db: PrismaService;
  let world: ImportWorld;
  let sessionId: string;
  let draft: ImportSessionStoredDraftV1;
  let sequence = 0;
  let hook: ((params: Prisma.MiddlewareParams) => void) | undefined;
  const events: string[] = [];
  let active: { bridge: Bridge; admission: object } | undefined;

  beforeAll(async () => {
    jest.useFakeTimers({
      now: FIXED_NOW,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    await setup.$connect();
    proveDb("workflow-setup-first-connect-before-seed");
    h = await bootRecoveryApp(setup, {
      writesEnabled: true,
      beforeListen: async (app) => {
        await app.init();
        db = app.get(PrismaService);
        proveDb("workflow-app-first-connect-before-seed");
        expect(
          (await db.$queryRaw<Array<{ file: string }>>`PRAGMA database_list`)
            .map((row) => row.file)
            .filter(Boolean),
        ).toEqual([testDbGuard.ACTIVE_DB_PATH]);
        db.$use(async (params, next) => {
          const result: unknown = await next(params);
          events.push(`${params.model ?? "SQL"}.${params.action}`);
          hook?.(params);
          return result;
        });
      },
    });
    proveDb("workflow-boot-before-request");
  });

  beforeEach(async () => {
    sequence++;
    hook = undefined;
    events.length = 0;
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External fetch forbidden"));
    h.clock.current = new Date(FIXED_NOW);
    world = await seedImportWorld(
      setup,
      `p08-workflow-${suiteRun}-${sequence}`,
    );
    await setup.creditCard.update({
      where: { id: world.cards.pessoal },
      data: { closingDay: 27, dueDay: 5 },
    });
    const row = await seedSession(setup, world, {
      revision: 7,
      lastUserEditAt: new Date(FIXED_NOW.getTime() - 60_000),
    });
    sessionId = row.id;
    const bytes = Buffer.from("Synthetic purchase 60000 cents / 3");
    const artifact = await setup.importArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
        verifiedBytes: bytes.length,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        parserVersion: "card-local-text-v1",
      },
    });
    await setup.importSessionArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId,
        artifactId: artifact.id,
        position: 0,
        state: "ATTACHED",
        fileName: "synthetic.csv",
        declaredMime: "text/csv",
        declaredBytes: bytes.length,
        reservedBytes: bytes.length,
        verifiedAt: FIXED_NOW,
      },
    });
    const evidence: StoredImportObservationEvidenceV1 = {
      version: 1,
      reference: "csv:record:2",
      text: "Synthetic purchase",
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 60000,
      installmentCount: 3,
      installmentIndex: null,
      dataCompra: "2026-09-25",
      identity: {
        merchant: "Synthetic purchase",
        externalId: null,
        fitId: null,
        ordinal: computeImportOrdinals([
          {
            date: new Date("2026-09-25"),
            merchant: "Synthetic purchase",
            amountCents: 60000,
          },
        ])[0],
        fileContentHash: fileContentHash([bytes]),
      },
    };
    const extraction = validateDocumentExtraction({
      version: 1,
      parserVersion: "card-local-text-v1",
      documentKind: "UNKNOWN",
      invoiceDueMonth: null,
      metrics: {
        pages: 0,
        rows: 1,
        expandedBytes: 0,
        archiveEntries: 0,
        imagePixels: 0,
        frames: 0,
      },
      occurrences: [
        {
          reference: evidence.reference,
          sourceOrdinal: 0,
          section: "UNKNOWN",
          raw: {
            date: evidence.dataCompra,
            description: evidence.text,
            amount: "60000 cents",
            installment: null,
          },
          cycle: null,
          dateOnly: evidence.dataCompra,
          merchant: evidence.identity.merchant,
          amountCents: evidence.amountCents,
          amountMeaning: evidence.amountMeaning,
          installmentCount: evidence.installmentCount,
          installmentIndex: evidence.installmentIndex,
          fitId: evidence.identity.fitId,
          identityOrdinal: evidence.identity.ordinal,
        },
      ],
      diagnostics: [],
    });
    await setup.importArtifact.update({
      where: { id: artifact.id },
      data: { extractionJson: JSON.stringify(extraction) },
    });
    const observation = await setup.importObservation.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
      },
    });
    draft = {
      version: 1,
      lines: [
        {
          id: "purchase",
          observationIds: [observation.id],
          titulo: "Synthetic purchase",
          fornecedor: "Synthetic purchase",
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 60000,
          installmentCount: 3,
          dataCompra: "2026-09-25",
          firstDueDate: "2026-11-05",
          targets: [],
          decision: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      ],
      selectedLineIds: ["purchase"],
      questions: [
        {
          id: "amount-question",
          field: "amountCents",
          lineIds: ["purchase"],
          text: "Synthetic question",
        },
      ],
      scope: { observationIds: [observation.id], pendingAttachmentIds: [] },
    };
    await setup.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
  });

  afterEach(() => {
    hook = undefined;
    if (active) active.bridge.release(active.admission);
    active = undefined;
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await h?.close();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  async function admit(operation: Operation, literal = "206,96") {
    const guard = h.app.get<CanActivate>(
      requiredExport("import-chat.guard.ts", "ImportChatGuard"),
    );
    const bridge = h.app.get<Bridge>(
      requiredExport("import-chat.bridge.ts", "ImportChatBridge"),
    );
    const common = {
      version: 1 as const,
      turnId: "11111111-1111-4111-8111-111111111111",
      sessionId,
      expectedRevision: 7,
      channel: "TEXT" as const,
      literalAnswer: literal,
    };
    const turn: ImportChatTurnV1 =
      operation === "EDIT"
        ? {
            ...common,
            intent: "ANSWER",
            focus: {
              id: "amount-question",
              field: "amountCents",
              lineIds: ["purchase"],
            },
            scope: { kind: "LINES", lineIds: ["purchase"] },
          }
        : { ...common, intent: "OPEN_REVIEW", focus: null, scope: null };
    // Synthetic verified claims enter the REAL existing auth guard; no alternate admission minter.
    const request = {
      method: "POST",
      url: "/agent/chat",
      originalUrl: "/agent/chat",
      route: { path: "/agent/chat" },
      headers: { ...UI_HEADERS },
      body: {
        messages: [{ role: "user", content: literal }],
        importTurn: turn,
      },
      user: {
        id: world.users.owner.id,
        tenantId: world.tenantId,
        role: "OWNER",
        authClaims: {
          sessionVersion: world.users.owner.sessionVersion,
          expiresAtEpochSeconds: FIXED_NOW.getTime() / 1000 + 3600,
        },
      },
    };
    const context = new ExecutionContextHost(
      [request],
      AgentController,
      AgentController.prototype.chat,
    );
    expect(new ImportAuthGuard().canActivate(context)).toBe(true);
    const key = Object.getOwnPropertySymbols(request).find(
      (symbol) => symbol.description === "IMPORT_AUTH_CONTEXT",
    );
    if (!key) throw new Error("Real guard did not attach auth");
    const auth: unknown = Reflect.get(request, key);
    assertMintedImportContext(auth);
    expect(await guard.canActivate(context)).toBe(true);
    const admission = bridge.contextForRequest(request);
    expect(admission).not.toBeNull();
    if (!admission) throw new Error("Missing active admission");
    active = { bridge, admission };
    const interpretation = {
      kind: "VALUE",
      field: "amountCents",
      evidence: { start: 0, end: literal.length },
      value: { span: { start: 0, end: literal.length }, text: literal },
    };
    const invoke = () =>
      operation === "EDIT"
        ? bridge.editAnswer(admission, interpretation)
        : bridge.prepare(admission);
    return { bridge, admission, auth, interpretation, invoke };
  }

  async function digest() {
    return {
      row: await setup.importSession.findUniqueOrThrow({
        where: { id: sessionId },
      }),
      observations: await setup.importObservation.findMany({
        where: { tenantId: world.tenantId },
        orderBy: { id: "asc" },
      }),
      expenses: await setup.expense.count({
        where: { tenantId: world.tenantId },
      }),
      receipts: await setup.receipt.count({
        where: { tenantId: world.tenantId },
      }),
      cash: await setup.cashFlowEntry.count({
        where: { tenantId: world.tenantId },
      }),
    };
  }

  function traceWriter() {
    const original = writer.runImportSessionWrite;
    const transaction = jest.spyOn(db, "$transaction");
    const frames: Array<{
      transactions: number;
      work: number;
      guard: (() => undefined) | undefined;
      auth: object;
    }> = [];
    jest
      .spyOn(writer, "runImportSessionWrite")
      .mockImplementation(async function <T>(
        prisma: Parameters<typeof original>[0],
        clock: Parameters<typeof original>[1],
        auth: Parameters<typeof original>[2],
        work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
        guard?: () => undefined,
      ): Promise<T> {
        const first = transaction.mock.calls.length;
        const frame = { transactions: 0, work: 0, guard, auth };
        frames.push(frame);
        try {
          return await original(
            prisma,
            clock,
            auth,
            (tx, now) => {
              frame.work++;
              return work(tx, now);
            },
            guard,
          );
        } finally {
          frame.transactions = transaction.mock.calls.length - first;
        }
      });
    return frames;
  }

  it.each(["missing", "unrecognized"] as const)(
    "SEC2 unknown %s handler never acquires admission or performs an operation",
    async (kind) => {
      const guard = h.app.get<CanActivate>(
        requiredExport("import-chat.guard.ts", "ImportChatGuard"),
      );
      const bridge = h.app.get<Bridge>(
        requiredExport("import-chat.bridge.ts", "ImportChatBridge"),
      );
      const turn: ImportChatTurnV1 = {
        version: 1,
        turnId: "11111111-1111-4111-8111-111111111111",
        sessionId,
        expectedRevision: 7,
        intent: "CONTINUE",
        channel: "TEXT",
        literalAnswer: "Continuar",
        focus: null,
        scope: null,
      };
      // Claims are synthetic; only handler binding and denial are under test here.
      const request = {
        method: "POST",
        url: "/agent/chat",
        originalUrl: "/agent/chat",
        route: { path: "/agent/chat" },
        headers: { ...UI_HEADERS },
        body: {
          messages: [{ role: "user", content: "Continuar" }],
          importTurn: turn,
        },
        user: {
          id: world.users.owner.id,
          tenantId: world.tenantId,
          role: "OWNER",
          authClaims: {
            sessionVersion: world.users.owner.sessionVersion,
            expiresAtEpochSeconds: FIXED_NOW.getTime() / 1000 + 3600,
          },
        },
      };
      const context =
        kind === "missing"
          ? new ExecutionContextHost([request])
          : new ExecutionContextHost(
              [request],
              AgentController,
              () => undefined,
            );
      expect(new ImportAuthGuard().canActivate(context)).toBe(true);
      const before = await digest();
      const frames = traceWriter();
      const edit = jest.spyOn(bridge, "editAnswer");
      const prepare = jest.spyOn(bridge, "prepare");
      for (const [invoke, deniedReturn] of [
        [() => guard.canActivate(context), false],
        [() => bridge.contextForRequest(request), null],
      ] as const) {
        const [result] = await Promise.allSettled([
          Promise.resolve().then<unknown>(invoke),
        ]);
        if (result.status === "fulfilled") {
          expect(result.value).toBe(deniedReturn);
        } else {
          const error: unknown = result.reason;
          if (error instanceof HttpException) {
            expect([401, 403]).toContain(error.getStatus());
          } else {
            expect(error).toBeInstanceOf(ImportSessionError);
            expect(error).toMatchObject({
              code: expect.stringMatching(
                /^(UNAUTHENTICATED|UI_ACTION_REQUIRED)$/,
              ),
            });
          }
        }
      }
      expect(edit).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(frames).toEqual([]);
      expect(await digest()).toEqual(before);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  for (const operation of ["EDIT", "PREPARE"] as const) {
    it.each([
      "before-attempt",
      "after-reservation",
      "before-mutation",
      "before-return",
    ] as const)(
      `${operation}: release at %s is LIVE, with rollback of an open transaction`,
      async (point) => {
        const live = liveModule();
        const turn = await admit(operation);
        const before = await digest();
        const frames = traceWriter();
        const original = live.assertLiveImportConversationWrite;
        let checks = 0;
        const bindings: Binding[] = [];
        jest
          .spyOn(live, "assertLiveImportConversationWrite")
          .mockImplementation((binding, auth, now) => {
            checks++;
            bindings.push(binding);
            expect(auth).toBe(turn.auth);
            expect(Object.isFrozen(binding)).toBe(true);
            expect(binding).toMatchObject({
              admission: turn.admission,
              operation,
              sessionId,
              expectedRevision: 7,
            });
            if (
              (point === "before-attempt" && checks === 1) ||
              (point === "before-mutation" && checks === 3) ||
              (point === "before-return" && checks === 4)
            )
              turn.bridge.release(turn.admission);
            original(binding, auth, now);
          });
        hook = (params) => {
          if (point === "after-reservation" && params.action === "executeRaw")
            turn.bridge.release(turn.admission);
        };
        events.length = 0;
        await expect(turn.invoke()).rejects.toMatchObject({
          code: "UI_ACTION_REQUIRED",
        });
        expect(frames).toHaveLength(1);
        expect(frames[0]?.guard).toEqual(expect.any(Function));
        expect(frames[0]?.auth).toBe(turn.auth);
        expect(frames[0]?.transactions).toBe(
          point === "before-attempt" ? 0 : 1,
        );
        expect(
          events.filter((event) => event === "SQL.executeRaw"),
        ).toHaveLength(point === "before-attempt" ? 0 : 1);
        expect(
          events.filter((event) => event === "ImportSession.updateMany"),
        ).toHaveLength(point === "before-return" ? 1 : 0);
        expect(checks).toBe(
          {
            "before-attempt": 1,
            "after-reservation": 2,
            "before-mutation": 3,
            "before-return": 4,
          }[point],
        );
        for (const binding of bindings) expect(binding).toBe(bindings[0]);
        expect(await digest()).toEqual(before);
      },
    );

    it(`${operation}: simulated P2034 then release prevents a second TX even for a retry-looking guard sentinel`, async () => {
      const live = liveModule();
      const turn = await admit(operation);
      const before = await digest();
      const frames = traceWriter();
      const original = live.assertLiveImportConversationWrite;
      const sentinel = new Error(
        "SQLITE_BUSY: test-only revoked pre-attempt sentinel",
      );
      let revoked = false;
      jest
        .spyOn(live, "assertLiveImportConversationWrite")
        .mockImplementation((binding, auth, now) => {
          if (revoked) {
            expect(() => original(binding, auth, now)).toThrow(
              expect.objectContaining({ code: "UI_ACTION_REQUIRED" }),
            );
            throw sentinel;
          }
          original(binding, auth, now);
        });
      hook = (params) => {
        if (
          params.model === "ImportSession" &&
          params.action === "updateMany"
        ) {
          revoked = true;
          turn.bridge.release(turn.admission);
          throw new Prisma.PrismaClientKnownRequestError("simulated conflict", {
            code: "P2034",
            clientVersion: "5.22.0",
          });
        }
      };
      events.length = 0;
      await expect(turn.invoke()).rejects.toBe(sentinel);
      expect(revoked).toBe(true);
      expect(frames.map((frame) => [frame.transactions, frame.work])).toEqual([
        [1, 1],
      ]);
      expect(events.filter((event) => event === "SQL.executeRaw")).toHaveLength(
        1,
      );
      expect(await digest()).toEqual(before);
    });

    it(`${operation}: simulated retry retains one frozen binding, original auth and interpretation`, async () => {
      const live = liveModule();
      const turn = await admit(operation);
      const frames = traceWriter();
      const check = jest.spyOn(live, "assertLiveImportConversationWrite");
      let simulated = false;
      hook = (params) => {
        if (
          !simulated &&
          params.model === "ImportSession" &&
          params.action === "updateMany"
        ) {
          simulated = true;
          const changed = Reflect.set(
            turn.interpretation.value,
            "text",
            "999,00",
          );
          expect(changed || Object.isFrozen(turn.interpretation.value)).toBe(
            true,
          );
          throw new Prisma.PrismaClientKnownRequestError("simulated conflict", {
            code: "P2034",
            clientVersion: "5.22.0",
          });
        }
      };
      const result = await turn.invoke();
      expect(simulated).toBe(true);
      expect(frames.map((frame) => [frame.transactions, frame.work])).toEqual([
        [2, 2],
      ]);
      expect(frames[0]?.guard).toEqual(expect.any(Function));
      const first = check.mock.calls[0]!;
      for (const [binding, auth] of check.mock.calls) {
        expect(binding).toBe(first[0]);
        expect(Object.isFrozen(binding)).toBe(true);
        expect(auth).toBe(turn.auth);
      }
      expect(result.acknowledgment).toBe(
        operation === "EDIT" ? "EDITED" : "PREPARED",
      );
      const stored = await setup.importSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(stored.revision).toBe(8);
      expect(stored.lastUserEditAt).toEqual(
        new Date(FIXED_NOW.getTime() - (operation === "EDIT" ? 0 : 60000)),
      );
      expect(stored.expiresAt).toEqual(
        new Date(FIXED_NOW.getTime() + 604800000),
      );
      const parsed: ImportSessionStoredDraftV1 = JSON.parse(stored.draftJson);
      expect(parsed.lines[0]?.amountCents).toBe(
        operation === "EDIT" ? 20696 : 60000,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each(["sv", "revision"] as const)(
      `${operation}: current %s drift still blocks without retaining a new edit`,
      async (drift) => {
        liveModule();
        const turn = await admit(operation);
        if (drift === "sv")
          await setup.user.update({
            where: { id: world.users.owner.id },
            data: { sessionVersion: 1 },
          });
        else
          await setup.importSession.update({
            where: { id: sessionId },
            data: { revision: 8 },
          });
        const before = await digest();
        await expect(turn.invoke()).rejects.toMatchObject({
          code: drift === "sv" ? "UNAUTHENTICATED" : "REVISION_CONFLICT",
        });
        expect(await digest()).toEqual(before);
      },
    );

    it(`retired HTTP ${operation} route returns 404 without writer activity or mutation`, async () => {
      const before = await digest();
      const frames = traceWriter();
      const transactions = jest.spyOn(db, "$transaction");
      const method = operation === "EDIT" ? "PATCH" : "POST";
      const suffix = operation === "EDIT" ? "draft" : "prepare";
      const response = await h.call(
        method,
        `/import-sessions/${sessionId}/${suffix}`,
        {
          token: await h.tokenFor(world.users.owner),
          headers: UI_HEADERS,
          body:
            operation === "EDIT"
              ? {
                  expectedRevision: 7,
                  questionId: "amount-question",
                  replaceLines: [{ ...draft.lines[0], amountCents: 20696 }],
                  selectedLineIds: ["purchase"],
                }
              : { expectedRevision: 7 },
        },
      );
      expect(response).toMatchObject({
        status: 404,
        json: {
          message: `Cannot ${method} /import-sessions/${sessionId}/${suffix}`,
          error: "Not Found",
          statusCode: 404,
        },
      });
      expect(frames).toEqual([]);
      expect(transactions).toHaveBeenCalledTimes(0);
      expect(await digest()).toEqual(before);
    });
  }

  it("EDIT no-op: release after async material validation blocks the return without renewal", async () => {
    liveModule();
    const turn = await admit("EDIT", "600,00");
    const before = await digest();
    let released = false;
    hook = (params) => {
      if (
        params.model === "ImportObservation" &&
        params.action === "findMany"
      ) {
        released = true;
        turn.bridge.release(turn.admission);
      }
    };
    events.length = 0;
    await expect(turn.invoke()).rejects.toMatchObject({
      code: "UI_ACTION_REQUIRED",
    });
    expect(released).toBe(true);
    expect(events).not.toContain("ImportSession.updateMany");
    expect(await digest()).toEqual(before);
  });

  it("EDIT valid no-op preserves revision, retention and all state", async () => {
    liveModule();
    const turn = await admit("EDIT", "600,00");
    const before = await digest();
    const result = await turn.invoke();
    expect(result.acknowledgment).toBe("NO_CHANGE");
    expect(result.ref).toEqual({ sessionId, revision: 7 });
    expect(await digest()).toEqual(before);
  });

  it("EDIT no-op final-return LIVE check rejects release after async validation, without mutation", async () => {
    const live = liveModule();
    const turn = await admit("EDIT", "600,00");
    const before = await digest();
    const original = live.assertLiveImportConversationWrite;
    let checks = 0;
    jest
      .spyOn(live, "assertLiveImportConversationWrite")
      .mockImplementation((binding, auth, now) => {
        checks++;
        if (checks === 3) turn.bridge.release(turn.admission);
        original(binding, auth, now);
      });
    events.length = 0;
    await expect(turn.invoke()).rejects.toMatchObject({
      code: "UI_ACTION_REQUIRED",
    });
    expect(checks).toBe(3);
    expect(events).not.toContain("ImportSession.updateMany");
    expect(await digest()).toEqual(before);
  });
});
