// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { HttpException } from "@nestjs/common";
import { ConciliacaoService } from "./conciliacao.service";
import { RateioRequester } from "../expense/rateio.types";
import { PrismaService } from "../prisma/prisma.service";

const setupPrisma = new PrismaClient();

const TENANT = "rateio-reversal-race-tenant";
const PESSOAL = "rateio-reversal-race-pessoal";
const HIDDEN = "rateio-reversal-race-hidden";
const NOW = new Date("2026-08-18T12:00:00.000Z");

const MANAGED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL],
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["expenses"],
};
const ADMIN: RateioRequester = {
  role: "ADMIN",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

async function cleanup() {
  await setupPrisma.rateioAllocation.deleteMany({
    where: { tenantId: TENANT },
  });
  await setupPrisma.crossProjectSettlement.deleteMany({
    where: { tenantId: TENANT },
  });
  await setupPrisma.cashFlowEntry.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.expense.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.project.deleteMany({ where: { tenantId: TENANT } });
  await setupPrisma.tenant.deleteMany({ where: { id: TENANT } });
}

function isSqliteBusy(reason: unknown): boolean {
  const error = reason as { code?: string; message?: string; meta?: unknown };
  const text = `${error?.code ?? ""} ${error?.message ?? ""} ${JSON.stringify(error?.meta ?? "")}`;
  return /SQLITE_BUSY|database is locked|code.?5\b/i.test(text);
}

function isAclRejection(reason: unknown): boolean {
  return (
    reason instanceof HttpException && [400, 404].includes(reason.getStatus())
  );
}

describe("ConciliacaoService.reverseSourceLinks — corrida real SQLite", () => {
  beforeAll(async () => {
    await setupPrisma.$connect();
    await cleanup();
    await setupPrisma.tenant.create({
      data: { id: TENANT, name: "Rateio reversal race" },
    });
    await setupPrisma.project.createMany({
      data: [
        { id: PESSOAL, tenantId: TENANT, type: "PESSOAL", name: "Pessoal" },
        { id: HIDDEN, tenantId: TENANT, type: "REFORMA", name: "Oculto" },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await setupPrisma.$disconnect();
  });

  it("requester sem ACL nunca vence; o estado final é integralmente rateado ou integralmente revertido", async () => {
    const target = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: HIDDEN,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        titulo: "Alvo oculto",
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: "A_VISTA",
        dataPagamento: NOW,
        status: "PAGO",
      },
    });
    const source = await setupPrisma.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PESSOAL,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        titulo: "Fonte",
        valor: 10_000,
        quantidade: 1,
        valorTotal: 10_000,
        formaPagamento: "A_VISTA",
        dataPagamento: NOW,
        status: "PAGO",
        linkedExpenseId: target.id,
      },
    });
    await setupPrisma.rateioAllocation.create({
      data: {
        tenantId: TENANT,
        sourceExpenseId: source.id,
        targetExpenseId: target.id,
        allocation: 10_000,
        plannedStatus: "PLANEJADO",
        plannedPaid: null,
        plannedValor: 7_000,
        plannedQuantidade: 1,
        plannedValorTotal: 7_000,
        plannedForma: "A_VISTA",
        plannedQtdParcela: null,
        plannedDataInicio: null,
        plannedDataPagamento: NOW,
        plannedInstallmentDateOverrides: null,
      },
    });

    const clientA = new PrismaClient();
    const clientB = new PrismaClient();
    await clientA.$connect();
    await clientB.$connect();
    try {
      const managedService = new ConciliacaoService(
        clientA as unknown as PrismaService,
      );
      const adminService = new ConciliacaoService(
        clientB as unknown as PrismaService,
      );
      const params = { tenantId: TENANT, sourceExpenseId: source.id };

      const [managedResult, adminResult] = await Promise.allSettled([
        clientA.$transaction((tx) =>
          (managedService as any).reverseSourceLinks(tx, params, MANAGED),
        ),
        clientB.$transaction((tx) =>
          (adminService as any).reverseSourceLinks(tx, params, ADMIN),
        ),
      ]);

      if (managedResult.status === "rejected") {
        expect(
          isAclRejection(managedResult.reason) ||
            isSqliteBusy(managedResult.reason),
        ).toBe(true);
      } else {
        // Linearização válida: o ADMIN pode concluir primeiro. Nesse caso não
        // resta participante oculto para o requester reverter, e a segunda
        // chamada só pode cumprir um no-op explícito — nunca alegar que rateou.
        expect(managedResult.value).toEqual({ mode: "none", targets: [] });
        expect(adminResult.status).toBe("fulfilled");
      }
      if (adminResult.status === "rejected") {
        expect(isSqliteBusy(adminResult.reason)).toBe(true);
      }

      const [allocationCount, storedSource, storedTarget] = await Promise.all([
        setupPrisma.rateioAllocation.count({
          where: { tenantId: TENANT, sourceExpenseId: source.id },
        }),
        setupPrisma.expense.findUnique({ where: { id: source.id } }),
        setupPrisma.expense.findUnique({ where: { id: target.id } }),
      ]);

      const fullyRated =
        allocationCount === 1 &&
        storedSource?.linkedExpenseId === target.id &&
        storedTarget?.status === "PAGO" &&
        storedTarget.valorTotal === 10_000;
      const fullyReversed =
        allocationCount === 0 &&
        storedSource?.linkedExpenseId === null &&
        storedTarget?.status === "PLANEJADO" &&
        storedTarget.valorTotal === 7_000;
      expect(fullyRated || fullyReversed).toBe(true);
      expect(Number(fullyRated) + Number(fullyReversed)).toBe(1);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
  }, 20_000);
});
