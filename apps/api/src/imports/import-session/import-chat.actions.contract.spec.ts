const testDbGuard: {
  REPO_ROOT: string;
  ACTIVE_DB_PATH: string;
} = require("../../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CanActivate } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
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
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootRecoveryApp,
  seedApplied,
  UI_HEADERS,
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";
import { ImportAuthGuard } from "./import-session.auth";
import {
  DefaultImportSessionCapability,
  IMPORT_SESSION_CAPABILITY,
} from "./import-session.capability";
import type { StoredImportObservationEvidenceV1 } from "./import-session.observation";
import { ImportSessionService } from "./import-session.service";
import { parseStoredImportSearch } from "./import-session.search";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { AgentController } from "../../agent/agent.controller";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";

const evidenceRoot =
  process.env.P08_QA_EVIDENCE ??
  resolve(testDbGuard.REPO_ROOT, ".agents/p08-contextual-evidence");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidenceDirectory = mkdtempSync(resolve(evidenceRoot, "actions-"));
const suiteRun = basename(evidenceDirectory);

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

describe("P08 complementary actions: actual full service producer, not supplied actions", () => {
  const setup = new PrismaService();
  const capability = new DefaultImportSessionCapability();
  let h: RecoveryApp;
  let service: ImportSessionService;
  let workflow: ImportSessionWorkflowService;
  let world: ImportWorld;
  let sessionId: string;
  let draft: ImportSessionStoredDraftV1;
  let sequence = 0;

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
    proveDb("actions-setup-first-connect-before-seed");
    h = await bootRecoveryApp(setup, {
      overrides: [{ token: IMPORT_SESSION_CAPABILITY, value: capability }],
      beforeListen: async (app) => {
        await app.init();
        proveDb("actions-app-first-connect-before-seed");
        const db = app.get(PrismaService);
        expect(
          (await db.$queryRaw<Array<{ file: string }>>`PRAGMA database_list`)
            .map((row) => row.file)
            .filter(Boolean),
        ).toEqual([testDbGuard.ACTIVE_DB_PATH]);
      },
    });
    proveDb("actions-boot-before-request");
    service = h.app.get(ImportSessionService);
    workflow = h.app.get(ImportSessionWorkflowService);
  });

  beforeEach(async () => {
    sequence++;
    h.clock.current = new Date(FIXED_NOW);
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External fetch forbidden"));
    world = await seedImportWorld(setup, `p08-actions-${suiteRun}-${sequence}`);
    await setup.creditCard.update({
      where: { id: world.cards.pessoal },
      data: { closingDay: 27, dueDay: 5 },
    });
    const target = await setup.project.create({
      data: {
        tenantId: world.tenantId,
        type: "REFORMA",
        name: "Synthetic target",
      },
    });
    const row = await seedSession(setup, world, { revision: 7 });
    sessionId = row.id;
    const bytes = Buffer.from("Synthetic actions purchase 60000 cents / 3");
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
      text: "Synthetic actions purchase",
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 60000,
      installmentCount: 3,
      installmentIndex: null,
      dataCompra: "2026-09-25",
      identity: {
        merchant: "Synthetic actions purchase",
        externalId: null,
        fitId: null,
        ordinal: computeImportOrdinals([
          {
            date: new Date("2026-09-25"),
            merchant: "Synthetic actions purchase",
            amountCents: 60000,
          },
        ])[0],
        fileContentHash: fileContentHash([bytes]),
      },
    };
    const observation = await setup.importObservation.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
      },
    });
    await setup.importArtifact.update({
      where: { id: artifact.id },
      data: {
        extractionJson: JSON.stringify(
          validateDocumentExtraction({
            version: 1,
            parserVersion: "card-local-text-v1",
            documentKind: "UNKNOWN",
            invoiceDueMonth: null,
            metrics: {
              rows: 1,
              pages: 0,
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
                  amount: "600.00",
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
          }),
        ),
      },
    });
    draft = {
      version: 1,
      lines: [
        {
          id: "purchase",
          observationIds: [observation.id],
          titulo: "Synthetic actions purchase",
          fornecedor: "Synthetic actions purchase",
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 60000,
          installmentCount: 3,
          dataCompra: "2026-09-25",
          firstDueDate: "2026-11-05",
          targets: [{ projectId: target.id, roomId: null, amountCents: 60000 }],
          decision: { kind: "CREATE", acceptNaturalDuplicate: true },
        },
      ],
      selectedLineIds: ["purchase"],
      questions: [],
      scope: { observationIds: [observation.id], pendingAttachmentIds: [] },
    };
    await setup.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await h?.close();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  const enable = () =>
    jest.spyOn(capability, "writesEnabled").mockReturnValue(true);
  const read = () => service.getSession(authFor(world.users.owner), sessionId);
  const row = () =>
    setup.importSession.findUniqueOrThrow({ where: { id: sessionId } });
  async function ready() {
    const result = await workflow.prepare(
      authFor(world.users.owner),
      sessionId,
      { expectedRevision: 7 },
    );
    expect(result).toMatchObject({
      state: "READY",
      revision: 8,
      searchComplete: true,
      questions: [],
      confirmation: null,
      receipt: null,
    });
    expect(result.proposal?.createdEconomicTotalCents).toBe(60000);
    return result;
  }
  async function confirmed() {
    const prepared = await ready();
    const token = await h.tokenFor(world.users.owner);
    const lot = await h.call(
      "GET",
      `/import-sessions/${sessionId}/current-lot`,
      { token, headers: UI_HEADERS },
    );
    expect(lot.status).toBe(200);
    const confirmationHash = (lot.json as { confirmationHash: string })
      .confirmationHash;
    const challenge = await h.call(
      "POST",
      `/import-sessions/${sessionId}/confirmation-challenge`,
      {
        token,
        headers: UI_HEADERS,
        body: {
          expectedRevision: 8,
          confirmationHash,
        },
      },
    );
    expect(challenge.status).toBe(200);
    const body: unknown = challenge.json;
    if (
      typeof body !== "object" ||
      body === null ||
      !("nonce" in body) ||
      typeof body.nonce !== "string"
    )
      throw new Error("Real challenge did not provide nonce");
    const response = await h.call(
      "POST",
      `/import-sessions/${sessionId}/confirm`,
      {
        token,
        headers: UI_HEADERS,
        body: {
          expectedRevision: 8,
          confirmationHash,
          financialRequestId: "22222222-2222-4222-8222-222222222222",
          nonce: body.nonce,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ state: "CONFIRMED", sessionId });
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(0);
  }
  async function inFlight(state: "RESERVED" | "UPLOADED") {
    return setup.importSessionArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId,
        position: 1,
        state,
        fileName: "pending.csv",
        declaredMime: "text/csv",
        declaredBytes: 10,
        reservedBytes: 10,
        uploadGeneration: 1,
        temporaryPurgePending: false,
        uploadLeaseExpiresAt: new Date(FIXED_NOW.getTime() + 60000),
        uploadTokenExpiresAt: new Date(FIXED_NOW.getTime() + 60000),
      },
    });
  }

  it.each(["DRAFT", "READY", "CONFIRMED", "APPLIED"] as const)(
    "CONTROL default OFF preserves recovery for %s",
    async (state) => {
      expect(capability.writesEnabled()).toBe(false);
      if (state === "READY" || state === "CONFIRMED") {
        const positive = enable();
        if (state === "READY") await ready();
        else await confirmed();
        positive.mockRestore();
      } else if (state === "APPLIED") {
        sessionId = (
          await seedApplied(setup, world, { owner: world.users.owner })
        ).id;
      }
      const before = await row();
      const prepareSpy = jest.spyOn(workflow, "prepare");
      const view = await read();
      expect(view.state).toBe(state);
      expect(view.actions).toEqual(
        state === "APPLIED" ? ["READ_RESULT"] : ["CANCEL"],
      );
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(await row()).toEqual(before);
    },
  );

  it.each(["DRAFT", "ANALYZING", "NEEDS_INPUT", "REVIEW_REQUIRED"] as const)(
    "%s exposes literal RESOLVE/PREPARE only with positive test DI",
    async (state) => {
      enable();
      await setup.importSession.update({
        where: { id: sessionId },
        data: { state },
      });
      const before = await row();
      const prepareSpy = jest.spyOn(workflow, "prepare");
      expect((await read()).actions.slice().sort()).toEqual([
        "CANCEL",
        "PREPARE",
        "RESOLVE",
      ]);
      expect(await row()).toEqual(before);
      expect(prepareSpy).not.toHaveBeenCalled();
    },
  );

  it("READY from real prepare exposes CONFIRM, not EXECUTE; edit and get share the producer", async () => {
    enable();
    const view = await ready();
    expect(view.actions.slice().sort()).toEqual([
      "CANCEL",
      "CONFIRM",
      "PREPARE",
      "RESOLVE",
    ]);
    expect((await read()).actions).toEqual(view.actions);
    const edited = await workflow.edit(authFor(world.users.owner), sessionId, {
      expectedRevision: 8,
      questionId: null,
      replaceLines: [
        { ...draft.lines[0], titulo: "Renamed synthetic purchase" },
      ],
      selectedLineIds: ["purchase"],
    });
    expect(edited.actions.slice().sort()).toEqual([
      "CANCEL",
      "PREPARE",
      "RESOLVE",
    ]);
    expect((await read()).actions).toEqual(edited.actions);
  });

  it("CONFIRMED from real challenge/confirm exposes only recovery and EXECUTE", async () => {
    enable();
    await confirmed();
    expect((await read()).actions.slice().sort()).toEqual([
      "CANCEL",
      "EXECUTE",
    ]);
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(0);
  });

  it.each(["RESERVED", "UPLOADED"] as const)(
    "in-flight %s blocks PREPARE/CONFIRM but preserves RESOLVE and existing UPLOAD",
    async (state) => {
      enable();
      await ready();
      await inFlight(state);
      expect((await read()).actions.slice().sort()).toEqual([
        "CANCEL",
        "RESOLVE",
      ]);
      await setup.importSession.update({
        where: { id: sessionId },
        data: { state: "DRAFT" },
      });
      expect((await read()).actions.slice().sort()).toEqual(
        state === "RESERVED"
          ? ["CANCEL", "RESOLVE", "UPLOAD"]
          : ["CANCEL", "RESOLVE"],
      );
    },
  );

  it("CONTROL OFF UPLOAD remains available only during the real lease", async () => {
    await inFlight("RESERVED");
    expect((await read()).actions).toEqual(["CANCEL", "UPLOAD"]);
    h.clock.current = new Date(FIXED_NOW.getTime() + 60000);
    expect((await read()).actions).toEqual(["CANCEL"]);
  });

  it("empty selection removes PREPARE without removing RESOLVE", async () => {
    enable();
    await setup.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify({ ...draft, selectedLineIds: [] }) },
    });
    expect((await read()).actions.slice().sort()).toEqual([
      "CANCEL",
      "RESOLVE",
    ]);
  });

  it("unselected ignored blockers keep PREPARE while a selected purchase blocker suppresses it", async () => {
    enable();
    const purchaseObservationId = draft.lines[0]!.observationIds[0]!;
    const purchaseObservation = await setup.importObservation.findUniqueOrThrow(
      {
        where: { id: purchaseObservationId },
      },
    );
    const ignoredObservation = await setup.importObservation.create({
      data: {
        tenantId: purchaseObservation.tenantId,
        ownerProjectId: purchaseObservation.ownerProjectId,
        artifactId: purchaseObservation.artifactId,
        reference: "csv:record:3",
        evidenceJson: JSON.stringify({
          ...JSON.parse(purchaseObservation.evidenceJson),
          reference: "csv:record:3",
          dataCompra: null,
          identity: {
            ...JSON.parse(purchaseObservation.evidenceJson).identity,
            merchant: null,
            ordinal: null,
          },
        }),
      },
    });
    const withIgnored: ImportSessionStoredDraftV1 = {
      ...draft,
      lines: [
        ...draft.lines,
        {
          ...draft.lines[0]!,
          id: "ignored-payment",
          observationIds: [ignoredObservation.id],
          titulo: "PAGAMENTO EFETUADO",
          fornecedor: "PAGAMENTO EFETUADO",
          targets: [],
          decision: {
            kind: "IGNORED_POLICY",
            reason: "INVOICE_PAYMENT",
            policyVersion: 1,
          },
        },
      ],
      scope: {
        ...draft.scope,
        observationIds: [...draft.scope.observationIds, ignoredObservation.id],
      },
    };
    await setup.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(withIgnored) },
    });

    const ignoredBlockerView = await read();
    expect(ignoredBlockerView.reviewBlockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineId: "ignored-payment" }),
      ]),
    );
    expect(ignoredBlockerView.actions).toContain("PREPARE");

    const purchaseEvidence = JSON.parse(purchaseObservation.evidenceJson);
    purchaseEvidence.dataCompra = null;
    await setup.importObservation.update({
      where: { id: purchaseObservationId },
      data: { evidenceJson: JSON.stringify(purchaseEvidence) },
    });
    const selectedBlockerView = await read();
    expect(selectedBlockerView.reviewBlockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ lineId: "purchase" })]),
    );
    expect(selectedBlockerView.actions).not.toContain("PREPARE");
  });

  it.each(["question", "incomplete-search", "missing-preflight"] as const)(
    "READY %s removes CONFIRM but retains documentary preparation",
    async (drift) => {
      enable();
      await ready();
      const current = await row();
      if (drift === "question") {
        const stored: ImportSessionStoredDraftV1 = JSON.parse(
          current.draftJson,
        );
        stored.questions = [
          {
            id: "selected-question",
            field: "amountCents",
            lineIds: ["purchase"],
            text: "Synthetic question",
          },
        ];
        await setup.importSession.update({
          where: { id: sessionId },
          data: { draftJson: JSON.stringify(stored) },
        });
      } else if (drift === "missing-preflight") {
        await setup.importSession.update({
          where: { id: sessionId },
          data: { preflightHash: null },
        });
      } else {
        if (!current.searchJson) throw new Error("Real prepare omitted search");
        const parsed = parseStoredImportSearch(current.searchJson, 8, draft);
        if (parsed.kind !== "SEARCH")
          throw new Error("Real prepare omitted search");
        const search = parsed.value;
        search.complete = false;
        search.coverage.steps[0] = {
          lineId: "purchase",
          stage: "DOCUMENT_IDENTITY",
          status: "NOT_RUN",
          predicateHash: null,
          visitedRows: 0,
          endCursor: null,
        };
        await setup.importSession.update({
          where: { id: sessionId },
          data: { searchJson: JSON.stringify(search) },
        });
      }
      expect((await read()).actions.slice().sort()).toEqual([
        "CANCEL",
        "PREPARE",
        "RESOLVE",
      ]);
    },
  );

  it("confirmation session-version drift removes EXECUTE for a currently authenticated owner", async () => {
    enable();
    await confirmed();
    await setup.user.update({
      where: { id: world.users.owner.id },
      data: { sessionVersion: 1 },
    });
    const view = await service.getSession(
      authFor(world.users.owner, { sessionVersion: 1 }),
      sessionId,
    );
    expect(view.actions).toEqual(["CANCEL"]);
    expect(view.confirmation).not.toBeNull();
  });

  it.each(["expiry", "closed"] as const)(
    "CONTROL %s never offers documentary/financial workflow",
    async (drift) => {
      enable();
      if (drift === "expiry")
        h.clock.current = new Date(FIXED_NOW.getTime() + 604800000);
      else
        await setup.importSession.update({
          where: { id: sessionId },
          data: { state: "CANCELLED", closedAt: FIXED_NOW },
        });
      const auth = authFor(world.users.owner, {
        expiresAt: new Date(FIXED_NOW.getTime() + 1209600000),
      });
      const view = await service.getSession(auth, sessionId);
      expect(view.state).toBe(drift === "expiry" ? "EXPIRED" : "CANCELLED");
      expect(view.actions).toEqual([]);
    },
  );

  it("CONTROL lost owner-project ACL is opaque, never a partial action view", async () => {
    enable();
    await ready();
    await setup.importSession.update({
      where: { id: sessionId },
      data: { ownerUserId: world.users.restricted.id },
    });
    await setup.user.update({
      where: { id: world.users.restricted.id },
      data: {
        allowedProjects: JSON.stringify([world.projects.casa]),
      },
    });
    await expect(
      service.getSession(authFor(world.users.restricted), sessionId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("CONTROL summaries remain recovery-only and never prepare or expose full material", async () => {
    enable();
    await ready();
    const before = await row();
    const prepareSpy = jest.spyOn(workflow, "prepare");
    const page = await service.list(authFor(world.users.owner), {});
    const summary = page.items.find((item) => item.id === sessionId);
    expect(summary).toBeDefined();
    expect(summary?.actions).toEqual(["CANCEL"]);
    expect(Object.keys(summary!).sort()).toEqual([
      "actions",
      "appliedAt",
      "attachmentCount",
      "cardId",
      "continuationSessionId",
      "createdAt",
      "expiresAt",
      "hasConfirmation",
      "id",
      "ownerProjectId",
      "revision",
      "state",
    ]);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(await row()).toEqual(before);
  });

  it.each(["TEXT", "VOICE"] as const)(
    "positive V/OPEN_REVIEW %s comes from the real bridge/workflow/service, never fabricated actions",
    async (channel) => {
      enable();
      const guard = h.app.get<CanActivate>(
        requiredExport("import-chat.guard.ts", "ImportChatGuard"),
      );
      const bridge = h.app.get<{
        contextForRequest(request: object): object | null;
        prepare(admission: object): Promise<ImportChatOutcomeV1>;
        release(admission: object): void;
      }>(requiredExport("import-chat.bridge.ts", "ImportChatBridge"));
      const turn: ImportChatTurnV1 = {
        version: 1,
        turnId: "11111111-1111-4111-8111-111111111111",
        sessionId,
        expectedRevision: 7,
        intent: "OPEN_REVIEW",
        channel,
        literalAnswer: "sim",
        focus: null,
        scope: null,
      };
      const request = {
        method: "POST",
        url: "/agent/chat",
        originalUrl: "/agent/chat",
        route: { path: "/agent/chat" },
        headers: { ...UI_HEADERS },
        body: {
          messages: [{ role: "user", content: "sim" }],
          importTurn: turn,
        },
        user: {
          id: world.users.owner.id,
          tenantId: world.tenantId,
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
      expect(await guard.canActivate(context)).toBe(true);
      const admission = bridge.contextForRequest(request);
      expect(admission).not.toBeNull();
      if (!admission) throw new Error("Real bridge did not activate admission");
      try {
        const outcome = await bridge.prepare(admission);
        expect(outcome).toEqual({
          version: 1,
          turnId: turn.turnId,
          kind: "OPEN_REVIEW",
          ref: { sessionId, revision: 8 },
          acknowledgment: "PREPARED",
        });
        const view = await read();
        expect(view).toMatchObject({
          state: "READY",
          revision: 8,
          searchComplete: true,
          questions: [],
          confirmation: null,
          receipt: null,
        });
        expect(view.actions.slice().sort()).toEqual([
          "CANCEL",
          "CONFIRM",
          "PREPARE",
          "RESOLVE",
        ]);
        expect(view.proposal).not.toHaveProperty("proposalHash");
        expect(
          await setup.expense.count({ where: { tenantId: world.tenantId } }),
        ).toBe(0);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        bridge.release(admission);
      }
    },
  );
});
