// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { BankAccountController } from "./bank-account.controller";
import { BankAccountService } from "./bank-account.service";
import { CardInvoiceSettlementService } from "../credit-card/card-invoice-settlement.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { RateioRequester } from "../expense/rateio.types";

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "bank-undo-acl-tenant";
const PESSOAL = "bank-undo-acl-pessoal";
const ALLOWED = "bank-undo-acl-allowed";
const HIDDEN = "bank-undo-acl-hidden";
const NOW = new Date("2026-08-18T12:00:00.000Z");

const MANAGED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses"],
};

function expenseData(projectId: string, title: string, value: number) {
  return {
    tenantId: TENANT,
    projectId,
    tipoDespesa: "MATERIAL_CONSTRUCAO",
    titulo: title,
    valor: value,
    quantidade: 1,
    valorTotal: value,
    formaPagamento: "A_VISTA",
    dataPagamento: NOW,
    status: "PLANEJADO",
  };
}

async function cleanupTransient() {
  await setupPrisma.rateioAllocation.deleteMany({
    where: { tenantId: TENANT },
  });
  await setupPrisma.crossProjectSettlement.deleteMany({
    where: { tenantId: TENANT },
  });
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.receipt.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.bankStatementImport.deleteMany({
    where: { tenantId: TENANT },
  });
}

describe("BankAccountService.undoImport — ACL dos filhos do lote", () => {
  let service: BankAccountService;
  let accountId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupTransient();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });

    await setupPrisma.tenant.create({
      data: { id: TENANT, name: "Bank undo ACL" },
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
        { id: ALLOWED, tenantId: TENANT, type: "REFORMA", name: "Permitido" },
        { id: HIDDEN, tenantId: TENANT, type: "REFORMA", name: "Oculto" },
      ],
    });
    const account = await setupPrisma.bankAccount.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        nickname: "Conta ACL",
        last4: "1881",
      },
    });
    accountId = account.id;
    service = new BankAccountService(
      prisma,
      new MerchantClassifierService(prisma),
      new ConciliacaoService(prisma),
      new CardInvoiceSettlementService(prisma),
    );
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupTransient();
    await setupPrisma.bankAccount.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it("um target hidden bloqueia o lote inteiro e preserva todas as linhas", async () => {
    const importRow = await setupPrisma.bankStatementImport.create({
      data: {
        tenantId: TENANT,
        accountId,
        periodLabel: "2026-08",
        source: "OFX",
        inserted: 2,
        totalAmountCents: 20_000,
      },
    });
    const [allowedTarget, hiddenTarget] = await Promise.all([
      setupPrisma.expense.create({
        data: {
          ...expenseData(ALLOWED, "Alvo permitido", 10_000),
          status: "PAGO",
        },
      }),
      setupPrisma.expense.create({
        data: { ...expenseData(HIDDEN, "Alvo oculto", 10_000), status: "PAGO" },
      }),
    ]);
    const [allowedSource, hiddenSource] = await Promise.all([
      setupPrisma.expense.create({
        data: {
          ...expenseData(PESSOAL, "Fonte permitida", 10_000),
          importId: importRow.id,
          accountId,
          bankLast4: "1881",
          origin: "import",
          linkedExpenseId: allowedTarget.id,
        },
      }),
      setupPrisma.expense.create({
        data: {
          ...expenseData(PESSOAL, "Fonte oculta", 10_000),
          importId: importRow.id,
          accountId,
          bankLast4: "1881",
          origin: "import",
          linkedExpenseId: hiddenTarget.id,
        },
      }),
    ]);
    await setupPrisma.rateioAllocation.createMany({
      data: [
        {
          tenantId: TENANT,
          sourceExpenseId: allowedSource.id,
          targetExpenseId: allowedTarget.id,
          allocation: 10_000,
          plannedStatus: "PLANEJADO",
          plannedValor: 7_000,
          plannedQuantidade: 1,
          plannedValorTotal: 7_000,
          plannedForma: "A_VISTA",
          plannedDataPagamento: NOW,
        },
        {
          tenantId: TENANT,
          sourceExpenseId: hiddenSource.id,
          targetExpenseId: hiddenTarget.id,
          allocation: 10_000,
          plannedStatus: "PLANEJADO",
          plannedValor: 8_000,
          plannedQuantidade: 1,
          plannedValorTotal: 8_000,
          plannedForma: "A_VISTA",
          plannedDataPagamento: NOW,
        },
      ],
    });

    const [outcome] = await Promise.allSettled([
      (service as any).undoImport(
        TENANT,
        PESSOAL,
        accountId,
        importRow.id,
        MANAGED,
      ),
    ]);

    const [storedImport, sources, targets, allocations] = await Promise.all([
      setupPrisma.bankStatementImport.findUnique({
        where: { id: importRow.id },
      }),
      setupPrisma.expense.findMany({
        where: { id: { in: [allowedSource.id, hiddenSource.id] } },
        orderBy: { titulo: "asc" },
      }),
      setupPrisma.expense.findMany({
        where: { id: { in: [allowedTarget.id, hiddenTarget.id] } },
        orderBy: { titulo: "asc" },
      }),
      setupPrisma.rateioAllocation.findMany({
        where: { sourceExpenseId: { in: [allowedSource.id, hiddenSource.id] } },
        orderBy: { targetExpenseId: "asc" },
      }),
    ]);
    expect({
      importDeletedAt: storedImport?.deletedAt,
      sourceCount: sources.length,
      sourceDeletedAt: sources.map((row) => row.deletedAt),
      sourceLinks: new Set(sources.map((row) => row.linkedExpenseId)),
      targetState: targets.map((row) => ({
        status: row.status,
        valorTotal: row.valorTotal,
      })),
      allocationCount: allocations.length,
    }).toEqual({
      importDeletedAt: null,
      sourceCount: 2,
      sourceDeletedAt: [null, null],
      sourceLinks: new Set([allowedTarget.id, hiddenTarget.id]),
      targetState: [
        { status: "PAGO", valorTotal: 10_000 },
        { status: "PAGO", valorTotal: 10_000 },
      ],
      allocationCount: 2,
    });
    expect(outcome.status).toBe("rejected");
  });

  it("controller encaminha a lente do requester ao service", async () => {
    const undoImport = jest.fn().mockResolvedValue({ ok: true });
    const controller = new BankAccountController({ undoImport } as any);

    await (controller as any).undoImport(
      TENANT,
      PESSOAL,
      "account",
      "import",
      MANAGED,
    );

    expect(undoImport).toHaveBeenCalledWith(
      TENANT,
      PESSOAL,
      "account",
      "import",
      MANAGED,
    );
  });
});
