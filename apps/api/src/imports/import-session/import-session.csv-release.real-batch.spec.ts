// The database guard must run before Prisma is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { createHash, randomUUID } from "node:crypto";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import {
  ExpenseType,
  buildInstallments,
  type ImportSessionDraftLineV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import {
  computeImportOrdinals,
  fileContentHash,
} from "../../credit-card/parsers/dedupe-key";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import { ExpenseService } from "../../expense/expense.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  cleanupImportWorld,
  FIXED_NOW,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
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
import { ImportSessionService } from "./import-session.service";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { IMPORT_UI_HEADER, ImportUiGuard } from "./import-session-ui.guard";
import { validateStoredDraft } from "./import-session.validation";
import { ImportVaultGate } from "./vault/vault-state";

type Decision =
  | { kind: "CREATE"; acceptNaturalDuplicate: boolean }
  | { kind: "KEEP_EXISTING"; expenseId: string }
  | { kind: "DEFER" }
  | { kind: "EXCLUDE" }
  | {
      kind: "IGNORED_POLICY";
      reason: "INVOICE_PAYMENT" | "CARD_PAYS_CARD";
      policyVersion: 1;
    };
type LineSeed = {
  id: string;
  title: string;
  amountCents: number;
  amountMeaning?: "UNKNOWN";
  draftAmountCents?: number | null;
  installmentCount: number;
  targets: Array<{ projectId: string; roomId: null; amountCents: number }>;
  decision?: Decision;
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

const capability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => ["CSV"],
};
const clock = new MutableClock();
const prisma = new PrismaService();
const issuer = new ImportUiGrantIssuer(clock);
const verifier = new RuntimeUiGrantVerifier();
const conciliacao = new ConciliacaoService(prisma);
const expenses = new ExpenseService(prisma, conciliacao);
const vault = new ImportVaultGate(prisma, clock, {}, process.cwd());
const reader = new ImportSessionService(
  prisma,
  clock,
  capability,
  verifier,
  ...rawTestDependencies(vault, clock, capability),
);
const workflow = () =>
  new ImportSessionWorkflowService(
    prisma,
    clock,
    capability,
    verifier,
    new CardPurchaseBatchAdapter(expenses, conciliacao, clock),
    ...rawTestDependencies(vault, clock, capability),
  );

let sequence = 0;
const prefixes: string[] = [];
let failModel: "CashFlowEntry" | "UserActivityLog" | null = null;
let failCashFlowProjectId: string | null = null;
let failureReached = false;

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
  const symbol = Object.getOwnPropertySymbols(request).find(
    (item) => item.description === "IMPORT_AUTH_CONTEXT",
  );
  if (!symbol) throw new Error("missing import auth context");
  const auth: unknown = Reflect.get(request, symbol);
  assertMintedImportContext(auth);
  return {
    auth,
    grant: issuer.issueFinancialAction(request, auth, scope),
  };
}

