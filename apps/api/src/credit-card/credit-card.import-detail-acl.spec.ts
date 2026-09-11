// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { CreditCardService } from "./credit-card.service";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { RateioRequester } from "../expense/rateio.types";

/**
 * Achado #3 (security-tenant-lens SEC-1) — `CreditCardService.getImportDetail`
 * não recebia `requester` nem filtrava nada, ao contrário do
 * `BankAccountService.getImportDetail` já endurecido nesta PR. Um requester
 * SEM visibilidade do projeto ALVO de um rateio/vínculo cross-project ainda
 * conseguia enxergar a contagem `impact.crossProjectSettlements`/
 * `rateioAllocations`/`crossProjectLinks` cheia — vazamento cross-tenant/
 * cross-project por diferença de contagem.
 */

const setupPrisma = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "cc-detail-acl-tenant";
const PESSOAL = "cc-detail-acl-pessoal";
const HIDDEN = "cc-detail-acl-hidden";
const NOW = new Date("2026-08-18T12:00:00.000Z");

const RESTRICTED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses", "creditCards"],
};
const FULL: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, HIDDEN],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses", "creditCards"],
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
  await setupPrisma.rateioAllocation.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.crossProjectSettlement.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.creditCardStatementImport.deleteMany({ where: { tenantId: TENANT } });
}

describe("CreditCardService.getImportDetail — ACL (achado #3)", () => {
  let service: CreditCardService;
  let cardId: string;

  beforeAll(async () => {
    await setupPrisma.$connect();
    await prisma.onModuleInit();
    await cleanupTransient();
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });

    await setupPrisma.tenant.create({ data: { id: TENANT, name: "Credit card import detail ACL" } });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
        { id: HIDDEN, tenantId: TENANT, type: "REFORMA", name: "Oculto" },
      ],
    });
    const card = await setupPrisma.creditCard.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Cartão detail-acl",
        last4: "7722",
      },
    });
    cardId = card.id;
    service = new CreditCardService(prisma, new ConciliacaoService(prisma), new MerchantClassifierService(prisma));
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupTransient();
    await setupPrisma.creditCard.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
    await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.onModuleDestroy();
    await setupPrisma.$disconnect();
  });

  it("exige requester (rejeita chamada sem requester)", async () => {
    await expect((service as any).getImportDetail(TENANT, PESSOAL, cardId, "any-import")).rejects.toThrow();
  });

  it("requester sem visibilidade do projeto alvo do rateio NUNCA vê a contagem real (nem por diferença)", async () => {
    const importRow = await setupPrisma.creditCardStatementImport.create({
      data: { tenantId: TENANT, cardId, periodLabel: "2026-08", source: "CSV_ITAU", inserted: 1, totalAmountCents: 10_000 },
    });
    const hiddenTarget = await setupPrisma.expense.create({
      data: { ...expenseData(HIDDEN, "Alvo oculto", 10_000), status: "PLANEJADO" },
    });
    const source = await setupPrisma.expense.create({
      data: {
        ...expenseData(PESSOAL, "Fonte importada", 10_000),
        importId: importRow.id,
        cardLast4: "7722",
        origin: "import",
        linkedExpenseId: hiddenTarget.id,
      },
    });
    await setupPrisma.rateioAllocation.create({
      data: {
        tenantId: TENANT,
        sourceExpenseId: source.id,
        targetExpenseId: hiddenTarget.id,
        allocation: 10_000,
        plannedStatus: "PLANEJADO",
        plannedValor: 10_000,
        plannedQuantidade: 1,
        plannedValorTotal: 10_000,
        plannedForma: "A_VISTA",
        plannedDataPagamento: NOW,
      },
    });

    const fullDetail: any = await (service as any).getImportDetail(TENANT, PESSOAL, cardId, importRow.id, FULL);
    const restrictedDetail: any = await (service as any).getImportDetail(TENANT, PESSOAL, cardId, importRow.id, RESTRICTED);

    expect(fullDetail.impact.rateioAllocations).toBe(1);
    expect(fullDetail.impact.crossProjectLinks).toBeGreaterThanOrEqual(1);

    // O requester restrito nunca pode ver a contagem real do vínculo oculto.
    expect(restrictedDetail.impact.rateioAllocations).toBe(0);
    expect(restrictedDetail.impact.crossProjectSettlements).toBe(0);
    expect(restrictedDetail.impact.crossProjectLinks).toBe(0);
  });
});
