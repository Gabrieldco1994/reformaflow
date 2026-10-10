import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { createHash, randomUUID } from "node:crypto";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { PrismaClient } from "@prisma/client";
import {
  ExpenseType,
  type ImportSessionReceiptV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import {
  computeImportOrdinals,
  fileContentHash,
} from "../../credit-card/parsers/dedupe-key";
import { parseStoredExpenseSchedule } from "../../expense/documented-schedule";
import { ExpenseService } from "../../expense/expense.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  FIXED_NOW,
  mintGrant,
  MutableClock,
  seedImportWorld,
} from "../../test-utils/import-session-harness";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { IMPORT_UI_HEADER, ImportUiGuard } from "./import-session-ui.guard";
import {
  assertMintedImportContext,
  ImportAuthGuard,
} from "./import-session.auth";
import type { ImportSessionCapability } from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportFinancialActionScope,
} from "./import-session.contract";
import type { StoredImportObservationEvidenceV1 } from "./import-session.observation";
import { buildImportPreparationPlan } from "./import-session.preparation";
import { ImportSessionService } from "./import-session.service";
import { validateStoredDraft } from "./import-session.validation";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

const ORIGINAL = Buffer.from(
  "synthetic four purchases: 204042/6;69840/10;69840/10;212376/3",
);
const SHA256 = createHash("sha256").update(ORIGINAL).digest("hex");
const FILE_HASH = fileContentHash([ORIGINAL]);
const PURCHASES = [
  {
    id: "six",
    merchant: "Synthetic materials",
    total: 204042,
    count: 6,
    each: 34007,
  },
  {
    id: "twin-a",
    merchant: "Synthetic twins",
    total: 69840,
    count: 10,
    each: 6984,
  },
  {
    id: "twin-b",
    merchant: "Synthetic twins",
    total: 69840,
    count: 10,
    each: 6984,
  },
  {
    id: "pix-credit",
    merchant: "Synthetic Pix on credit",
    total: 212376,
    count: 3,
    each: 70792,
  },
] as const;
const MONTHS = [
  "2026-11",
  "2026-12",
  "2027-01",
  "2027-02",
  "2027-03",
  "2027-04",
  "2027-05",
  "2027-06",
  "2027-07",
  "2027-08",
];
const FINANCIAL_TABLES = [
  "expenses",
  "cash_flow_entries",
  "rateio_allocations",
  "receipts",
  "bank_accounts",
  "credit_cards",
  "credit_card_imports",
  "bank_statement_imports",
  "cross_project_settlements",
  "imported_invoice_liquidations",
  "invoice_adjustments",
  "invoice_reconciliation_sources",
  "invoice_replay_operations",
  "invoice_funding_allocations",
  "budget_allocations",
] as const;
const DOCUMENT_TABLES = [
  "import_sessions",
  "import_artifacts",
  "import_session_artifacts",
  "import_observations",
  "user_activity_logs",
] as const;
type Write = {
  model: string;
  action: string;
  inTransaction: boolean;
  args: unknown;
  result: unknown;
  insertedRows: number;
  insertedTargetCFEs: number;
};
type RowEffect = {
  model: string;
  action: string;
  rows: number;
  inTransaction: boolean;
};
type Failure =
  | "last-target-cfe"
  | "last-claim-cas"
  | "audit"
  | "final-write"
  | null;

