import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../expense/expense.service";
import { CreditCardService } from "../../credit-card/credit-card.service";
import { MerchantClassifierService } from "../../merchant-classifier/merchant-classifier.service";
import { parseStatement } from "../../credit-card/parsers";
import {
  CARD_PURCHASE_INSPECTION,
  inspectCardPurchaseCompanions,
} from "../../credit-card/card-purchase-identity";
import {
  parseStoredExpenseSchedule,
  toPublicExpenseSchedule,
} from "../../expense/documented-schedule";
import {
  ExpenseStatus,
  ExpenseType,
  PaymentForm,
  ProjectType,
  type ExpenseScheduleV1,
  encodeImportDeclaration,
} from "@reformaflow/domain";
import type { RateioRequester } from "../../expense/rateio.types";
import { inspectCardImportInTx } from "./card-import-identity";
import { DefaultImportSessionCapability } from "./import-session.capability";
import {
  documentaryAnswerScope,
  parseDocumentaryAnswerRequest,
} from "./import-session.native-answer";
import { MonthlyOverviewService } from "../../monthly-overview/monthly-overview.service";
import { CardInvoiceSettlementService } from "../../credit-card/card-invoice-settlement.service";
import { TenantFinancialService } from "../../tenant-financial/tenant-financial.service";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import { ImportUiGuard } from "./import-session-ui.guard";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";