async function fixture(
  seeds?: (world: ImportWorld, reformaId: string) => LineSeed[],
  startingRevision?: number,
): Promise<{
  world: ImportWorld;
  reformaId: string;
  auth: AuthenticatedImportContext;
  sessionId: string;
  revision: number;
  artifactId: string;
  draft: ImportSessionStoredDraftV1;
  observationIds: string[];
}> {
  clock.current = FIXED_NOW;
  const prefix = `maria-real-batch-${++sequence}`;
  prefixes.push(prefix);
  const world = await seedImportWorld(prisma, prefix);
  const reforma = await prisma.project.create({
    data: {
      tenantId: world.tenantId,
      type: "REFORMA",
      name: "Reforma autorizada",
    },
  });
  await prisma.creditCard.update({
    where: { id: world.cards.pessoal },
    data: { closingDay: 27, dueDay: 5 },
  });
  await prisma.user.update({
    where: { id: world.users.restricted.id },
    data: {
      allowedProjects: JSON.stringify([world.projects.pessoal, reforma.id]),
      allowedModules: JSON.stringify(["creditCards", "expenses"]),
    },
  });
  const auth = authFor(world.users.restricted);
  const created = {
    view: await seedSession(prisma, world, {
      ownerUserId: world.users.restricted.id,
      cardId: world.cards.pessoal,
      revision: startingRevision ?? 1,
    }),
  };
  const lines = seeds?.(world, reforma.id) ?? [
    {
      id: "pessoal-only",
      title: "Compra em três parcelas",
      amountCents: 10_001,
      installmentCount: 3,
      targets: [],
    },
    {
      id: "reforma",
      title: "Compra rateada integral",
      amountCents: 25_000,
      installmentCount: 1,
      targets: [{ projectId: reforma.id, roomId: null, amountCents: 25_000 }],
    },
  ];
  const csvBytes = Buffer.from(
    [
      "date,title,amount",
      ...lines.map(
        (line) =>
          `2026-09-25,${line.title.replaceAll(",", " ")},${(line.amountCents / 100).toFixed(2)}`,
      ),
      "",
    ].join("\n"),
  );
  const extraction = extractCardStatementDocument({
    version: 1,
    context: "CARD_INVOICE",
    format: "CSV",
    profile: "CSV_NUBANK",
    bytes: csvBytes,
  });
  const artifact = await prisma.importArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      documentSha256: createHash("sha256").update(csvBytes).digest("hex"),
      verifiedBytes: csvBytes.length,
      detectedFormat: "CSV",
      state: "EXTRACTED",
      parserVersion: extraction.parserVersion,
      extractionJson: JSON.stringify(extraction),
    },
  });
  await prisma.importSessionArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      sessionId: created.view.id,
      artifactId: artifact.id,
      position: 0,
      fileName: "fatura.csv",
      declaredMime: "text/csv",
      declaredBytes: csvBytes.length,
      reservedBytes: 0,
      state: "ATTACHED",
      verifiedAt: FIXED_NOW,
    },
  });
  const ordinals = computeImportOrdinals(
    lines.map((line) => ({
      date: new Date("2026-09-25T00:00:00.000Z"),
      merchant: line.title,
      amountCents: line.amountCents,
    })),
  );
  const observationIds: string[] = [];
  const draftLines: ImportSessionDraftLineV1[] = [];
  for (const [index, line] of lines.entries()) {
    const evidence: StoredImportObservationEvidenceV1 = {
      version: 1,
      reference: `csv:record:${index + 2}`,
      text: line.title,
      amountMeaning: line.amountMeaning ?? "TOTAL_PURCHASE",
      amountCents: line.amountCents,
      installmentCount: line.installmentCount,
      installmentIndex: null,
      dataCompra: "2026-09-25",
      identity: {
        merchant: line.title,
        externalId: null,
        fitId: null,
        ordinal: ordinals[index]!,
        fileContentHash: fileContentHash([csvBytes]),
      },
    };
    const observation = await prisma.importObservation.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
      },
    });
    observationIds.push(observation.id);
    draftLines.push({
      id: line.id,
      observationIds: [observation.id],
      titulo: line.title,
      fornecedor: line.title,
      tipoDespesa:
        line.targets.length === 1
          ? ExpenseType.MATERIAL_CONSTRUCAO
          : ExpenseType.OUTROS,
      categoriaMaoDeObra: null,
      amountMeaning: line.amountMeaning ?? "TOTAL_PURCHASE",
      amountCents:
        line.draftAmountCents === undefined
          ? line.amountCents
          : line.draftAmountCents,
      installmentCount: line.installmentCount,
      dataCompra: "2026-09-25",
      firstDueDate: "2026-10-05",
      targets: line.targets,
      decision: (line.decision ?? {
        kind: "CREATE",
        acceptNaturalDuplicate: false,
      }) as ImportSessionDraftLineV1["decision"],
    });
  }
  const draft = validateStoredDraft({
    version: 1,
    lines: draftLines,
    selectedLineIds: draftLines
      .filter((line) =>
        ["CREATE", "KEEP_EXISTING"].includes(line.decision.kind),
      )
      .map((line) => line.id),
    questions: [],
    scope: { observationIds, pendingAttachmentIds: [] },
    fieldProvenance: draftLines.flatMap((line) =>
      (["decision", "targets", "tipoDespesa"] as const).map((field) => ({
        origin: "USER" as const,
        lineId: line.id,
        field,
        recordedRevision: created.view.revision,
      })),
    ),
  });
  await prisma.importSession.update({
    where: { id: created.view.id },
    data: { draftJson: JSON.stringify(draft) },
  });
  return {
    world,
    reformaId: reforma.id,
    auth,
    sessionId: created.view.id,
    revision: created.view.revision,
    artifactId: artifact.id,
    draft,
    observationIds,
  };
}