describe("M1 independent real W+A integrated contract (inactive, no HTTP)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const clock = new MutableClock();
  const issuer = new ImportUiGrantIssuer(clock);
  const verifier = new RuntimeUiGrantVerifier();
  const capability: ImportSessionCapability = {
    writesEnabled: () => true,
    newImportFormats: () => [],
  };
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const reader = new ImportSessionService(
    prisma,
    clock,
    capability,
    verifier,
    ...rawTestDependencies(
      new ImportVaultGate(prisma, clock, {}, process.cwd()),
      clock,
      capability,
    ),
  );
  const writes: Write[] = [];
  const rowEffects: RowEffect[] = [];
  let measureRowEffects = false;
  let afterWriterReservation: ((rows: unknown) => Promise<void>) | null = null;
  let beforeEligibilityRead: (() => void) | null = null;
  const knownFinancialIds = new Map<string, Set<string>>();
  let failure: Failure = null;
  let failureReached = false;
  let targetProjectId = "";
  let sequence = 0;

  prisma.$use(async (params, next) => {
    if (params.model === "User" && params.action.startsWith("find"))
      beforeEligibilityRead?.();
    if (
      failure === "last-claim-cas" &&
      params.model === "ImportObservation" &&
      params.action === "updateMany" &&
      writes.filter(
        (event) =>
          event.model === "ImportObservation" && event.action === "updateMany",
      ).length === 3
    ) {
      if (!record(params.args?.where))
        throw new Error("Expected a guarded claim CAS predicate");
      params.args.where = {
        AND: [params.args.where, { id: "qa-unmatched-fourth-claim" }],
      };
      failureReached = true;
    }
    const result: unknown = await next(params);
    if (params.action === "executeRaw") await afterWriterReservation?.(result);
    const isModelWrite = [
      "create",
      "createMany",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
      "upsert",
    ].includes(params.action);
    if (measureRowEffects && (isModelWrite || params.action === "executeRaw")) {
      let rows: number;
      if (params.action === "executeRaw") {
        if (typeof result !== "number" && typeof result !== "bigint")
          throw new Error(
            "Raw writer must return the driver's affected-row count",
          );
        rows = Number(result);
      } else if (params.action.endsWith("Many")) {
        if (!record(result) || typeof result.count !== "number")
          throw new Error("Bulk mutation must return its affected-row count");
        rows = result.count;
      } else {
        if (!record(result) || typeof result.id !== "string")
          throw new Error(
            "Single-row mutation must return the affected row ID",
          );
        rows = 1;
      }
      if (!Number.isSafeInteger(rows) || rows < 0)
        throw new Error("Invalid native row-effect count");
      rowEffects.push({
        model: params.model ?? "$raw",
        action: params.action,
        rows,
        inTransaction: params.runInTransaction,
      });
    }
    if (!isModelWrite) return result;
    let insertedRows = params.action === "create" ? 1 : 0;
    let insertedTargetCFEs = 0;
    if (params.action === "upsert") {
      const known = knownFinancialIds.get(params.model ?? "");
      if (!known || !record(result) || typeof result.id !== "string")
        throw new Error(
          "Upsert observation requires baseline IDs and the returned row ID",
        );
      insertedRows = known.has(result.id) ? 0 : 1;
    } else if (params.action === "createMany") {
      if (
        !record(result) ||
        typeof result.count !== "number" ||
        !Number.isSafeInteger(result.count) ||
        result.count < 0
      )
        throw new Error("Missing actual createMany row count");
      insertedRows = result.count;
      if (params.model === "CashFlowEntry") {
        const rows: unknown[] = Array.isArray(params.args?.data)
          ? params.args.data
          : [params.args?.data];
        if (
          rows.length !== result.count ||
          !rows.every((row) => record(row) && typeof row.projectId === "string")
        )
          throw new Error(
            "Bulk CFE count must identify every inserted input row",
          );
        insertedTargetCFEs = rows.filter(
          (row) => record(row) && row.projectId === targetProjectId,
        ).length;
      }
    }
    if (insertedRows > 0 && record(result)) {
      if (typeof result.id === "string")
        knownFinancialIds.get(params.model ?? "")?.add(result.id);
      if (
        params.model === "CashFlowEntry" &&
        result.projectId === targetProjectId
      )
        insertedTargetCFEs = insertedRows;
    }
    writes.push({
      model: params.model ?? "",
      action: params.action,
      inTransaction: params.runInTransaction,
      args: structuredClone(params.args),
      result: structuredClone(result),
      insertedRows,
      insertedTargetCFEs,
    });
    const targetCFECount = writes.reduce(
      (count, event) => count + event.insertedTargetCFEs,
      0,
    );
    const finalWrite =
      params.model === "ImportSession" &&
      record(params.args?.data) &&
      params.args.data.state === "APPLIED";
    if (
      (failure === "last-target-cfe" &&
        params.model === "CashFlowEntry" &&
        insertedTargetCFEs > 0 &&
        targetCFECount === 29) ||
      (failure === "audit" &&
        params.model === "UserActivityLog" &&
        params.action === "create") ||
      (failure === "final-write" && finalWrite)
    ) {
      failureReached = true;
      throw new Error(`qa-real-batch:${failure}`);
    }
    return result;
  });

  beforeAll(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "setInterval",
        "setTimeout",
      ],
    });
    jest.setSystemTime(FIXED_NOW);
    await setup.$connect();
    await prisma.onModuleInit();
  });
  afterEach(() => {
    failure = null;
    writes.length = 0;
    measureRowEffects = false;
    rowEffects.length = 0;
    afterWriterReservation = null;
    beforeEligibilityRead = null;
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
    await setup.$disconnect();
    jest.useRealTimers();
  });

  async function physical(
    tenantId: string,
    tables: readonly string[] = FINANCIAL_TABLES,
  ) {
    const snapshot: Record<string, unknown[]> = {};
    for (const table of tables) {
      snapshot[table] = await setup.$queryRawUnsafe(
        `SELECT * FROM "${table}" WHERE tenant_id = ? ORDER BY id`,
        tenantId,
      );
    }
    return snapshot;
  }
  const durable = (tenantId: string) =>
    physical(tenantId, [...FINANCIAL_TABLES, ...DOCUMENT_TABLES]);
  async function captureFinancialIds(tenantId: string) {
    const where = { tenantId };
    const select = { id: true } as const;
    knownFinancialIds.clear();
    for (const [model, rows] of [
      ["Expense", await setup.expense.findMany({ where, select })],
      [
        "RateioAllocation",
        await setup.rateioAllocation.findMany({ where, select }),
      ],
      ["CashFlowEntry", await setup.cashFlowEntry.findMany({ where, select })],
    ] as const)
      knownFinancialIds.set(model, new Set(rows.map((row) => row.id)));
  }
  function financialInvocation(
    claims: AuthenticatedImportContext,
    scope: UiImportFinancialActionScope,
  ) {
    const request = {
      headers: { origin: "http://localhost:3000", [IMPORT_UI_HEADER]: "1" },
      user: {
        id: claims.userId,
        tenantId: claims.tenantId,
        authClaims: {
          sessionVersion: claims.presentedSessionVersion,
          expiresAtEpochSeconds: Date.parse(claims.tokenExpiresAt) / 1000,
        },
      },
    };
    const context = new ExecutionContextHost([request]);
    expect(new ImportAuthGuard().canActivate(context)).toBe(true);
    expect(
      new ImportUiGuard(
        { allowed: () => ["http://localhost:3000"] },
        issuer,
      ).canActivate(context),
    ).toBe(true);
    const key = Object.getOwnPropertySymbols(request).find(
      (candidate) => candidate.description === "IMPORT_AUTH_CONTEXT",
    );
    if (!key) throw new Error("ImportAuthGuard did not attach its context");
    const auth: unknown = Reflect.get(request, key);
    assertMintedImportContext(auth);
    return { auth, grant: issuer.issueFinancialAction(request, auth, scope) };
  }
  function composition() {
    return new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      verifier,
      new CardPurchaseBatchAdapter(expenses, conciliacao, clock),
      ...rawTestDependencies(
        new ImportVaultGate(prisma, clock, {}, process.cwd()),
        clock,
        capability,
      ),
    );
  }
  async function fixture(deferred = false) {
    clock.current = FIXED_NOW;
    const world = await seedImportWorld(setup, `qa-real-batch-${++sequence}`);
    const target = await setup.project.create({
      data: {
        tenantId: world.tenantId,
        type: "REFORMA",
        name: "Synthetic renovation",
      },
    });
    targetProjectId = target.id;
    await setup.creditCard.update({
      where: { id: world.cards.pessoal },
      data: { closingDay: 27, dueDay: 5 },
    });
    await setup.user.update({
      where: { id: world.users.restricted.id },
      data: {
        allowedProjects: JSON.stringify([world.projects.pessoal, target.id]),
      },
    });
    const auth = authFor(world.users.restricted);
    const witness = await setup.expense.create({
      data: {
        tenantId: world.tenantId,
        projectId: world.projects.pessoal,
        titulo: "Unrelated paid bank witness",
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        valor: 12345,
        quantidade: 1,
        valorTotal: 12345,
        formaPagamento: "A_VISTA",
        status: "PAGO",
        bankLast4: "5678",
      },
    });
    await setup.cashFlowEntry.create({
      data: {
        tenantId: world.tenantId,
        projectId: world.projects.pessoal,
        expenseId: witness.id,
        valor: 12345,
        tipo: "DESPESA",
        categoria: ExpenseType.MATERIAL_CONSTRUCAO,
        data: new Date("2026-09-10T00:00:00.000Z"),
        status: "PAGO",
      },
    });
    await setup.userActivityLog.create({
      data: {
        tenantId: world.tenantId,
        userId: auth.userId,
        action: "qa.preexisting",
      },
    });
    const createRequestId = randomUUID();
    const { view: session } = await reader.create(
      auth,
      {
        version: 1,
        createRequestId,
        cardId: world.cards.pessoal,
        consentPolicyVersion: 1,
        consentAnalyze: true,
      },
      mintGrant(issuer, auth, {
        operation: "CREATE_SESSION",
        cardId: world.cards.pessoal,
        createRequestId,
        consentPolicyVersion: 1,
      }),
    );
    const artifact = await setup.importArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: SHA256,
        verifiedBytes: ORIGINAL.length,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        parserVersion: "card-local-text-v1",
      },
    });
    const reference = await setup.importSessionArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: session.id,
        artifactId: artifact.id,
        position: 0,
        fileName: "synthetic.csv",
        declaredMime: "text/csv",
        declaredBytes: ORIGINAL.length,
        reservedBytes: ORIGINAL.length,
        state: "ATTACHED",
        verifiedAt: FIXED_NOW,
      },
    });
    const ordinals = computeImportOrdinals(
      PURCHASES.map((p) => ({
        date: new Date("2026-09-25"),
        merchant: p.merchant,
        amountCents: p.total,
      })),
    );
    expect(ordinals).toEqual([0, 0, 1, 0]);
    expect(FILE_HASH).toMatch(/^[0-9a-f]{32}$/);
    const lines: ImportSessionStoredDraftV1["lines"] = [];
    for (const [index, p] of PURCHASES.entries()) {
      const evidence: StoredImportObservationEvidenceV1 = {
        version: 1,
        reference: `csv:record:${index + 2}`,
        text: p.merchant,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: p.total,
        installmentCount: p.count,
        installmentIndex: null,
        dataCompra: "2026-09-25",
        identity: {
          merchant: p.merchant,
          externalId: null,
          fitId: null,
          ordinal: ordinals[index]!,
          fileContentHash: FILE_HASH,
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
      lines.push({
        id: p.id,
        observationIds: [observation.id],
        titulo: p.merchant,
        fornecedor: p.merchant,
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: p.total,
        installmentCount: p.count,
        dataCompra: "2026-09-25",
        firstDueDate: "2026-11-05",
        targets: [{ projectId: target.id, roomId: null, amountCents: p.total }],
        decision: { kind: "CREATE", acceptNaturalDuplicate: true },
      });
    }
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines,
      selectedLineIds: ["six", "twin-a", "twin-b", "pix-credit"],
      questions: [],
      scope: {
        observationIds: lines.flatMap((line) => line.observationIds),
        pendingAttachmentIds: [],
      },
    };
    if (deferred) {
      const evidence: StoredImportObservationEvidenceV1 = {
        version: 1,
        reference: "csv:record:1001",
        text: "Synthetic unresolved observation",
        amountMeaning: "UNKNOWN",
        amountCents: null,
        installmentCount: null,
        installmentIndex: null,
        dataCompra: null,
        identity: {
          merchant: null,
          externalId: null,
          fitId: null,
          ordinal: null,
          fileContentHash: null,
        },
      };
      const pending = await setup.importObservation.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          artifactId: artifact.id,
          reference: evidence.reference,
          evidenceJson: JSON.stringify(evidence),
          claimVersion: 3,
        },
      });
      const pendingRef = await setup.importSessionArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          sessionId: session.id,
          position: 1,
          fileName: "unavailable.csv",
          declaredMime: "text/csv",
          declaredBytes: 11,
          reservedBytes: 11,
          state: "FAILED",
          temporaryPurgePending: true,
          uploadGeneration: 4,
        },
      });
      draft.scope.observationIds.push(pending.id);
      draft.scope.pendingAttachmentIds.push(pendingRef.id);
      draft.lines.push({
        id: "deferred",
        observationIds: [pending.id],
        titulo: "Synthetic unresolved purchase",
        fornecedor: null,
        tipoDespesa: null,
        categoriaMaoDeObra: null,
        amountMeaning: "UNKNOWN",
        amountCents: null,
        installmentCount: null,
        dataCompra: null,
        firstDueDate: null,
        targets: null,
        decision: { kind: "UNRESOLVED" },
      });
      draft.questions.push({
        id: "pending-question",
        lineIds: ["deferred"],
        field: "amountCents",
        text: "What is the full documented total?",
      });
    }
    await freezeExtraction(setup, artifact.id);
    validateStoredDraft(draft);
    await setup.importSession.update({
      where: { id: session.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    await captureFinancialIds(world.tenantId);
    writes.length = 0;
    return {
      world,
      auth,
      target,
      witness,
      session,
      artifact,
      reference,
      draft,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function boundaryFixture(claims: 188 | 189 | 200) {
    const f = await fixture();
    const perLine =
      claims === 188
        ? [19, 19, 19, 19, 19, 19, 19, 19, 18, 18]
        : claims === 189
          ? [19, 19, 19, 19, 19, 19, 19, 19, 19, 18]
          : [20, 20, 20, 20, 20, 20, 20, 20, 20, 20];
    const content = Buffer.from(
      `Synthetic ten purchases, twelve installments, ${claims} original observations`,
    );
    const contentHash = fileContentHash([content]);
    await setup.importArtifact.update({
      where: { id: f.artifact.id },
      data: {
        documentSha256: createHash("sha256").update(content).digest("hex"),
        verifiedBytes: content.length,
        leaseSessionId: f.session.id,
        leaseSessionVersion: f.auth.presentedSessionVersion,
        leaseTokenExpiresAt: new Date(f.auth.tokenExpiresAt),
        leaseExpiresAt: new Date(FIXED_NOW.getTime() + 60000),
      },
    });
    await setup.importSessionArtifact.update({
      where: { id: f.reference.id },
      data: {
        declaredBytes: content.length,
        reservedBytes: content.length,
      },
    });
    const originals = f.draft.scope.observationIds;
    const lines: ImportSessionStoredDraftV1["lines"] = [];
    let position = 0;
    for (const [index, count] of perLine.entries()) {
      const merchant = `Synthetic bounded purchase ${index}`;
      const ordinals = computeImportOrdinals(
        Array.from({ length: count }, () => ({
          date: new Date("2026-09-25"),
          merchant,
          amountCents: 1200,
        })),
      );
      const observationIds: string[] = [];
      for (let part = 0; part < count; part++) {
        const evidence: StoredImportObservationEvidenceV1 = {
          version: 1,
          reference: `csv:record:${index * 20 + part + 2}`,
          text: merchant,
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 1200,
          installmentCount: 12,
          installmentIndex: null,
          dataCompra: "2026-09-25",
          identity: {
            merchant,
            externalId: null,
            fitId: null,
            ordinal: ordinals[part]!,
            fileContentHash: contentHash,
          },
        };
        const data = {
          tenantId: f.world.tenantId,
          ownerProjectId: f.world.projects.pessoal,
          artifactId: f.artifact.id,
          reference: evidence.reference,
          evidenceJson: JSON.stringify(evidence),
        };
        const originalId = originals[position++];
        const observation = originalId
          ? await setup.importObservation.update({
              where: { id: originalId },
              data,
            })
          : await setup.importObservation.create({ data });
        observationIds.push(observation.id);
      }
      lines.push({
        ...f.draft.lines[0]!,
        id: `bounded-${index}`,
        titulo: merchant,
        fornecedor: merchant,
        observationIds,
        amountCents: 1200,
        installmentCount: 12,
        targets: [{ projectId: f.target.id, roomId: null, amountCents: 1200 }],
      });
    }
    const draft = validateStoredDraft({
      version: 1,
      lines,
      selectedLineIds: lines.map((line) => line.id),
      questions: [],
      scope: {
        observationIds: lines.flatMap((line) => line.observationIds),
        pendingAttachmentIds: [],
      },
    });
    expect(draft.scope.observationIds).toHaveLength(claims);
    expect(new Set(draft.scope.observationIds).size).toBe(claims);
    await freezeExtraction(setup, f.artifact.id);
    await setup.importSession.update({
      where: { id: f.session.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    return { ...f, draft };
  }

  function measuredBudget(label: string) {
    const breakdown: Record<string, { calls: number; affectedRows: number }> =
      {};
    for (const effect of rowEffects) {
      const key = `${effect.model}.${effect.action}`;
      const entry = breakdown[key] ?? { calls: 0, affectedRows: 0 };
      entry.calls++;
      entry.affectedRows += effect.rows;
      breakdown[key] = entry;
    }
    const total = rowEffects.reduce((sum, effect) => sum + effect.rows, 0);
    console.info(
      "QA_PHASE_B_ROW_EFFECTS",
      JSON.stringify({ label, total, breakdown }),
    );
    expect(rowEffects.every((effect) => effect.inTransaction)).toBe(true);
    expect(rowEffects[0]).toMatchObject({
      model: "$raw",
      action: "executeRaw",
      rows: 1,
    });
    expect(breakdown["ImportObservation.updateMany"]).toEqual({
      calls: 188,
      affectedRows: 188,
    });
    expect(breakdown["ImportArtifact.updateMany"]).toEqual({
      calls: 1,
      affectedRows: 1,
    });
    expect(breakdown["UserActivityLog.create"]).toEqual({
      calls: 1,
      affectedRows: 1,
    });
    expect(breakdown["ImportSession.updateMany"]).toEqual({
      calls: 1,
      affectedRows: 1,
    });
    expect(insertedCount("Expense")).toBe(20);
    expect(insertedCount("RateioAllocation")).toBe(10);
    expect(insertedCount("CashFlowEntry")).toBe(240);
    expect(
      rowEffects
        .filter(
          (effect) =>
            effect.model === "CashFlowEntry" &&
            (effect.action === "create" || effect.action === "createMany"),
        )
        .reduce((sum, effect) => sum + effect.rows, 0),
    ).toBe(240);
    expect(total).toBeLessThanOrEqual(512);
    return total;
  }

  async function prepareAndConfirm(
    workflow: ImportSessionWorkflowService,
    f: Fixture,
  ) {
    const before = await physical(f.world.tenantId);
    const prepared = await workflow.prepare(f.auth, f.session.id, {
      expectedRevision: f.session.revision,
    });
    expect(prepared.state).toBe("READY");
    expect(prepared.revision).toBe(f.session.revision + 1);
    expect(prepared.proposal).not.toBeNull();
    if (!prepared.proposal) throw new Error("READY must contain a proposal");
    const lot = await workflow.currentLot(f.auth, f.session.id);
    expect(await physical(f.world.tenantId)).toEqual(before);
    const body = {
      expectedRevision: prepared.revision,
      confirmationHash: lot.confirmationHash,
    };
    const challengeInvocation = financialInvocation(f.auth, {
      operation: "CHALLENGE",
      sessionId: f.session.id,
      ...body,
    });
    const challenge = await workflow.challenge(
      challengeInvocation.auth,
      f.session.id,
      body,
      challengeInvocation.grant,
    );
    expect(typeof challenge.nonce).toBe("string");
    expect(challenge.nonce.length).toBeGreaterThan(0);
    expect(await physical(f.world.tenantId)).toEqual(before);
    expect(
      await setup.importObservation.count({
        where: {
          tenantId: f.world.tenantId,
          id: { in: f.draft.scope.observationIds },
          claimSessionId: { not: null },
        },
      }),
    ).toBe(0);
    const financialRequestId = randomUUID();
    const confirmInvocation = financialInvocation(f.auth, {
      operation: "CONFIRM",
      sessionId: f.session.id,
      ...body,
      financialRequestId,
    });
    await expect(
      workflow.confirm(
        confirmInvocation.auth,
        f.session.id,
        { ...body, financialRequestId, nonce: challenge.nonce },
        confirmInvocation.grant,
      ),
    ).resolves.toEqual({
      sessionId: f.session.id,
      financialRequestId,
      state: "CONFIRMED",
    });
    expect(await physical(f.world.tenantId)).toEqual(before);
    const confirmed = await setup.importSession.findUniqueOrThrow({
      where: { id: f.session.id },
    });
    expect(confirmed).toMatchObject({
      state: "CONFIRMED",
      revision: prepared.revision + 1,
      confirmedRevision: prepared.revision,
      proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      receiptJson: null,
    });
    return { prepared, body, financialRequestId };
  }
  async function execute(
    workflow: ImportSessionWorkflowService,
    f: Fixture,
    financialRequestId: string,
  ) {
    await captureFinancialIds(f.world.tenantId);
    const invocation = financialInvocation(f.auth, {
      operation: "EXECUTE",
      sessionId: f.session.id,
      financialRequestId,
    });
    return workflow.execute(
      invocation.auth,
      f.session.id,
      { financialRequestId },
      invocation.grant,
    );
  }
  function created(model: string) {
    return writes.filter(
      (event) => event.model === model && event.insertedRows > 0,
    );
  }
  function insertedCount(model: string) {
    return created(model).reduce(
      (count, event) => count + event.insertedRows,
      0,
    );
  }
  function assertFinancialWritesObserved() {
    expect(insertedCount("Expense")).toBe(8);
    expect(insertedCount("RateioAllocation")).toBe(4);
    expect(insertedCount("CashFlowEntry")).toBe(58);
    expect(
      created("CashFlowEntry").reduce(
        (count, event) => count + event.insertedTargetCFEs,
        0,
      ),
    ).toBe(29);
    expect(writes.every((event) => event.inTransaction)).toBe(true);
  }
  async function assertBatch(f: Fixture, receipt: ImportSessionReceiptV1) {
    expect(receipt.items.map((item) => [item.lineId, item.outcome])).toEqual(
      PURCHASES.map((p) => [p.id, "CREATED"]),
    );
    expect(receipt.snapshot.createdEconomicTotalCents).toBe(556098);
    expect(receipt.snapshot.bankCashDeltaCents).toBe(0);
    expect(
      receipt.snapshot.invoiceDeltas.filter(
        (d) => d.invoiceDueMonth === "2026-11",
      ),
    ).toEqual([{ invoiceDueMonth: "2026-11", amountCents: 118767 }]);
    expect(
      receipt.snapshot.invoiceDeltas.filter(
        (d) => d.invoiceDueMonth === "2026-10",
      ),
    ).toEqual([]);
    const sources = await setup.expense.findMany({
      where: { id: { in: receipt.items.map((item) => item.sourceExpenseId) } },
    });
    const targets = await setup.expense.findMany({
      where: {
        id: { in: receipt.items.flatMap((item) => item.targetExpenseIds) },
      },
    });
    expect(sources).toHaveLength(4);
    expect(targets).toHaveLength(4);
    expect(
      await setup.rateioAllocation.count({
        where: { tenantId: f.world.tenantId },
      }),
    ).toBe(4);
    expect(new Set(sources.map((source) => source.id)).size).toBe(4);
    expect(sources.reduce((sum, source) => sum + source.valorTotal, 0)).toBe(
      556098,
    );
    expect(
      await setup.expense.count({
        where: { tenantId: f.world.tenantId, id: { not: f.witness.id } },
      }),
    ).toBe(8);
    const sourceCFEs = await setup.cashFlowEntry.findMany({
      where: { expenseId: { in: sources.map((source) => source.id) } },
    });
    const targetCFEs = await setup.cashFlowEntry.findMany({
      where: { expenseId: { in: targets.map((target) => target.id) } },
    });
    expect(sourceCFEs).toHaveLength(29);
    expect(targetCFEs).toHaveLength(29);
    expect(
      sourceCFEs
        .filter((cfe) => cfe.invoiceDueMonth === "2026-11")
        .reduce((sum, cfe) => sum + cfe.valor, 0),
    ).toBe(118767);
    expect(
      sourceCFEs.filter((cfe) => cfe.invoiceDueMonth === "2026-10"),
    ).toEqual([]);
    const card = await setup.creditCard.findUniqueOrThrow({
      where: { id: f.world.cards.pessoal },
    });
    for (const [index, p] of PURCHASES.entries()) {
      const item = receipt.items[index]!;
      expect(item.targetExpenseIds).toHaveLength(1);
      expect(item.allocationIds).toHaveLength(1);
      const source = sources.find((row) => row.id === item.sourceExpenseId)!;
      const target = targets.find(
        (row) => row.id === item.targetExpenseIds[0],
      )!;
      expect(source).toMatchObject({
        valorTotal: p.total,
        cardLast4: card.last4,
        bankLast4: null,
        status: "PLANEJADO",
        deletedAt: null,
      });
      expect(target).toMatchObject({
        valorTotal: p.total,
        projectId: f.target.id,
        cardLast4: null,
        bankLast4: null,
        deletedAt: null,
      });
      const expected = MONTHS.slice(0, p.count).map((month, occurrence) => ({
        index: occurrence,
        parcela: `${occurrence + 1}/${p.count}`,
        valor: p.each,
        data: `${month}-05`,
        invoiceDueMonth: month,
      }));
      const schedule = parseStoredExpenseSchedule(source.documentedSchedule);
      expect(schedule).toMatchObject({
        version: 2,
        kind: "source",
        sourceExpenseId: source.id,
        cardId: f.world.cards.pessoal,
        occurrences: expected,
      });
      if (!schedule || schedule.kind !== "source")
        throw new Error("Missing stored source schedule");
      expect(schedule.occurrences).toHaveLength(p.count);
      const insertion = created("Expense").find(
        (event) => record(event.result) && event.result.id === source.id,
      );
      expect(insertion).toBeDefined();
      if (
        !insertion ||
        !record(insertion.args) ||
        !record(insertion.args.data) ||
        typeof insertion.args.data.documentedSchedule !== "string"
      )
        throw new Error("Missing source INSERT");
      expect(
        parseStoredExpenseSchedule(insertion.args.data.documentedSchedule),
      ).toMatchObject({ version: 2, kind: "source", occurrences: expected });
      expect(schedule.occurrences[0]?.amountEvidence).toMatchObject({
        documentSha256: SHA256,
        reference: `csv:record:${index + 2}`,
        actorUserId: f.auth.userId,
      });
      expect(
        parseStoredExpenseSchedule(target.documentedSchedule),
      ).toMatchObject({
        kind: "projection",
        sourceExpenseId: source.id,
        occurrences: expected,
      });
      const cfes = [...sourceCFEs, ...targetCFEs].filter(
        (cfe) => cfe.expenseId === source.id || cfe.expenseId === target.id,
      );
      expect(item.cashFlowEntryIds.slice().sort()).toEqual(
        cfes.map((cfe) => cfe.id).sort(),
      );
      for (const ownerId of [source.id, target.id]) {
        expect(
          cfes
            .filter((cfe) => cfe.expenseId === ownerId)
            .sort((a, b) => a.data.getTime() - b.data.getTime())
            .map((cfe) => ({
              parcela: cfe.parcela,
              valor: cfe.valor,
              data: cfe.data.toISOString().slice(0, 10),
              invoiceDueMonth: cfe.invoiceDueMonth,
              deletedAt: cfe.deletedAt,
            })),
        ).toEqual(
          expected.map(({ index: _index, ...occurrence }) => ({
            ...occurrence,
            deletedAt: null,
          })),
        );
      }
      const allocation = await setup.rateioAllocation.findUniqueOrThrow({
        where: { id: item.allocationIds[0] },
      });
      expect(allocation).toMatchObject({
        sourceExpenseId: source.id,
        targetExpenseId: target.id,
        allocation: p.total,
        isRefundCredit: false,
      });
      const observation = await setup.importObservation.findUniqueOrThrow({
        where: { id: f.draft.lines[index]!.observationIds[0] },
      });
      expect(observation).toMatchObject({
        claimVersion: 1,
        canonicalExpenseId: source.id,
        canonicalReceiptId: null,
        claimSessionId: f.session.id,
      });
      expect(observation.claimReceiptJson).not.toBeNull();
    }
    const stored = await setup.importSession.findUniqueOrThrow({
      where: { id: f.session.id },
    });
    expect(stored.state).toBe("APPLIED");
    expect(stored.closedAt).toEqual(FIXED_NOW);
    expect(JSON.parse(stored.receiptJson!)).toEqual(receipt);
  }

  it("internal financial admission control issues and consumes a real grant without W/A (not HTTP/JWT proof)", () => {
    const claims = authFor({
      id: "qa-financial-control-user",
      tenantId: "qa-financial-control-tenant",
      sessionVersion: 0,
    });
    const common = {
      sessionId: "qa-financial-control-session",
      expectedRevision: 2,
      confirmationHash: "a".repeat(64),
    };
    const financialRequestId = "123e4567-e89b-42d3-a456-426614174000";
    const scopes: UiImportFinancialActionScope[] = [
      { operation: "CHALLENGE", ...common },
      { operation: "CONFIRM", ...common, financialRequestId },
      {
        operation: "EXECUTE",
        sessionId: common.sessionId,
        financialRequestId,
      },
    ];
    for (const scope of scopes) {
      const invocation = financialInvocation(claims, scope);
      const replay = financialInvocation(claims, scope);
      expect(invocation.auth).toEqual(claims);
      expect(invocation.auth).not.toBe(claims);
      expect(replay.auth).toEqual(invocation.auth);
      expect(replay.auth).not.toBe(invocation.auth);
      expect(replay.grant).not.toBe(invocation.grant);
      for (const wrongAuth of [claims, replay.auth]) {
        expect(() =>
          verifier.verifyFinancialAction(
            invocation.grant,
            wrongAuth,
            scope,
            clock.now(),
          ),
        ).toThrow(expect.objectContaining({ code: "UI_ACTION_REQUIRED" }));
      }
      for (const pair of [invocation, replay]) {
        expect(() =>
          verifier.verifyFinancialAction(
            pair.grant,
            pair.auth,
            scope,
            clock.now(),
          ),
        ).not.toThrow();
        expect(() =>
          verifier.verifyFinancialAction(
            pair.grant,
            pair.auth,
            scope,
            clock.now(),
          ),
        ).toThrow(expect.objectContaining({ code: "UI_ACTION_REQUIRED" }));
      }
    }
  });

  it("real native control: V2 exists at the first INSERT, six real CFEs and middleware inside tx", async () => {
    const f = await fixture(true);
    const before = await physical(f.world.tenantId);
    const source = await prisma.$transaction(async (tx) => {
      const foreignKeys = await tx.$queryRaw<
        Array<{ foreign_keys: bigint | number }>
      >`PRAGMA foreign_keys`;
      expect(foreignKeys.map((row) => Number(row.foreign_keys))).toEqual([1]);
      return expenses.createPlannedCardPurchaseInTx(
        tx,
        f.world.tenantId,
        f.world.projects.pessoal,
        {
          titulo: "Synthetic native control",
          fornecedor: null,
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          dataCompra: "2026-09-25",
          totalCents: 204042,
          cardId: f.world.cards.pessoal,
          schedule: {
            version: 1,
            occurrences: MONTHS.slice(0, 6).map((month, index) => ({
              index,
              parcela: `${index + 1}/6`,
              valor: 34007,
              data: `${month}-05`,
              invoiceDueMonth: month,
            })),
          },
          evidence: { documentSha256: SHA256, reference: "csv:record:2" },
          reason: "Synthetic independent native control",
        },
        f.auth.userId,
        {
          id: f.auth.userId,
          role: "USER",
          allowedProjects: [f.world.projects.pessoal, f.target.id],
          allowedProjectTypes: [],
          allowedModules: ["creditCards", "expenses"],
        },
      );
    });
    const insertion = created("Expense")[0]!;
    expect(insertion.inTransaction).toBe(true);
    if (
      !record(insertion.args) ||
      !record(insertion.args.data) ||
      typeof insertion.args.data.documentedSchedule !== "string"
    )
      throw new Error("No native INSERT");
    expect(
      parseStoredExpenseSchedule(insertion.args.data.documentedSchedule),
    ).toMatchObject({ version: 2, kind: "source", sourceExpenseId: source.id });
    const cfes = await setup.cashFlowEntry.findMany({
      where: { expenseId: source.id },
      orderBy: { data: "asc" },
    });
    expect(
      cfes.map((cfe) => [
        cfe.valor,
        cfe.parcela,
        cfe.invoiceDueMonth,
        cfe.status,
      ]),
    ).toEqual([
      [34007, "1/6", "2026-11", "PLANEJADO"],
      [34007, "2/6", "2026-12", "PLANEJADO"],
      [34007, "3/6", "2027-01", "PLANEJADO"],
      [34007, "4/6", "2027-02", "PLANEJADO"],
      [34007, "5/6", "2027-03", "PLANEJADO"],
      [34007, "6/6", "2027-04", "PLANEJADO"],
    ]);
    const after = await physical(f.world.tenantId);
    for (const table of FINANCIAL_TABLES.filter(
      (table) => table !== "expenses" && table !== "cash_flow_entries",
    ))
      expect(after[table]).toEqual(before[table]);
    await prisma.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id: source.id } });
      expect(
        await tx.expense.findFirst({ where: { id: source.id } }),
      ).toBeNull();
      expect(
        (await tx.expense.findUniqueOrThrow({ where: { id: source.id } }))
          .deletedAt,
      ).toEqual(FIXED_NOW);
    });
    expect(await setup.expense.count({ where: { id: source.id } })).toBe(1);
    await captureFinancialIds(f.world.tenantId);
    writes.length = 0;
    const witness = await prisma.$transaction((tx) =>
      tx.expense.upsert({
        where: { id: f.witness.id },
        create: f.witness,
        update: {
          valorTotal: f.witness.valorTotal,
          updatedAt: f.witness.updatedAt,
        },
      }),
    );
    expect(witness).toEqual(f.witness);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      model: "Expense",
      action: "upsert",
      inTransaction: true,
      insertedRows: 0,
      result: f.witness,
    });
    expect(created("Expense")).toEqual([]);
    expect(
      await setup.expense.findUniqueOrThrow({
        where: { id: f.witness.id },
      }),
    ).toEqual(f.witness);
  });

  it("four explicitly selected purchases create exactly 8/4/58; November 118767 and October zero", async () => {
    const workflow = composition();
    const f = await fixture();
    const before = await physical(f.world.tenantId);
    const { financialRequestId } = await prepareAndConfirm(workflow, f);
    writes.length = 0;
    const receipt = await execute(workflow, f, financialRequestId);
    assertFinancialWritesObserved();
    await assertBatch(f, receipt);
    const after = await physical(f.world.tenantId);
    for (const table of FINANCIAL_TABLES.filter(
      (table) =>
        !["expenses", "cash_flow_entries", "rateio_allocations"].includes(
          table,
        ),
    ))
      expect(after[table]).toEqual(before[table]);
  });

  it("lost response/reload uses durable IDs and a fresh invocation grant; current ACL still gates replay", async () => {
    const workflow = composition();
    const f = await fixture();
    const { financialRequestId, body } = await prepareAndConfirm(workflow, f);
    const first = await execute(workflow, f, financialRequestId);
    const before = await durable(f.world.tenantId);
    const reloaded = composition();
    expect(await reader.getResult(f.auth, f.session.id)).toEqual({
      state: "APPLIED",
      receipt: first,
    });
    writes.length = 0;
    const replayInvocation = financialInvocation(f.auth, {
      operation: "CONFIRM",
      sessionId: f.session.id,
      ...body,
      financialRequestId,
    });
    expect(
      await reloaded.confirm(
        replayInvocation.auth,
        f.session.id,
        { ...body, financialRequestId, nonce: null },
        replayInvocation.grant,
      ),
    ).toEqual({
      state: "APPLIED",
      sessionId: f.session.id,
      financialRequestId,
    });
    expect(await execute(reloaded, f, financialRequestId)).toEqual(first);
    expect(await durable(f.world.tenantId)).toEqual(before);
    expect(writes).toEqual([]);
    await setup.user.update({
      where: { id: f.auth.userId },
      data: { allowedProjects: JSON.stringify([f.world.projects.pessoal]) },
    });
    await expect(
      execute(reloaded, f, financialRequestId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await durable(f.world.tenantId)).toEqual(before);
  });

  it("failure after the LAST target CFE physically rolls back earlier effects, claims and session", async () => {
    const workflow = composition();
    const f = await fixture(true);
    const { financialRequestId } = await prepareAndConfirm(workflow, f);
    const before = await durable(f.world.tenantId);
    writes.length = 0;
    failure = "last-target-cfe";
    failureReached = false;
    await expect(execute(workflow, f, financialRequestId)).rejects.toThrow();
    expect(failureReached).toBe(true);
    assertFinancialWritesObserved();
    expect(await durable(f.world.tenantId)).toEqual(before);
    failure = null;
    writes.length = 0;
    await assertBatch(f, await execute(workflow, f, financialRequestId));
  });

  it("fourth claim CAS returns a real SQLite zero after all money and three complete claims; everything rolls back", async () => {
    const workflow = composition();
    const f = await fixture(true);
    const { financialRequestId } = await prepareAndConfirm(workflow, f);
    const before = await durable(f.world.tenantId);
    expect(
      await setup.importObservation.count({
        where: { id: "qa-unmatched-fourth-claim" },
      }),
    ).toBe(0);
    writes.length = 0;
    failure = "last-claim-cas";
    failureReached = false;
    await expect(execute(workflow, f, financialRequestId)).rejects.toThrow();
    expect(failureReached).toBe(true);
    assertFinancialWritesObserved();
    const claims = writes.filter(
      (event) => event.model === "ImportObservation",
    );
    expect(claims.map((event) => event.action)).toEqual([
      "updateMany",
      "updateMany",
      "updateMany",
      "updateMany",
    ]);
    expect(claims.map((event) => event.result)).toEqual([
      { count: 1 },
      { count: 1 },
      { count: 1 },
      { count: 0 },
    ]);
    const firstClaimPosition = writes.indexOf(claims[0]!);
    for (const event of writes.filter((event) =>
      ["Expense", "RateioAllocation", "CashFlowEntry"].includes(event.model),
    )) {
      expect(writes.indexOf(event)).toBeLessThan(firstClaimPosition);
    }
    const sourceIds = created("Expense").flatMap((event) =>
      record(event.result) &&
      event.result.projectId === f.world.projects.pessoal &&
      typeof event.result.id === "string"
        ? [event.result.id]
        : [],
    );
    expect(sourceIds).toHaveLength(4);
    const boundSources = claims.slice(0, 3).map((event) => {
      if (!record(event.args) || !record(event.args.data))
        throw new Error("Missing complete claim data");
      const data = event.args.data;
      expect(data).toMatchObject({
        canonicalProjectId: f.world.projects.pessoal,
        canonicalExpenseId: expect.any(String),
        canonicalReceiptId: null,
        canonicalIndex: null,
        claimSessionId: f.session.id,
        claimReceiptJson: expect.any(String),
        claimedAt: FIXED_NOW,
      });
      expect([1, { increment: 1 }]).toContainEqual(data.claimVersion);
      if (typeof data.claimReceiptJson !== "string")
        throw new Error("Missing claim receipt JSON");
      const claimReceiptJson = data.claimReceiptJson;
      expect(() => JSON.parse(claimReceiptJson)).not.toThrow();
      expect(sourceIds).toContain(data.canonicalExpenseId);
      return data.canonicalExpenseId;
    });
    expect(new Set(boundSources).size).toBe(3);
    expect(created("ImportSession")).toEqual([]);
    expect(created("UserActivityLog")).toEqual([]);
    expect(writes.filter((event) => event.model === "ImportSession")).toEqual(
      [],
    );
    expect(await durable(f.world.tenantId)).toEqual(before);
    failure = null;
    writes.length = 0;
    await assertBatch(f, await execute(workflow, f, financialRequestId));
  });

  it.each(["audit", "final-write"] as const)(
    "%s failure rolls back the entire confirmed batch and preserves exact retry state",
    async (point) => {
      const workflow = composition();
      const f = await fixture(true);
      const { financialRequestId } = await prepareAndConfirm(workflow, f);
      const before = await durable(f.world.tenantId);
      writes.length = 0;
      failure = point;
      failureReached = false;
      await expect(execute(workflow, f, financialRequestId)).rejects.toThrow();
      expect(failureReached).toBe(true);
      assertFinancialWritesObserved();
      expect(await durable(f.world.tenantId)).toEqual(before);
      failure = null;
      writes.length = 0;
      await assertBatch(f, await execute(workflow, f, financialRequestId));
    },
  );

  it("AC18 uses the real shared H8 plan and transfers all deferred scope plus the whole pending question", async () => {
    const workflow = composition();
    const f = await fixture(true);
    const { prepared, financialRequestId } = await prepareAndConfirm(
      workflow,
      f,
    );
    if (!prepared.proposal) throw new Error("Missing prepared proposal");
    const confirmed = await setup.importSession.findUniqueOrThrow({
      where: { id: f.session.id },
    });
    const {
      deferredObservationIds: _observations,
      deferredAttachmentIds: _attachments,
      retainUntil: _retention,
      ...proposalBody
    } = prepared.proposal;
    const observations = await setup.importObservation.findMany({
      where: { tenantId: f.world.tenantId },
    });
    const references = await setup.importSessionArtifact.findMany({
      where: { sessionId: f.session.id },
      include: { artifact: true },
    });
    const plan = buildImportPreparationPlan({
      session: confirmed,
      draft: f.draft,
      proposalBody,
      observations,
      references: references.map(({ artifact, ...ref }) => ({ ref, artifact })),
    });
    expect(plan.proposal).toEqual(prepared.proposal);
    expect(plan.continuation.writeCostUpperBound).toBe(101);
    expect(plan.expandedCounts.cashFlowEntries).toBe(58);
    expect(plan.continuationDraft?.questions).toEqual(f.draft.questions);
    const receipt = await execute(workflow, f, financialRequestId);
    expect(receipt.continuationSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const successor = await setup.importSession.findUniqueOrThrow({
      where: { id: receipt.continuationSessionId! },
    });
    expect(successor).toMatchObject({
      tenantId: f.world.tenantId,
      ownerUserId: f.auth.userId,
      ownerProjectId: f.world.projects.pessoal,
      expiresAt: confirmed.expiresAt,
      financialRequestId: null,
      confirmedRevision: null,
      proposalJson: null,
      challengeJson: null,
      receiptJson: null,
    });
    expect(JSON.parse(successor.draftJson)).toEqual(plan.continuationDraft);
    for (const ref of references) {
      const moved = await setup.importSessionArtifact.findUniqueOrThrow({
        where: { id: ref.id },
      });
      expect(moved).toMatchObject({
        sessionId: successor.id,
        tenantId: f.world.tenantId,
        ownerProjectId: f.world.projects.pessoal,
        artifactId: ref.artifactId,
        position: ref.position,
        state: ref.state,
        reservedBytes: ref.reservedBytes,
        temporaryPurgePending: ref.temporaryPurgePending,
        uploadGeneration: ref.uploadGeneration + 1,
        uploadSessionVersion: null,
        uploadTokenExpiresAt: null,
        uploadLeaseExpiresAt: null,
      });
    }
    const pendingId = plan.continuation.deferredObservations[0]!.id;
    expect(
      await setup.importObservation.findUniqueOrThrow({
        where: { id: pendingId },
      }),
    ).toMatchObject({
      claimVersion: 3,
      claimSessionId: null,
      canonicalExpenseId: null,
      claimedAt: null,
    });
    expect(
      await setup.importObservation.count({
        where: {
          tenantId: f.world.tenantId,
          claimSessionId: f.session.id,
          claimVersion: 1,
        },
      }),
    ).toBe(4);
    expect(
      await setup.importSessionArtifact.count({
        where: { sessionId: f.session.id },
      }),
    ).toBe(0);
    const childDraft = validateStoredDraft(JSON.parse(successor.draftJson));
    const deferredLine = childDraft.lines.find(
      (line) => line.id === "deferred",
    );
    if (!deferredLine) throw new Error("Missing preserved deferred line");
    const newLine = { ...deferredLine, id: "deferred-reviewed" };
    const financesBeforeEdit = await physical(f.world.tenantId);
    const pendingBeforeEdit = await setup.importObservation.findUniqueOrThrow({
      where: { id: pendingId },
    });
    const parentBeforeEdit = await setup.importSession.findUniqueOrThrow({
      where: { id: f.session.id },
    });
    await expect(
      workflow.edit(f.auth, successor.id, {
        expectedRevision: successor.revision,
        questionId: null,
        replaceLines: [newLine],
        selectedLineIds: [newLine.id],
      }),
    ).resolves.toMatchObject({
      state: "DRAFT",
      revision: successor.revision + 1,
      lines: [...childDraft.lines, newLine],
      selectedLineIds: [newLine.id],
    });
    const editedChild = await setup.importSession.findUniqueOrThrow({
      where: { id: successor.id },
    });
    expect(JSON.parse(editedChild.draftJson)).toEqual({
      ...childDraft,
      lines: [...childDraft.lines, newLine],
      selectedLineIds: [newLine.id],
    });
    expect(await physical(f.world.tenantId)).toEqual(financesBeforeEdit);
    expect(
      await setup.importObservation.findUniqueOrThrow({
        where: { id: pendingId },
      }),
    ).toEqual(pendingBeforeEdit);
    expect(
      await setup.importSession.findUniqueOrThrow({
        where: { id: f.session.id },
      }),
    ).toEqual(parentBeforeEdit);
  });

  it("Phase B: 188 claims at the approved 512 bound measure every row effect, roll back the final write and retry", async () => {
    const workflow = composition();
    const f = await boundaryFixture(188);
    const { prepared, financialRequestId } = await prepareAndConfirm(
      workflow,
      f,
    );
    if (!prepared.proposal) throw new Error("Missing boundary proposal");
    const session = await setup.importSession.findUniqueOrThrow({
      where: { id: f.session.id },
    });
    const {
      deferredObservationIds: _observations,
      deferredAttachmentIds: _attachments,
      retainUntil: _retention,
      ...proposalBody
    } = prepared.proposal;
    const observations = await setup.importObservation.findMany({
      where: { tenantId: f.world.tenantId },
    });
    const refs = await setup.importSessionArtifact.findMany({
      where: { sessionId: session.id },
      include: { artifact: true },
    });
    const plan = buildImportPreparationPlan({
      session,
      draft: f.draft,
      proposalBody,
      observations,
      references: refs.map(({ artifact, ...ref }) => ({ ref, artifact })),
    });
    expect(plan.expandedCounts).toEqual({
      cashFlowEntries: 240,
      financialAndCoordinationWrites: 512,
    });
    expect(plan.continuationDraft).toBeNull();
    expect(plan.transferRefIds).toEqual([]);
    expect(plan.leaseCleanupArtifactIds).toEqual([f.artifact.id]);
    const before = await durable(f.world.tenantId);
    writes.length = 0;
    rowEffects.length = 0;
    measureRowEffects = true;
    failure = "final-write";
    failureReached = false;
    await expect(execute(workflow, f, financialRequestId)).rejects.toThrow(
      "qa-real-batch:final-write",
    );
    expect(failureReached).toBe(true);
    expect(await durable(f.world.tenantId)).toEqual(before);
    const rolledBackCost = measuredBudget("maximum-final-write-rollback");
    failure = null;
    writes.length = 0;
    rowEffects.length = 0;
    const receipt = await execute(workflow, f, financialRequestId);
    expect(measuredBudget("maximum-committed-retry")).toBe(rolledBackCost);
    expect(receipt.items).toHaveLength(10);
    expect(receipt.snapshot.createdEconomicTotalCents).toBe(12000);
    expect(receipt.snapshot.bankCashDeltaCents).toBe(0);
    expect(receipt.continuationSessionId).toBeNull();
    expect(
      new Set(receipt.items.map((item) => item.sourceExpenseId)).size,
    ).toBe(10);
    for (const item of receipt.items) {
      expect(item.outcome).toBe("CREATED");
      expect(item.targetExpenseIds).toHaveLength(1);
      expect(item.allocationIds).toHaveLength(1);
      expect(item.cashFlowEntryIds).toHaveLength(24);
    }
    expect(
      await setup.expense.count({
        where: { tenantId: f.world.tenantId, id: { not: f.witness.id } },
      }),
    ).toBe(20);
    expect(
      await setup.rateioAllocation.count({
        where: { tenantId: f.world.tenantId },
      }),
    ).toBe(10);
    expect(
      await setup.cashFlowEntry.count({
        where: { tenantId: f.world.tenantId, expenseId: { not: f.witness.id } },
      }),
    ).toBe(240);
    const claimed = await setup.importObservation.findMany({
      where: { tenantId: f.world.tenantId },
    });
    expect(claimed).toHaveLength(188);
    expect(
      claimed.every(
        (observation) =>
          observation.claimVersion === 1 &&
          observation.claimSessionId === f.session.id &&
          observation.canonicalIndex === null &&
          receipt.items.some(
            (item) => item.sourceExpenseId === observation.canonicalExpenseId,
          ),
      ),
    ).toBe(true);
    const after = await physical(f.world.tenantId);
    for (const table of FINANCIAL_TABLES.filter(
      (table) =>
        !["expenses", "cash_flow_entries", "rateio_allocations"].includes(
          table,
        ),
    ))
      expect(after[table]).toEqual(before[table]);
    expect(
      await setup.expense.findUniqueOrThrow({ where: { id: f.witness.id } }),
    ).toEqual(f.witness);
    const artifact = await setup.importArtifact.findUniqueOrThrow({
      where: { id: f.artifact.id },
    });
    expect(artifact).toMatchObject({
      leaseSessionId: null,
      parseGeneration: f.artifact.parseGeneration + 1,
    });
    const applied = await setup.importSession.findUniqueOrThrow({
      where: { id: f.session.id },
    });
    expect(applied.state).toBe("APPLIED");
    expect(JSON.parse(applied.receiptJson!)).toEqual(receipt);
  });

  it.each([
    [189, 513],
    [200, 524],
  ] as const)(
    "Phase B: %i claims at literal cost %i refuse before effects without truncating scope",
    async (claims, _cost) => {
      const workflow = composition();
      const f = await boundaryFixture(claims);
      const before = await durable(f.world.tenantId);
      writes.length = 0;
      await expect(
        workflow.prepare(f.auth, f.session.id, {
          expectedRevision: f.session.revision,
        }),
      ).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
        reason: "WRITE_BUDGET_EXCEEDED",
      });
      expect(await durable(f.world.tenantId)).toEqual(before);
      expect(writes).toEqual([]);
    },
  );

  it.each(["same-request", "competing-session"] as const)(
    "Phase B: two real SQLite writers serialize %s at an observed reservation/dispatch barrier",
    async (mode) => {
      const workflow = composition();
      const f = await fixture();
      const firstApproval = await prepareAndConfirm(workflow, f);
      const secondPrisma = new PrismaService();
      const secondConciliacao = new ConciliacaoService(secondPrisma);
      const secondWorkflow = new ImportSessionWorkflowService(
        secondPrisma,
        clock,
        capability,
        verifier,
        new CardPurchaseBatchAdapter(
          new ExpenseService(secondPrisma, secondConciliacao),
          secondConciliacao,
          clock,
        ),
        ...rawTestDependencies(
          new ImportVaultGate(secondPrisma, clock, {}, process.cwd()),
          clock,
          capability,
        ),
      );
      await secondPrisma.onModuleInit();
      const reserved = barrier();
      const releaseFirst = barrier();
      const contenderDispatched = barrier();
      const events: string[] = [];
      const contenderFinancialWrites: string[] = [];
      const startTransaction = secondPrisma.$transaction.bind(secondPrisma);
      let restoreTransaction: (() => void) | undefined;
      let competing = f;
      let secondKey = firstApproval.financialRequestId;
      let firstResult:
        | Promise<PromiseSettledResult<ImportSessionReceiptV1>>
        | undefined;
      let secondResult:
        | Promise<PromiseSettledResult<ImportSessionReceiptV1>>
        | undefined;
      const settled = (promise: Promise<ImportSessionReceiptV1>) =>
        Promise.allSettled([promise]).then((results) => results[0]!);
      try {
        expect(secondPrisma).not.toBe(prisma);
        const firstDatabase = await prisma.$queryRaw<
          Array<{ name: string; file: string }>
        >`PRAGMA database_list`;
        const secondDatabase = await secondPrisma.$queryRaw<
          Array<{ name: string; file: string }>
        >`PRAGMA database_list`;
        const main = firstDatabase.find((database) => database.name === "main");
        expect(main?.file).toBe(
          process.env.DATABASE_URL!.slice("file:".length),
        );
        expect(
          secondDatabase.find((database) => database.name === "main")?.file,
        ).toBe(main?.file);
        if (mode === "competing-session") {
          const createRequestId = randomUUID();
          const { view: session } = await reader.create(
            f.auth,
            {
              version: 1,
              createRequestId,
              cardId: f.world.cards.pessoal,
              consentPolicyVersion: 1,
              consentAnalyze: true,
            },
            mintGrant(issuer, f.auth, {
              operation: "CREATE_SESSION",
              cardId: f.world.cards.pessoal,
              createRequestId,
              consentPolicyVersion: 1,
            }),
          );
          await setup.importSessionArtifact.create({
            data: {
              tenantId: f.world.tenantId,
              ownerProjectId: f.world.projects.pessoal,
              sessionId: session.id,
              artifactId: f.artifact.id,
              position: 0,
              fileName: "same-original.csv",
              declaredMime: "text/csv",
              declaredBytes: ORIGINAL.length,
              reservedBytes: ORIGINAL.length,
              state: "ATTACHED",
              verifiedAt: FIXED_NOW,
            },
          });
          await setup.importSession.update({
            where: { id: session.id },
            data: { draftJson: JSON.stringify(f.draft) },
          });
          competing = { ...f, session };
          const approval = await prepareAndConfirm(secondWorkflow, competing);
          secondKey = approval.financialRequestId;
        }
        const financesBefore = await physical(f.world.tenantId);
        const competingBefore = await setup.importSession.findUniqueOrThrow({
          where: { id: competing.session.id },
        });
        const auditBefore = await setup.userActivityLog.count({
          where: { tenantId: f.world.tenantId },
        });
        await captureFinancialIds(f.world.tenantId);
        writes.length = 0;
        beforeEligibilityRead = () => {
          events.push("A_ELIGIBILITY");
        };
        afterWriterReservation = async (rows) => {
          expect(rows).toBe(1);
          expect(events).not.toContain("A_ELIGIBILITY");
          events.push("A_RESERVED");
          reserved.release();
          await releaseFirst.reached;
        };
        secondPrisma.$use(async (params, next) => {
          if (params.model === "User" && params.action.startsWith("find")) {
            expect(params.runInTransaction).toBe(true);
            events.push("B_ELIGIBILITY");
          }
          if (
            [
              "Expense",
              "CashFlowEntry",
              "RateioAllocation",
              "ImportObservation",
              "UserActivityLog",
            ].includes(params.model ?? "") &&
            [
              "create",
              "createMany",
              "update",
              "updateMany",
              "delete",
              "deleteMany",
              "upsert",
            ].includes(params.action)
          )
            contenderFinancialWrites.push(`${params.model}.${params.action}`);
          if (params.action !== "executeRaw") return next(params);
          expect(params.runInTransaction).toBe(true);
          events.push("B_WRITER_DISPATCH");
          const rows: unknown = await next(params);
          expect(rows).toBe(1);
          events.push("B_RESERVED");
          return rows;
        });
        // SQLite can reserve at BEGIN before entering the writer middleware.
        const transactionDispatch = jest
          .spyOn(secondPrisma, "$transaction")
          .mockImplementation((callback, options) => {
            const pending = startTransaction(callback, options);
            events.push("B_TRANSACTION_DISPATCH");
            contenderDispatched.release();
            return pending;
          });
        restoreTransaction = () => transactionDispatch.mockRestore();
        const firstInvocation = financialInvocation(f.auth, {
          operation: "EXECUTE",
          sessionId: f.session.id,
          financialRequestId: firstApproval.financialRequestId,
        });
        firstResult = settled(
          workflow.execute(
            firstInvocation.auth,
            f.session.id,
            { financialRequestId: firstApproval.financialRequestId },
            firstInvocation.grant,
          ),
        );
        await Promise.race([
          reserved.reached,
          firstResult.then(() => {
            throw new Error(
              "First invocation finished without the reservation barrier",
            );
          }),
        ]);
        const secondInvocation = financialInvocation(competing.auth, {
          operation: "EXECUTE",
          sessionId: competing.session.id,
          financialRequestId: secondKey,
        });
        secondResult = settled(
          secondWorkflow.execute(
            secondInvocation.auth,
            competing.session.id,
            { financialRequestId: secondKey },
            secondInvocation.grant,
          ),
        );
        await Promise.race([
          contenderDispatched.reached,
          secondResult.then(() => {
            throw new Error(
              "Contender finished before dispatching its native transaction",
            );
          }),
        ]);
        expect(events).toEqual(["A_RESERVED", "B_TRANSACTION_DISPATCH"]);
        events.push("A_RELEASE");
        releaseFirst.release();
        const first = await firstResult;
        const second = await secondResult;
        if (first.status !== "fulfilled") throw first.reason;
        if (mode === "same-request") {
          if (second.status !== "fulfilled") throw second.reason;
          expect(second.value).toEqual(first.value);
        } else {
          expect(second.status).toBe("rejected");
          if (second.status !== "rejected")
            throw new Error("Competing session applied twice");
          expect(second.reason).toMatchObject({ code: "STALE_PREVIEW" });
          expect(
            await setup.importSession.findUniqueOrThrow({
              where: { id: competing.session.id },
            }),
          ).toMatchObject({
            state: "REVIEW_REQUIRED",
            revision: competingBefore.revision + 1,
            receiptJson: null,
            financialRequestId: secondKey,
            confirmedRevision: competingBefore.confirmedRevision,
            confirmedSessionVersion: competingBefore.confirmedSessionVersion,
            proposalHash: competingBefore.proposalHash,
            proposalJson: competingBefore.proposalJson,
          });
        }
        expect(events.indexOf("A_ELIGIBILITY")).toBeGreaterThan(
          events.indexOf("A_RELEASE"),
        );
        expect(events.indexOf("B_RESERVED")).toBeGreaterThan(
          events.indexOf("A_RELEASE"),
        );
        expect(events.indexOf("B_WRITER_DISPATCH")).toBeGreaterThan(
          events.indexOf("B_TRANSACTION_DISPATCH"),
        );
        expect(events.indexOf("B_ELIGIBILITY")).toBeGreaterThan(
          events.indexOf("B_RESERVED"),
        );
        expect(contenderFinancialWrites).toEqual([]);
        await assertBatch(f, first.value);
        expect(
          await setup.importObservation.count({
            where: {
              tenantId: f.world.tenantId,
              claimSessionId: f.session.id,
              claimVersion: 1,
            },
          }),
        ).toBe(4);
        expect(
          await setup.userActivityLog.count({
            where: { tenantId: f.world.tenantId },
          }),
        ).toBe(auditBefore + 1);
        const financesAfter = await physical(f.world.tenantId);
        for (const table of FINANCIAL_TABLES.filter(
          (table) =>
            !["expenses", "cash_flow_entries", "rateio_allocations"].includes(
              table,
            ),
        ))
          expect(financesAfter[table]).toEqual(financesBefore[table]);
        console.info(
          "QA_PHASE_B_SQLITE_BARRIER",
          JSON.stringify({
            mode,
            events,
            contenderFinancialWrites: contenderFinancialWrites.length,
            sources: first.value.items.length,
            claims: 4,
          }),
        );
      } finally {
        releaseFirst.release();
        afterWriterReservation = null;
        beforeEligibilityRead = null;
        restoreTransaction?.();
        await Promise.all([firstResult, secondResult]);
        await secondPrisma.onModuleDestroy();
      }
    },
  );

  it("later documentary 2/10 explicitly keeps twin B and preserves PAGO, history, IDs and amounts", async () => {
    const workflow = composition();
    const f = await fixture();
    const { financialRequestId } = await prepareAndConfirm(workflow, f);
    const first = await execute(workflow, f, financialRequestId);
    const twinA = first.items.find((item) => item.lineId === "twin-a")!;
    const twinB = first.items.find((item) => item.lineId === "twin-b")!;
    expect(twinA.sourceExpenseId).not.toBe(twinB.sourceExpenseId);
    await setup.cashFlowEntry.updateMany({
      where: { expenseId: twinB.sourceExpenseId, parcela: "2/10" },
      data: { status: "PAGO" },
    });
    await setup.expense.update({
      where: { id: twinB.sourceExpenseId },
      data: { paidParcelas: "[1]" },
    });
    const createRequestId = randomUUID();
    const { view: later } = await reader.create(
      f.auth,
      {
        version: 1,
        createRequestId,
        cardId: f.world.cards.pessoal,
        consentPolicyVersion: 1,
        consentAnalyze: true,
      },
      mintGrant(issuer, f.auth, {
        operation: "CREATE_SESSION",
        cardId: f.world.cards.pessoal,
        createRequestId,
        consentPolicyVersion: 1,
      }),
    );
    const laterArtifact = await setup.importArtifact.create({
      data: {
        tenantId: f.world.tenantId,
        ownerProjectId: f.world.projects.pessoal,
        documentSha256: createHash("sha256")
          .update("synthetic later 2/10")
          .digest("hex"),
        verifiedBytes: 21,
        detectedFormat: "CSV",
        state: "EXTRACTED",
      },
    });
    await setup.importSessionArtifact.create({
      data: {
        tenantId: f.world.tenantId,
        ownerProjectId: f.world.projects.pessoal,
        sessionId: later.id,
        artifactId: laterArtifact.id,
        position: 0,
        fileName: "later.csv",
        declaredMime: "text/csv",
        declaredBytes: 21,
        reservedBytes: 21,
        state: "ATTACHED",
        verifiedAt: FIXED_NOW,
      },
    });
    const evidence: StoredImportObservationEvidenceV1 = {
      version: 1,
      reference: "csv:record:2",
      text: "Synthetic twins 2/10",
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentCount: 10,
      installmentIndex: 2,
      dataCompra: "2026-09-25",
      identity: {
        merchant: "Synthetic twins",
        externalId: null,
        fitId: null,
        ordinal: 0,
        fileContentHash: fileContentHash([Buffer.from("synthetic later 2/10")]),
      },
    };
    const observation = await setup.importObservation.create({
      data: {
        tenantId: f.world.tenantId,
        ownerProjectId: f.world.projects.pessoal,
        artifactId: laterArtifact.id,
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
      },
    });
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      selectedLineIds: ["later-twin-b"],
      questions: [],
      scope: { observationIds: [observation.id], pendingAttachmentIds: [] },
      lines: [
        {
          id: "later-twin-b",
          observationIds: [observation.id],
          titulo: "Synthetic twins",
          fornecedor: "Synthetic twins",
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          amountMeaning: "INSTALLMENT_CHARGE",
          amountCents: 6984,
          installmentCount: 10,
          dataCompra: "2026-09-25",
          firstDueDate: "2026-11-05",
          targets: [],
          decision: { kind: "KEEP_EXISTING", expenseId: twinB.sourceExpenseId },
        },
      ],
    };
    validateStoredDraft(draft);
    await setup.importSession.update({
      where: { id: later.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    await freezeExtraction(setup, laterArtifact.id);
    const before = await physical(f.world.tenantId);
    const nextFixture = { ...f, session: later, draft };
    const next = await prepareAndConfirm(workflow, nextFixture);
    writes.length = 0;
    const kept = await execute(workflow, nextFixture, next.financialRequestId);
    expect(kept.items).toHaveLength(1);
    expect(kept.items[0]).toMatchObject({
      lineId: "later-twin-b",
      outcome: "KEPT_EXISTING",
      sourceExpenseId: twinB.sourceExpenseId,
    });
    expect(kept.snapshot.createdEconomicTotalCents).toBe(0);
    expect(kept.snapshot.bankCashDeltaCents).toBe(0);
    expect(await physical(f.world.tenantId)).toEqual(before);
    expect(
      await setup.importObservation.findUniqueOrThrow({
        where: { id: observation.id },
      }),
    ).toMatchObject({
      claimSessionId: later.id,
      canonicalExpenseId: twinB.sourceExpenseId,
      canonicalIndex: 1,
      canonicalReceiptId: null,
      claimVersion: 1,
    });
    expect(created("Expense")).toEqual([]);
    expect(created("CashFlowEntry")).toEqual([]);
    expect(created("RateioAllocation")).toEqual([]);
  });
});

