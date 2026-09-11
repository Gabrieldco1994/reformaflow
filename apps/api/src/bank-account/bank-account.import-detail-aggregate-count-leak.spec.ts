// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { RateioRequester } from "../expense/rateio.types";
import {
  makeBankAccountService,
  resetTenant,
  seedPessoal,
  seedProject,
  seedBankAccount,
} from "./__tests__/invoice-undo.fixtures";
import { BankAccountService } from "./bank-account.service";

/**
 * Achado #2 (security-tenant-lens, SEC-2) — as contagens agregadas
 * `impact.crossProjectSettlements`/`rateioAllocations`/`crossProjectLinks` e
 * `blocking.cardInvoicePayments` eram computadas sobre TODOS os itens do lote,
 * sem respeitar a ocultação de visibilidade já aplicada ao `settlement[]`. Um
 * requester sem visibilidade para o projeto ALVO/pagamento ainda conseguia
 * INFERIR a existência da entrada oculta comparando essas contagens com o
 * tamanho de `settlement[]`/o que ele mesmo enxerga.
 *
 * Repro: mesmo lote de importação, dois requesters com visibilidade diferente
 * — um enxerga PESSOAL+REFORMA (ADMIN), outro só PESSOAL. Um vínculo
 * cross-project aponta para uma despesa planejada em REFORMA (invisível ao
 * requester restrito). A contagem agregada NUNCA pode revelar a existência do
 * item oculto: o requester restrito precisa ver `crossProjectSettlements: 0`.
 */
describe("BankAccountService#getImportDetail — contagens agregadas não vazam por diferença de visibilidade (#4)", () => {
  const setupPrisma = new PrismaClient();
  const prisma = new PrismaService();
  let service: BankAccountService;

  const TENANT = "bank-569-agg-leak-tenant";
  const PESSOAL = "bank-569-agg-leak-pessoal";
  const REFORMA = "bank-569-agg-leak-reforma";
  const BANK_LAST4 = "3344";

  const FULL_REQUESTER: RateioRequester = {
    role: "USER",
    allowedProjects: [PESSOAL, REFORMA],
    allowedProjectTypes: ["PESSOAL", "REFORMA"],
    allowedModules: ["expenses", "creditCards", "bankAccounts"],
  };
  const RESTRICTED_REQUESTER: RateioRequester = {
    role: "USER",
    allowedProjects: [PESSOAL],
    allowedProjectTypes: ["PESSOAL"],
    allowedModules: ["expenses", "creditCards", "bankAccounts"],
  };

  let accountId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await resetTenant(setupPrisma, TENANT);
    await seedPessoal(setupPrisma, { tenantId: TENANT, projectId: PESSOAL });
    await seedProject(setupPrisma, { tenantId: TENANT, projectId: REFORMA, type: "REFORMA", name: "Reforma" });
    const account = await seedBankAccount(setupPrisma, { tenantId: TENANT, projectId: PESSOAL, last4: BANK_LAST4 });
    accountId = account.id;
    service = makeBankAccountService(prisma);
  });

  afterEach(async () => {
    await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.bankStatementImport.deleteMany({ where: { tenantId: TENANT } });
  });

  afterAll(async () => {
    await resetTenant(setupPrisma, TENANT);
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it("requester sem visibilidade do projeto alvo vê crossProjectSettlements/crossProjectLinks == 0, nunca a contagem real", async () => {
    const importRecord = await setupPrisma.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: "2026-06", source: "OFX", inserted: 1, totalAmountCents: 50_000 },
    });
    const sourceExpense = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "OUTROS",
        titulo: "Compra importada (fonte do vínculo)",
        valor: 50_000,
        quantidade: 1,
        valorTotal: 50_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-10T12:00:00.000Z"),
        status: "PAGO",
        bankLast4: BANK_LAST4,
        importId: importRecord.id,
      },
    });
    // Despesa ALVO planejada em REFORMA — invisível ao requester restrito.
    const targetExpense = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: REFORMA,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        titulo: "Material planejado (alvo do vínculo)",
        valor: 50_000,
        quantidade: 1,
        valorTotal: 50_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-06-10T12:00:00.000Z"),
        status: "PLANEJADO",
      },
    });
    await setupPrisma.crossProjectSettlement.create({
      data: {
        tenantId: TENANT,
        sourceExpenseId: sourceExpense.id,
        targetExpenseId: targetExpense.id,
        parcelaIndex: 0,
        realValor: 50_000,
        plannedValor: 50_000,
        plannedStatus: "PLANEJADO",
      },
    });

    const fullView: any = await service.getImportDetail(TENANT, PESSOAL, accountId, importRecord.id, FULL_REQUESTER as never);
    const restrictedView: any = await service.getImportDetail(TENANT, PESSOAL, accountId, importRecord.id, RESTRICTED_REQUESTER as never);

    // Quem enxerga REFORMA vê o vínculo real.
    expect(fullView.impact.crossProjectSettlements).toBe(1);
    expect(fullView.impact.crossProjectLinks).toBeGreaterThanOrEqual(1);

    // Quem NÃO enxerga REFORMA nunca pode ver a contagem real — nem por
    // diferença: a contagem exposta tem que ser 0, igual a "não existe".
    expect(restrictedView.impact.crossProjectSettlements).toBe(0);
    expect(restrictedView.impact.rateioAllocations).toBe(0);
    expect(restrictedView.impact.crossProjectLinks).toBe(0);
  });

  it("requester sem visibilidade do projeto do pagamento de fatura vê blocking.cardInvoicePayments == 0", async () => {
    const importRecord = await setupPrisma.bankStatementImport.create({
      data: { tenantId: TENANT, accountId, periodLabel: "2026-07", source: "OFX", inserted: 1, totalAmountCents: 30_000 },
    });
    // Pagamento de fatura carimbado, mas em projeto INVISÍVEL ao requester
    // restrito (mesmo tenantId+importId — a varredura de `cardInvoicePayments`
    // não filtra por `projectId`).
    await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: REFORMA,
        tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
        titulo: "Pagamento fatura em outro projeto",
        valor: 30_000,
        quantidade: 1,
        valorTotal: 30_000,
        formaPagamento: "A_VISTA",
        dataPagamento: new Date("2026-07-10T12:00:00.000Z"),
        status: "PAGO",
        bankLast4: BANK_LAST4,
        importId: importRecord.id,
        invoiceUndoState: "PROCESSED_NONE",
        invoiceUndoParcelaCount: 0,
        invoiceUndoTrailVersion: 1,
      },
    });

    const fullView: any = await service.getImportDetail(TENANT, PESSOAL, accountId, importRecord.id, FULL_REQUESTER as never);
    const restrictedView: any = await service.getImportDetail(TENANT, PESSOAL, accountId, importRecord.id, RESTRICTED_REQUESTER as never);

    expect(fullView.blocking.cardInvoicePayments).toBe(1);
    expect(restrictedView.blocking.cardInvoicePayments).toBe(0);
    expect(restrictedView.impact.invoiceLiquidations).toBe(0);
  });
});