const UNOWNED_CARD_PAYMENT_FORM = "CARTAO_CREDITO";
/** Run against the guarded worktree DB, using main's real services and middleware. */
describe("Maria on current main compatibility (#711 / #714)", () => {
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const cards = new CreditCardService(
    prisma,
    conciliacao,
    new MerchantClassifierService(prisma),
  );
  let tenantId: string;
  let projectId: string;
  let cardId: string;
  let actor: RateioRequester & { id: string };
  const schedule: ExpenseScheduleV1 = {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: "2/4",
        valor: 101,
        data: "2026-10-20",
        invoiceDueMonth: "2026-10",
      },
      {
        index: 1,
        parcela: "3/4",
        valor: 207,
        data: "2026-12-03",
        invoiceDueMonth: "2026-12",
      },
      {
        index: 2,
        parcela: "4/4",
        valor: 301,
        data: "2027-04-29",
        invoiceDueMonth: "2027-05",
      },
    ],
  };
  const input = () => ({
    cardId,
    titulo: "Documented compatibility purchase",
    fornecedor: null,
    categoriaMaoDeObra: null,
    tipoDespesa: ExpenseType.OUTROS,
    dataCompra: "2026-09-01",
    totalCents: 609,
    schedule,
    evidence: { documentSha256: "a".repeat(64), reference: "csv:row:2" },
    reason: "Explicit documentary confirmation",
  });
  const create = () =>
    prisma.$transaction((tx) =>
      expenses.createPlannedCardPurchaseInTx(
        tx,
        tenantId,
        projectId,
        input(),
        actor.id,
        actor,
      ),
    );
  const identity = () => ({
    cardId,
    projectId,
    merchant: "Compatibility legacy purchase",
    total: 1,
    seriesKey: null,
    externalId: null,
    dedupeKeyStrong: null,
  });
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    await prisma.$connect();
  });
  beforeEach(async () => {
    tenantId = (
      await prisma.tenant.create({
        data: { name: "Main compatibility fixture" },
      })
    ).id;
    actor = {
      ...(await prisma.user.create({
        data: {
          tenantId,
          username: randomUUID(),
          name: "Fixture",
          role: "ADMIN",
        },
      })),
      allowedProjects: [],
      allowedProjectTypes: [],
      allowedModules: [],
    };
    projectId = (
      await prisma.project.create({
        data: {
          tenantId,
          name: "Compatibility PESSOAL",
          type: ProjectType.PESSOAL,
        },
      })
    ).id;
    cardId = (
      await prisma.creditCard.create({
        data: {
          tenantId,
          projectId,
          nickname: "Fixture",
          institution: "Fixture",
          last4: "1234",
          closingDay: 5,
          dueDay: 10,
        },
      })
    ).id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("maria_create_preserves_main_documented_schedule", async () => {
    const source = await create();
    expect(source.valorTotal).toBe(609);
    expect(
      toPublicExpenseSchedule(
        parseStoredExpenseSchedule(source.documentedSchedule),
      ),
    ).toEqual(schedule);
    const rows = await prisma.cashFlowEntry.findMany({
      where: { tenantId, expenseId: source.id, deletedAt: null },
      orderBy: { data: "asc" },
    });
    expect(
      rows.map(({ parcela, valor, data, invoiceDueMonth }) => ({
        parcela,
        valor,
        data: data.toISOString().slice(0, 10),
        invoiceDueMonth,
      })),
    ).toEqual(
      schedule.occurrences.map(
        ({ index: _index, ...occurrence }) => occurrence,
      ),
    );
  });

  it("maria_creation_uses_caller_transaction_atomically", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await expenses.createPlannedCardPurchaseInTx(
          tx,
          tenantId,
          projectId,
          input(),
          actor.id,
          actor,
        );
        throw new Error("Later workflow phase failed");
      }),
    ).rejects.toThrow("Later workflow phase failed");
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.rateioAllocation.count({ where: { tenantId } })).toBe(
      0,
    );
    expect(
      await prisma.importObservation.count({
        where: { tenantId, canonicalExpenseId: { not: null } },
      }),
    ).toBe(0);
  });

  it("legacy_card_import_keeps_documentary_cycle_and_transactional_dedupe", async () => {
    const csv =
      "date,title,amount\n2026-08-14,Compatibility legacy purchase,1.01\n";
    const parsed = parseStatement(csv, cardId, "CSV_GENERIC", "fixture.csv");
    const commit = () =>
      cards.commitImport(
        tenantId,
        projectId,
        cardId,
        csv,
        "fixture.csv",
        "CSV_GENERIC",
        undefined,
        undefined,
        parsed.transactions.map(({ externalId }) => ({
          externalId,
          action: "create",
          overrides: {
            documentaryCycle: {
              invoiceDueMonth: "2026-11",
              evidence: {
                documentSha256: "b".repeat(64),
                reference: "csv:row:2",
              },
            },
          },
        })),
        actor.id,
        actor,
      );
    const results = await Promise.all([commit(), commit()]);
    expect(results.reduce((sum, row) => sum + row.inserted, 0)).toBe(1);
    const rows = await prisma.cashFlowEntry.findMany({
      where: { tenantId, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      valor: 101,
      invoiceDueMonth: "2026-11",
      data: new Date("2026-08-14"),
    });
  });

  it("restore_inspection_remains_supported_after_maria_registration", async () => {
    await expect(
      prisma.$transaction((tx) =>
        inspectCardPurchaseCompanions(
          tx,
          tenantId,
          identity(),
          CARD_PURCHASE_INSPECTION.RESTORE,
        ),
      ),
    ).resolves.toMatchObject({ companions: [], receipts: [], unowned: [] });
    await prisma.cashFlowEntry.create({
      data: {
        tenantId,
        projectId,
        tipo: "DESPESA",
        categoria: "Fixture",
        valor: 101,
        data: new Date("2026-08-14"),
        formaPagamento: UNOWNED_CARD_PAYMENT_FORM,
        status: ExpenseStatus.PLANEJADO,
      },
    });
    await expect(
      prisma.$transaction((tx) =>
        inspectCardPurchaseCompanions(
          tx,
          tenantId,
          identity(),
          CARD_PURCHASE_INSPECTION.RESTORE,
        ),
      ),
    ).rejects.toThrow();
  });

  it("maria_identity_helpers_do_not_replace_legacy_identity_api", async () => {
    expect(inspectCardImportInTx).not.toBe(inspectCardPurchaseCompanions);
    for (const intent of [
      CARD_PURCHASE_INSPECTION.IMPORT,
      CARD_PURCHASE_INSPECTION.RESTORE,
    ]) {
      await expect(
        prisma.$transaction((tx) =>
          inspectCardPurchaseCompanions(tx, tenantId, identity(), intent),
        ),
      ).resolves.toMatchObject({ companions: [], receipts: [] });
    }
  });

  it("empty_targets_and_cross_project_mirror_keep_main_cash_semantics", async () => {
    const source = await create();
    expect(await prisma.rateioAllocation.count({ where: { tenantId } })).toBe(
      0,
    );
    expect(source).toMatchObject({
      accountId: null,
      bankLast4: null,
      status: ExpenseStatus.PLANEJADO,
    });
    // Planned card-only intake must never change main's realized bank cash.
    const monthly = new MonthlyOverviewService(
      prisma,
      new CardInvoiceSettlementService(prisma),
    );
    expect((await monthly.getCaixaConta(tenantId, projectId)).hoje).toBe(0);
    const targetProject = await prisma.project.create({
      data: {
        tenantId,
        name: "Compatibility REFORMA",
        type: ProjectType.REFORMA,
      },
    });
    const target = await expenses.create(
      tenantId,
      targetProject.id,
      {
        tipoDespesa: ExpenseType.OUTROS,
        valor: 6.09,
        quantidade: 1,
        formaPagamento: PaymentForm.A_VISTA,
        dataPagamento: "2026-10-20",
        status: ExpenseStatus.PLANEJADO,
      },
      actor.id,
      undefined,
      actor,
    );
    await prisma.$transaction((tx) =>
      conciliacao.ratearSource(
        tx,
        {
          tenantId,
          sourceExpenseId: source.id,
          allocations: [{ targetExpenseId: target.id, allocation: 609 }],
        },
        actor,
      ),
    );
    const targetRows = await prisma.cashFlowEntry.findMany({
      where: { tenantId, expenseId: target.id, deletedAt: null },
      orderBy: { data: "asc" },
    });
    expect(targetRows.map((row) => row.valor)).toEqual([101, 207, 301]);
    const personalRows = await prisma.cashFlowEntry.findMany({
      where: { tenantId, projectId, deletedAt: null },
    });
    expect(personalRows.reduce((sum, row) => sum + row.valor, 0)).toBe(609);
    const consolidated = await new TenantFinancialService(
      prisma,
      monthly,
    ).getCashFlow(tenantId, 12, null);
    expect(consolidated.reduce((sum, month) => sum + month.planejado, 0)).toBe(
      609,
    );
    expect((await monthly.getCaixaConta(tenantId, projectId)).hoje).toBe(0);
    expect(await prisma.receipt.count({ where: { tenantId } })).toBe(0);
  });

  it("native_answers_and_scoped_pdf_qualification_survive_main_integration", () => {
    const capability = new DefaultImportSessionCapability();
    expect(capability.writesEnabled()).toBe(false);
    expect(capability.newImportFormats()).toEqual(["CSV", "PDF"]);
    // Native controls reject malformed revisions before any conversational/LLM bridge.
    expect(() =>
      parseDocumentaryAnswerRequest({
        version: 1,
        expectedRevision: -1,
        answerRequestId: "invalid",
      }),
    ).toThrow();
    const now = new Date("2026-10-10T12:00:00.000Z");
    const request = {
      headers: { origin: "http://localhost:3000", "x-rf-import-ui": "1" },
      user: {
        id: actor.id,
        tenantId,
        authClaims: {
          sessionVersion: 0,
          expiresAtEpochSeconds: now.getTime() / 1000 + 86400,
        },
      },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    new ImportAuthGuard().canActivate(context);
    const auth = readImportAuthForRequest(request);
    const issuer = new ImportUiGrantIssuer({ now: () => now });
    new ImportUiGuard(
      { allowed: () => ["http://localhost:3000"] },
      issuer,
    ).canActivate(context);
    const input = { kind: "VALUE", text: "Explicit merchant" } as const;
    const encoded = encodeImportDeclaration(
      {
        field: "merchant",
        meaningContext: null,
        effectiveInstallmentCount: null,
      },
      input,
    );
    if (encoded.kind !== "ENCODED")
      throw new Error("Invalid compatibility fixture");
    // Explicit controls normalize locally: no model provider or chat bridge participates.
    const answer = parseDocumentaryAnswerRequest({
      version: 1,
      answerRequestId: randomUUID(),
      expectedRevision: 1,
      questionId: `oq_${"c".repeat(64)}`,
      channel: "TEXT",
      input,
      answer: encoded.answer,
    });
    const sessionId = randomUUID();
    const scope = documentaryAnswerScope(sessionId, answer);
    const grant = issuer.issue(request, auth, scope);
    const verifier = new RuntimeUiGrantVerifier();
    expect(() =>
      verifier.verify(grant, auth, { ...scope, expectedRevision: 2 }, now),
    ).toThrow();
    // A native answer grant cannot confirm financial writes.
    expect(() =>
      verifier.verifyFinancialAction(
        grant,
        auth,
        {
          operation: "EXECUTE",
          sessionId,
          financialRequestId: randomUUID(),
        },
        now,
      ),
    ).toThrow();
    expect(verifier.verify(grant, auth, scope, now)).toBe(grant);
    expect(() => verifier.verify(grant, auth, scope, now)).toThrow();
  });
});