async function freezeExtraction(
  prisma: Pick<PrismaService, "importObservation" | "importArtifact">,
  artifactId: string,
): Promise<void> {
  const rows = await prisma.importObservation.findMany({
    where: { artifactId },
  });
  rows.sort((a, b) =>
    a.reference.localeCompare(b.reference, "en", { numeric: true }),
  );
  const extraction = validateDocumentExtraction({
    version: 1,
    parserVersion: "card-local-text-v1",
    documentKind: "UNKNOWN",
    invoiceDueMonth: null,
    metrics: {
      pages: 0,
      rows: rows.length,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: rows.map((row, sourceOrdinal) => {
      const original = parseStoredImportObservationEvidence(row.evidenceJson);
      return {
        reference: row.reference,
        sourceOrdinal,
        section: "UNKNOWN",
        raw: {
          date: original.dataCompra,
          description: original.text,
          amount: null,
          installment: null,
        },
        cycle: null,
        dateOnly: original.dataCompra,
        merchant: original.identity.merchant,
        amountCents: original.amountCents,
        amountMeaning: original.amountMeaning,
        installmentCount: original.installmentCount,
        installmentIndex: original.installmentIndex,
        fitId: original.identity.fitId,
        identityOrdinal: original.identity.ordinal,
      };
    }),
    diagnostics: [],
  });
  await prisma.importArtifact.update({
    where: { id: artifactId },
    data: {
      parserVersion: extraction.parserVersion,
      extractionJson: JSON.stringify(extraction),
    },
  });
}