async function prepareAndConfirm(f: Fixture) {
  const service = workflow();
  const prepared = await service.prepare(f.auth, f.sessionId, {
    expectedRevision: f.revision,
  });
  expect(prepared.state).toBe("READY");
  if (!prepared.proposal) throw new Error("missing proposal");
  const lot = await service.currentLot(f.auth, f.sessionId);
  const challengeScope = {
    operation: "CHALLENGE" as const,
    sessionId: f.sessionId,
    expectedRevision: prepared.revision,
    confirmationHash: lot.confirmationHash,
  };
  const challengeInvocation = financialInvocation(f.auth, challengeScope);
  const challenge = await service.challenge(
    challengeInvocation.auth,
    f.sessionId,
    {
      expectedRevision: prepared.revision,
      confirmationHash: lot.confirmationHash,
    },
    challengeInvocation.grant,
  );
  const financialRequestId = randomUUID();
  const confirmScope = {
    ...challengeScope,
    operation: "CONFIRM" as const,
    financialRequestId,
  };
  const confirmInvocation = financialInvocation(f.auth, confirmScope);
  await service.confirm(
    confirmInvocation.auth,
    f.sessionId,
    {
      expectedRevision: prepared.revision,
      confirmationHash: lot.confirmationHash,
      financialRequestId,
      nonce: challenge.nonce,
    },
    confirmInvocation.grant,
  );
  return { service, prepared, financialRequestId };
}

async function execute(
  service: ImportSessionWorkflowService,
  f: Fixture,
  financialRequestId: string,
) {
  const scope = {
    operation: "EXECUTE" as const,
    sessionId: f.sessionId,
    financialRequestId,
  };
  const invocation = financialInvocation(f.auth, scope);
  return service.execute(
    invocation.auth,
    f.sessionId,
    { financialRequestId },
    invocation.grant,
  );
}

async function financialRows(tenantId: string) {
  return {
    expenses: await prisma.expense.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    cfes: await prisma.cashFlowEntry.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    allocations: await prisma.rateioAllocation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    settlements: await prisma.crossProjectSettlement.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    funding: await prisma.invoiceFundingAllocation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
    receipts: await prisma.receipt.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    }),
  };
}

describe("Maria CSV real financial release batch", () => {
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
    await prisma.onModuleInit();
    prisma.$use(async (params, next) => {
      if (failModel && params.model === failModel) {
        const isWrite = [
          "create",
          "createMany",
          "update",
          "updateMany",
        ].includes(params.action);
        const data = params.args.data as
          | { projectId?: string }
          | Array<{ projectId?: string }>
          | undefined;
        const rows = Array.isArray(data) ? data : data ? [data] : [];
        const isSelectedCashFlowWrite =
          params.model !== "CashFlowEntry" ||
          failCashFlowProjectId === null ||
          rows.some((row) => row.projectId === failCashFlowProjectId);
        if (isWrite && isSelectedCashFlowWrite) {
          failureReached = true;
          throw new Error(`release-fixture:${failModel}`);
        }
      }
      return next(params);
    });
  });

  afterEach(() => {
    failModel = null;
    failCashFlowProjectId = null;
    failureReached = false;
  });

  afterAll(async () => {
    for (const prefix of prefixes) await cleanupImportWorld(prisma, prefix);
    await prisma.onModuleDestroy();
    jest.useRealTimers();
  });

  it("keeps the real semantic binding through READY36 -> CONFIRMED37 -> APPLIED38", async () => {
    const f = await fixture(
      (_world, reformaId) => [
        {
          id: "semantic-binding",
          title: "Compra com vínculo semântico",
          amountCents: 25_000,
          installmentCount: 1,
          targets: [
            { projectId: reformaId, roomId: null, amountCents: 25_000 },
          ],
        },
      ],
      35,
    );
    for (const line of f.draft.lines)
      line.decision = { kind: "CREATE", acceptNaturalDuplicate: false };
    f.draft.fieldProvenance = f.draft.lines.flatMap((line) =>
      (["decision", "targets", "tipoDespesa"] as const).map((field) => ({
        origin: "USER" as const,
        lineId: line.id,
        field,
        recordedRevision: 35,
      })),
    );
    f.draft.declarations = { version: 1, items: [] };
    f.draft.commandLedger = { version: 1, items: [] };
    await prisma.importSession.update({
      where: { id: f.sessionId },
      data: {
        draftJson: JSON.stringify(validateStoredDraft(f.draft)),
      },
    });

    const ready = await prepareAndConfirm(f);
    expect(ready.prepared).toMatchObject({ state: "READY", revision: 36 });
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: f.sessionId },
        select: { state: true, revision: true },
      }),
    ).toEqual({ state: "CONFIRMED", revision: 37 });

    await execute(ready.service, f, ready.financialRequestId);
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: f.sessionId },
        select: { state: true, revision: true },
      }),
    ).toEqual({ state: "APPLIED", revision: 38 });
  });

  it("creates_the_exact_PESSOAL_only_and_one_REFORMA_graph_in_centavos", async () => {
    const f = await fixture();
    const { service, prepared, financialRequestId } =
      await prepareAndConfirm(f);
    expect(prepared.proposal).toMatchObject({
      createdEconomicTotalCents: 35_001,
      bankCashDeltaCents: 0,
      effects: {
        personalSourceCreates: 2,
        reformaTargetCreates: 1,
        expenseCreates: 3,
        cashFlowEntryCreates: 5,
        rateioAllocationCreates: 1,
      },
    });
    const receipt = await execute(service, f, financialRequestId);
    const rows = await financialRows(f.world.tenantId);

    expect(rows.expenses).toHaveLength(3);
    expect(rows.cfes).toHaveLength(5);
    expect(rows.allocations).toHaveLength(1);
    expect(rows.allocations[0]?.allocation).toBe(25_000);
    const pessoal = rows.expenses.filter(
      (expense) => expense.projectId === f.world.projects.pessoal,
    );
    const reforma = rows.expenses.filter(
      (expense) => expense.projectId === f.reformaId,
    );
    expect(pessoal).toHaveLength(2);
    expect(reforma).toHaveLength(1);
    expect(
      pessoal.find((expense) => expense.valorTotal === 10_001),
    ).toMatchObject({
      linkedExpenseId: null,
      status: "PLANEJADO",
      paidParcelas: null,
    });
    expect(reforma[0]).toMatchObject({
      valorTotal: 25_000,
      status: "PLANEJADO",
      paidParcelas: null,
    });
    const installmentSource = pessoal.find(
      (expense) => expense.valorTotal === 10_001,
    );
    expect(
      rows.cfes
        .filter((entry) => entry.expenseId === installmentSource?.id)
        .map((entry) => entry.valor)
        .sort((a, b) => a - b),
    ).toEqual([3_333, 3_333, 3_335]);
    expect(rows.settlements).toEqual([]);
    expect(rows.funding).toEqual([]);
    expect(receipt.snapshot).toMatchObject({
      createdEconomicTotalCents: 35_001,
      bankCashDeltaCents: 0,
    });
    expect(pessoal.reduce((sum, expense) => sum + expense.valorTotal, 0)).toBe(
      35_001,
    );
    expect(reforma.reduce((sum, expense) => sum + expense.valorTotal, 0)).toBe(
      25_000,
    );
  });

  it("preserves signed immutable invoice-payment evidence only in the ignored audit row", async () => {
    const f = await fixture((_world, reformaId) => [
      {
        id: "pessoal-a",
        title: "Compra pessoal A",
        amountCents: 10_001,
        installmentCount: 1,
        targets: [],
      },
      {
        id: "pessoal-b",
        title: "Compra pessoal B",
        amountCents: 10_001,
        installmentCount: 1,
        targets: [],
      },
      {
        id: "reforma",
        title: "Compra rateada integral",
        amountCents: 25_000,
        installmentCount: 1,
        targets: [{ projectId: reformaId, roomId: null, amountCents: 25_000 }],
      },
      {
        id: "ignored-payment",
        title: "PAGAMENTO EFETUADO",
        amountCents: -45_002,
        amountMeaning: "UNKNOWN",
        draftAmountCents: null,
        installmentCount: 1,
        targets: [],
        decision: {
          kind: "IGNORED_POLICY",
          reason: "INVOICE_PAYMENT",
          policyVersion: 1,
        },
      },
    ]);
    expect(f.draft.lines[3]).toMatchObject({
      amountMeaning: "UNKNOWN",
      amountCents: null,
    });
    const ignoredObservation = await prisma.importObservation.findUniqueOrThrow(
      {
        where: { id: f.observationIds[3] },
      },
    );
    expect(
      (
        JSON.parse(
          ignoredObservation.evidenceJson,
        ) as StoredImportObservationEvidenceV1
      ).amountCents,
    ).toBe(-45_002);
    const artifact = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: f.artifactId },
    });
    if (artifact.extractionJson === null)
      throw new Error("missing immutable extraction");
    expect(
      (
        JSON.parse(artifact.extractionJson) as {
          occurrences: Array<{ amountCents: number | null }>;
        }
      ).occurrences[3]?.amountCents,
    ).toBe(-45_002);

    const ready = await prepareAndConfirm(f);
    const proposal = ready.prepared.proposal;
    if (!proposal) throw new Error("missing proposal");
    const expectedAuditRows = [
      {
        lineId: "ignored-payment",
        outcome: "IGNORED",
        reason: "INVOICE_PAYMENT",
        title: "PAGAMENTO EFETUADO",
        amountCents: -45_002,
      },
    ];
    expect(proposal.noWriteRows).toEqual(expectedAuditRows);
    expect(proposal).toMatchObject({
      createdEconomicTotalCents: 45_002,
      bankCashDeltaCents: 0,
      invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 45_002 }],
      effects: {
        personalSourceCreates: 3,
        reformaTargetCreates: 1,
        expenseCreates: 4,
        cashFlowEntryCreates: 4,
        rateioAllocationCreates: 1,
        keptExistingCount: 0,
        deferredCount: 0,
        excludedCount: 0,
        ignoredCount: 1,
      },
    });

    const receipt = await execute(ready.service, f, ready.financialRequestId);
    expect(receipt.auditItems).toEqual(expectedAuditRows);
    expect(receipt.auditItems).toEqual(proposal.noWriteRows);
    expect(receipt.snapshot).toMatchObject({
      createdEconomicTotalCents: 45_002,
      bankCashDeltaCents: 0,
      invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 45_002 }],
    });
    expect(await reader.getResult(f.auth, f.sessionId)).toEqual({
      state: "APPLIED",
      receipt,
    });

    const rows = await financialRows(f.world.tenantId);
    expect(rows.expenses).toHaveLength(4);
    expect(rows.cfes).toHaveLength(4);
    expect(rows.allocations).toHaveLength(1);
    expect(rows.allocations[0]?.allocation).toBe(25_000);
    expect(rows.settlements).toEqual([]);
    expect(rows.funding).toEqual([]);
    expect(rows.receipts).toEqual([]);
    expect(
      rows.expenses
        .filter((expense) => expense.projectId === f.world.projects.pessoal)
        .reduce((sum, expense) => sum + expense.valorTotal, 0),
    ).toBe(45_002);
    expect(
      await prisma.importObservation.findUniqueOrThrow({
        where: { id: ignoredObservation.id },
      }),
    ).toMatchObject({
      claimVersion: 0,
      canonicalProjectId: null,
      canonicalExpenseId: null,
      canonicalReceiptId: null,
      canonicalIndex: null,
      claimSessionId: null,
      claimReceiptJson: null,
      claimedAt: null,
    });
    expect(
      await prisma.importObservation.count({
        where: {
          id: { in: f.observationIds },
          claimSessionId: f.sessionId,
        },
      }),
    ).toBe(3);

    const replay = await execute(ready.service, f, ready.financialRequestId);
    expect(replay).toEqual(receipt);
    expect(await financialRows(f.world.tenantId)).toEqual(rows);
  });

  it("creates_the_PESSOAL_source_when_targets_is_empty", async () => {
    const f = await fixture(() => [
      {
        id: "only",
        title: "PESSOAL only",
        amountCents: 1,
        installmentCount: 1,
        targets: [],
      },
    ]);
    const ready = await prepareAndConfirm(f);
    const receipt = await execute(ready.service, f, ready.financialRequestId);
    const rows = await financialRows(f.world.tenantId);
    expect(rows.expenses).toHaveLength(1);
    expect(rows.expenses[0]).toMatchObject({
      projectId: f.world.projects.pessoal,
      valorTotal: 1,
      linkedExpenseId: null,
    });
    expect(rows.cfes).toHaveLength(1);
    expect(rows.allocations).toEqual([]);
    expect(receipt.items).toHaveLength(1);
  });

  it("rejects_negative_zero_twenty_five_installments_and_two_targets_before_any_write", () => {
    const line = (overrides: Partial<ImportSessionDraftLineV1> = {}) => ({
      id: "line",
      observationIds: ["observation"],
      titulo: "Compra",
      fornecedor: "Fornecedor",
      tipoDespesa: ExpenseType.OUTROS,
      categoriaMaoDeObra: null,
      amountMeaning: "TOTAL_PURCHASE" as const,
      amountCents: 1,
      installmentCount: 1,
      dataCompra: "2026-09-25",
      firstDueDate: "2026-10-05",
      targets: [],
      decision: { kind: "CREATE" as const, acceptNaturalDuplicate: true },
      ...overrides,
    });
    const draft = (candidate: ImportSessionDraftLineV1) => ({
      version: 1,
      lines: [candidate],
      selectedLineIds: ["line"],
      questions: [],
      scope: { observationIds: ["observation"], pendingAttachmentIds: [] },
    });
    for (const invalid of [
      line({ amountCents: -1 }),
      line({ amountCents: 0 }),
      line({ installmentCount: 0 }),
      line({ installmentCount: 25 }),
      line({
        amountCents: 10,
        targets: [
          { projectId: "r1", roomId: null, amountCents: 5 },
          { projectId: "r2", roomId: null, amountCents: 5 },
        ],
      }),
      line({
        amountCents: 10,
        targets: [{ projectId: "r1", roomId: null, amountCents: 9 }],
      }),
    ])
      expect(() => validateStoredDraft(draft(invalid))).toThrow();

    for (const valid of [
      line({ amountCents: 1, installmentCount: 1, targets: [] }),
      line({ amountCents: 1, installmentCount: 24, targets: [] }),
      line({
        amountCents: 10,
        targets: [{ projectId: "r1", roomId: null, amountCents: 10 }],
      }),
    ])
      expect(() => validateStoredDraft(draft(valid))).not.toThrow();
    expect(
      buildInstallments({
        valorTotal: 10_001,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 3,
        dataInicioParcela: new Date("2026-10-05T00:00:00.000Z"),
      }).map((item) => item.valor),
    ).toEqual([3_333, 3_333, 3_335]);
  });

  it("preserves_KEEP_EXISTING_paid_state_byte_for_byte", async () => {
    const first = await fixture(() => [
      {
        id: "original",
        title: "Compra existente",
        amountCents: 10_001,
        installmentCount: 3,
        targets: [],
      },
    ]);
    const ready = await prepareAndConfirm(first);
    const created = await execute(
      ready.service,
      first,
      ready.financialRequestId,
    );
    const expenseId = created.items[0]!.sourceExpenseId;
    await prisma.expense.update({
      where: { id: expenseId },
      data: { status: "PAGO", paidParcelas: JSON.stringify([1]) },
    });
    await prisma.cashFlowEntry.updateMany({
      where: { expenseId },
      data: { status: "PAGO" },
    });
    const observation = await prisma.importObservation.findUniqueOrThrow({
      where: { id: first.observationIds[0] },
    });
    const secondSession = {
      view: await seedSession(prisma, first.world, {
        ownerUserId: first.world.users.restricted.id,
        cardId: first.world.cards.pessoal,
        revision: 1,
      }),
    };
    const keepDraft = validateStoredDraft({
      version: 1,
      lines: [
        {
          ...first.draft.lines[0]!,
          id: "keep",
          targets: [],
          decision: { kind: "KEEP_EXISTING", expenseId },
        },
      ],
      selectedLineIds: ["keep"],
      questions: [],
      scope: {
        observationIds: [observation.id],
        pendingAttachmentIds: [],
      },
      fieldProvenance: (
        ["decision", "targets", "tipoDespesa"] as const
      ).map((field) => ({
        origin: "USER" as const,
        lineId: "keep",
        field,
        recordedRevision: secondSession.view.revision,
      })),
    });
    await prisma.importSessionArtifact.create({
      data: {
        tenantId: first.world.tenantId,
        ownerProjectId: first.world.projects.pessoal,
        sessionId: secondSession.view.id,
        artifactId: first.artifactId,
        position: 0,
        fileName: "fatura.csv",
        declaredMime: "text/csv",
        declaredBytes: 1,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: FIXED_NOW,
      },
    });
    await prisma.importSession.update({
      where: { id: secondSession.view.id },
      data: { draftJson: JSON.stringify(keepDraft) },
    });
    const second = {
      ...first,
      sessionId: secondSession.view.id,
      revision: secondSession.view.revision,
      draft: keepDraft,
    };
    const before = await financialRows(first.world.tenantId);
    const keptReady = await prepareAndConfirm(second);
    const receipt = await execute(
      keptReady.service,
      second,
      keptReady.financialRequestId,
    );
    expect(await financialRows(first.world.tenantId)).toEqual(before);
    expect(receipt.items).toEqual([
      expect.objectContaining({
        lineId: "keep",
        outcome: "KEPT_EXISTING",
        sourceExpenseId: expenseId,
      }),
    ]);
    expect(
      await prisma.importObservation.findUniqueOrThrow({
        where: { id: observation.id },
      }),
    ).toMatchObject({ canonicalExpenseId: expenseId });
  });

  it("keeps_equal_ordinals_distinct_but_executes_the_same_confirmation_once", async () => {
    const f = await fixture(() => [
      {
        id: "equal-a",
        title: "MESMA COMPRA",
        amountCents: 1_000,
        installmentCount: 1,
        targets: [],
      },
      {
        id: "equal-b",
        title: "MESMA COMPRA",
        amountCents: 1_000,
        installmentCount: 1,
        targets: [],
      },
    ]);
    const ready = await prepareAndConfirm(f);
    const [left, right] = await Promise.all([
      execute(ready.service, f, ready.financialRequestId),
      execute(ready.service, f, ready.financialRequestId),
    ]);
    expect(right).toEqual(left);
    expect(new Set(left.items.map((item) => item.sourceExpenseId)).size).toBe(
      2,
    );
    expect(
      await prisma.expense.count({ where: { tenantId: f.world.tenantId } }),
    ).toBe(2);
    expect(
      await prisma.importSession.count({
        where: { id: f.sessionId, state: "APPLIED" },
      }),
    ).toBe(1);
  });

  it("rejects_a_different_financialRequestId_or_payload_after_confirmation", async () => {
    const f = await fixture();
    const ready = await prepareAndConfirm(f);
    const before = await financialRows(f.world.tenantId);
    await expect(execute(ready.service, f, randomUUID())).rejects.toMatchObject(
      {
        code: "IDEMPOTENCY_CONFLICT",
      },
    );
    expect(await financialRows(f.world.tenantId)).toEqual(before);
  });

  it.each([
    "target-deleted",
    "room-deleted",
    "card-deactivated",
    "project-grant",
    "module-grant",
  ])(
    "rechecks_target_card_project_room_and_grants_inside_the_writer_transaction: %s",
    async (drift) => {
      const f = await fixture();
      let roomId: string | null = null;
      if (drift === "room-deleted") {
        const room = await prisma.room.create({
          data: { projectId: f.reformaId, name: "Cozinha" },
        });
        roomId = room.id;
        const withRoom = structuredClone(f.draft);
        const target = withRoom.lines
          ?.find((line) => line.id === "reforma")
          ?.targets?.at(0);
        if (!target) throw new Error("missing REFORMA target");
        target.roomId = room.id;
        await prisma.importSession.update({
          where: { id: f.sessionId },
          data: { draftJson: JSON.stringify(validateStoredDraft(withRoom)) },
        });
      }
      const ready = await prepareAndConfirm(f);
      if (drift === "target-deleted")
        await prisma.project.delete({ where: { id: f.reformaId } });
      if (drift === "room-deleted")
        await prisma.room.delete({ where: { id: roomId! } });
      if (drift === "card-deactivated")
        await prisma.creditCard.delete({
          where: { id: f.world.cards.pessoal },
        });
      if (drift === "project-grant")
        await prisma.user.update({
          where: { id: f.world.users.restricted.id },
          data: {
            allowedProjects: JSON.stringify([f.world.projects.pessoal]),
          },
        });
      if (drift === "module-grant")
        await prisma.user.update({
          where: { id: f.world.users.restricted.id },
          data: { allowedModules: JSON.stringify(["creditCards"]) },
        });
      const before = await financialRows(f.world.tenantId);
      await expect(
        execute(ready.service, f, ready.financialRequestId),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/REVIEW_REQUIRED|NOT_FOUND|STALE_PREVIEW/),
      });
      expect(await financialRows(f.world.tenantId)).toEqual(before);
      const current = reader.getSession(f.auth, f.sessionId);
      if (drift === "room-deleted")
        await expect(current).resolves.toMatchObject({
          ownerProjectId: f.world.projects.pessoal,
        });
      else await expect(current).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
  );

  it.each(["CashFlowEntry", "UserActivityLog"] as const)(
    "rolls_back_when_the_last_target_CFE_or_final_audit_write_fails: %s",
    async (model) => {
      const f = await fixture((_world, reformaId) => [
        {
          id: "targeted",
          title: "Último CFE no destino",
          amountCents: 25_000,
          installmentCount: 1,
          targets: [
            { projectId: reformaId, roomId: null, amountCents: 25_000 },
          ],
        },
      ]);
      const ready = await prepareAndConfirm(f);
      const before = await financialRows(f.world.tenantId);
      failModel = model;
      if (model === "CashFlowEntry") failCashFlowProjectId = f.reformaId;
      await expect(
        execute(ready.service, f, ready.financialRequestId),
      ).rejects.toThrow(`release-fixture:${model}`);
      expect(failureReached).toBe(true);
      expect(await financialRows(f.world.tenantId)).toEqual(before);
      expect(
        await prisma.importObservation.count({
          where: {
            id: { in: f.observationIds },
            claimSessionId: { not: null },
          },
        }),
      ).toBe(0);
      expect(
        await prisma.importSession.findUniqueOrThrow({
          where: { id: f.sessionId },
        }),
      ).toMatchObject({ state: "CONFIRMED", receiptJson: null });
    },
  );

  it("keeps an all-no-write draft outside the ready-only financial lot", async () => {
    const f = await fixture(() => [
      {
        id: "ignored",
        title: "PAGAMENTO EFETUADO",
        amountCents: 25_000,
        installmentCount: 1,
        targets: [],
        decision: {
          kind: "IGNORED_POLICY",
          reason: "INVOICE_PAYMENT",
          policyVersion: 1,
        },
      },
      {
        id: "excluded",
        title: "Compra excluída",
        amountCents: 10_001,
        installmentCount: 3,
        targets: [],
        decision: { kind: "EXCLUDE" },
      },
    ]);
    const before = await financialRows(f.world.tenantId);
    const prepared = await workflow().prepare(f.auth, f.sessionId, {
      expectedRevision: f.revision,
    });
    expect(prepared).toMatchObject({
      state: "NEEDS_INPUT",
      proposal: null,
      selectedLineIds: [],
    });
    expect(await financialRows(f.world.tenantId)).toEqual(before);
    expect(
      await prisma.importObservation.findUniqueOrThrow({
        where: { id: f.observationIds[0] },
      }),
    ).toMatchObject({
      claimVersion: 0,
      canonicalProjectId: null,
      canonicalExpenseId: null,
      canonicalReceiptId: null,
      canonicalIndex: null,
      claimSessionId: null,
      claimReceiptJson: null,
      claimedAt: null,
    });
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: f.sessionId },
      }),
    ).toMatchObject({ state: "NEEDS_INPUT" });
  });
});
