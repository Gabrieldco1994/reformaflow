/**
 * SEC-3 RED (#478): `parcela-data` propagates writes to linked/rateio children,
 * so every active child must be authorized before the source is changed.
 * This spec uses the disposable real SQLite database rather than an ACL mock.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { PrismaService } from "../prisma/prisma.service";
import { ExpenseService } from "./expense.service";
import type { RateioRequester } from "./rateio.types";

const setup = new PrismaClient();
const prisma = new PrismaService();

const TENANT = "iidacl-tenant";
const OTHER_TENANT = "iidacl-other-tenant";
const PESSOAL = "iidacl-pessoal";
const ALLOWED = "iidacl-allowed";
const HIDDEN = "iidacl-hidden";
const OTHER_PROJECT = "iidacl-other-project";
const SOURCE = "iidacl-source";
const ALLOWED_TARGET = "iidacl-allowed-target";
const HIDDEN_TARGET = "iidacl-hidden-target";
const OTHER_TARGET = "iidacl-other-target";
const MISSING_TARGET = "iidacl-missing-target";
const UPDATE_GUARD_TRIGGER = "iidacl_reject_source_update";
const START = new Date("2026-08-10T12:00:00.000Z");
const DELETED_AT = new Date("2026-08-19T12:00:00.000Z");
const OVERRIDE_DATE = "2026-09-20";

const MANAGED: RateioRequester = {
  role: "USER",
  allowedProjects: [PESSOAL, ALLOWED],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses"],
};
const OWNER: RateioRequester = {
  role: "OWNER",
  allowedProjects: [],
  allowedProjectTypes: [],
  allowedModules: [],
};

type InstallmentDateService = Omit<ExpenseService, "updateInstallmentDate"> & {
  updateInstallmentDate(
    tenantId: string,
    projectId: string,
    id: string,
    parcela: number,
    data: string,
    requester: RateioRequester,
  ): ReturnType<ExpenseService["updateInstallmentDate"]>;
};

function installmentExpense(
  overrides: Partial<Prisma.ExpenseUncheckedCreateInput>,
): Prisma.ExpenseUncheckedCreateInput {
  return {
    tenantId: TENANT,
    projectId: PESSOAL,
    tipoDespesa: "MATERIAL_CONSTRUCAO",
    valor: 20_000,
    quantidade: 1,
    valorTotal: 20_000,
    titulo: "Compra parcelada",
    formaPagamento: "PARCELADO",
    quantidadeParcela: 2,
    dataInicioParcela: START,
    status: "PLANEJADO",
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

async function cleanupTransient(): Promise<void> {
  await setup.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${UPDATE_GUARD_TRIGGER}`,
  );
  const tenantIds = [TENANT, OTHER_TENANT];
  await setup.rateioAllocation.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await setup.crossProjectSettlement.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await setup.cashFlowEntry.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await setup.expense.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
}

async function cleanupAll(): Promise<void> {
  await cleanupTransient();
  const tenantIds = [TENANT, OTHER_TENANT];
  await setup.project.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await setup.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

async function snapshot(): Promise<unknown> {
  const tenantIds = [TENANT, OTHER_TENANT];
  const [expenses, rateios, settlements, cashFlows] = await Promise.all([
    setup.expense.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: "asc" },
    }),
    setup.rateioAllocation.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: [{ sourceExpenseId: "asc" }, { targetExpenseId: "asc" }],
    }),
    setup.crossProjectSettlement.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: "asc" },
    }),
    setup.cashFlowEntry.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { id: "asc" },
    }),
  ]);
  return { expenses, rateios, settlements, cashFlows };
}

async function seedSource(
  linkedExpenseId: string | null = null,
): Promise<void> {
  await setup.expense.create({
    data: installmentExpense({
      id: SOURCE,
      linkedExpenseId,
      titulo: "Fonte",
    }),
  });
}

async function seedTarget(
  id: string,
  projectId: string,
  tenantId = TENANT,
  deletedAt: Date | null = null,
): Promise<void> {
  await setup.expense.create({
    data: installmentExpense({
      id,
      tenantId,
      projectId,
      titulo: `Alvo ${id}`,
      deletedAt,
    }),
  });
}

async function seedAllocation(targetExpenseId: string, allocation: number) {
  await setup.rateioAllocation.create({
    data: {
      tenantId: TENANT,
      sourceExpenseId: SOURCE,
      targetExpenseId,
      allocation,
      plannedStatus: "PLANEJADO",
      plannedValor: allocation,
      plannedQuantidade: 1,
      plannedValorTotal: allocation,
      plannedForma: "PARCELADO",
      plannedQtdParcela: 2,
      plannedDataInicio: START,
    },
  });
}

async function captureError(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("ExpenseService.updateInstallmentDate — child ACL real SQLite (SEC-3 #478)", () => {
  let service: InstallmentDateService;

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    await cleanupAll();
    await setup.tenant.createMany({
      data: [
        { id: TENANT, name: "Installment ACL tenant" },
        { id: OTHER_TENANT, name: "Installment ACL other tenant" },
      ],
    });
    await setup.project.createMany({
      data: [
        {
          id: PESSOAL,
          tenantId: TENANT,
          type: "PESSOAL",
          name: "Pessoal",
        },
        {
          id: ALLOWED,
          tenantId: TENANT,
          type: "REFORMA",
          name: "Reforma autorizada",
        },
        {
          id: HIDDEN,
          tenantId: TENANT,
          type: "REFORMA",
          name: "Reforma oculta",
        },
        {
          id: OTHER_PROJECT,
          tenantId: OTHER_TENANT,
          type: "REFORMA",
          name: "Projeto de outro tenant",
        },
      ],
    });
    service = new ExpenseService(
      prisma,
      new ConciliacaoService(prisma),
    ) as InstallmentDateService;
  });

  afterEach(cleanupTransient);

  afterAll(async () => {
    await cleanupAll();
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  it("requester ausente falha fechado e preserva o estado integral", async () => {
    await seedSource();
    const before = await snapshot();

    const error = await captureError(
      service.updateInstallmentDate(
        TENANT,
        PESSOAL,
        SOURCE,
        1,
        OVERRIDE_DATE,
        undefined as never,
      ),
    );

    expect(await snapshot()).toEqual(before);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
  });

  it.each([
    {
      label: "hidden do mesmo tenant",
      targetId: HIDDEN_TARGET,
      seed: () => seedTarget(HIDDEN_TARGET, HIDDEN),
    },
    {
      label: "inexistente",
      targetId: MISSING_TARGET,
      seed: async () => undefined,
    },
    {
      label: "cross-tenant",
      targetId: OTHER_TARGET,
      seed: () => seedTarget(OTHER_TARGET, OTHER_PROJECT, OTHER_TENANT),
    },
  ])(
    "linked child $label colapsa no mesmo 404 e preserva snapshot integral",
    async ({ targetId, seed }) => {
      await seedSource(targetId);
      await seed();
      const before = await snapshot();

      const error = await captureError(
        service.updateInstallmentDate(
          TENANT,
          PESSOAL,
          SOURCE,
          1,
          OVERRIDE_DATE,
          MANAGED,
        ),
      );

      expect(await snapshot()).toEqual(before);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getStatus()).toBe(404);
      expect((error as NotFoundException).message).toBe(
        "Despesa relacionada não encontrada",
      );
    },
  );

  it("rateio misto allowed + hidden é rejeitado antes do primeiro write na fonte", async () => {
    await seedSource(ALLOWED_TARGET);
    await seedTarget(ALLOWED_TARGET, ALLOWED);
    await seedTarget(HIDDEN_TARGET, HIDDEN);
    await seedAllocation(ALLOWED_TARGET, 10_000);
    await seedAllocation(HIDDEN_TARGET, 10_000);
    await setup.$executeRawUnsafe(`
      CREATE TRIGGER ${UPDATE_GUARD_TRIGGER}
      BEFORE UPDATE ON expenses
      WHEN OLD.id = '${SOURCE}'
      BEGIN
        SELECT RAISE(ABORT, 'source write happened before ACL preflight');
      END
    `);
    const before = await snapshot();

    const error = await captureError(
      service.updateInstallmentDate(
        TENANT,
        PESSOAL,
        SOURCE,
        1,
        OVERRIDE_DATE,
        MANAGED,
      ),
    );

    expect(await snapshot()).toEqual(before);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
  });

  it("alvo de rateio soft-deletado é ignorado enquanto a fonte visível atualiza", async () => {
    await seedSource(HIDDEN_TARGET);
    await seedTarget(HIDDEN_TARGET, HIDDEN, TENANT, DELETED_AT);
    await seedAllocation(HIDDEN_TARGET, 20_000);
    const deletedTargetBefore = await setup.expense.findUniqueOrThrow({
      where: { id: HIDDEN_TARGET },
    });

    await expect(
      service.updateInstallmentDate(
        TENANT,
        PESSOAL,
        SOURCE,
        1,
        OVERRIDE_DATE,
        MANAGED,
      ),
    ).resolves.toEqual({
      id: SOURCE,
      parcela: 1,
      data: OVERRIDE_DATE,
      isOverride: true,
      affectedProjectIds: [PESSOAL],
    });

    expect(
      (await setup.expense.findUniqueOrThrow({ where: { id: SOURCE } }))
        .installmentDateOverrides,
    ).toBe('{"1":"2026-09-20"}');
    expect(
      await setup.expense.findUniqueOrThrow({ where: { id: HIDDEN_TARGET } }),
    ).toEqual(deletedTargetBefore);
    expect(
      await setup.rateioAllocation.count({
        where: { sourceExpenseId: SOURCE },
      }),
    ).toBe(1);
    expect(
      await setup.cashFlowEntry.count({
        where: { expenseId: HIDDEN_TARGET },
      }),
    ).toBe(0);
  });

  it("OWNER controla rateio com alvo fora da lente sem falso bloqueio", async () => {
    await seedSource(HIDDEN_TARGET);
    await seedTarget(HIDDEN_TARGET, HIDDEN);
    await seedAllocation(HIDDEN_TARGET, 20_000);

    await expect(
      service.updateInstallmentDate(
        TENANT,
        PESSOAL,
        SOURCE,
        1,
        OVERRIDE_DATE,
        OWNER,
      ),
    ).resolves.toEqual({
      id: SOURCE,
      parcela: 1,
      data: OVERRIDE_DATE,
      isOverride: true,
      affectedProjectIds: [HIDDEN, PESSOAL].sort(),
    });

    const rows = await setup.expense.findMany({
      where: { id: { in: [SOURCE, HIDDEN_TARGET] } },
      orderBy: { id: "asc" },
      select: { id: true, installmentDateOverrides: true },
    });
    expect(rows).toEqual([
      {
        id: HIDDEN_TARGET,
        installmentDateOverrides: '{"1":"2026-09-20"}',
      },
      { id: SOURCE, installmentDateOverrides: '{"1":"2026-09-20"}' },
    ]);
    expect(
      await setup.cashFlowEntry.count({
        where: {
          expenseId: { in: [SOURCE, HIDDEN_TARGET] },
          deletedAt: null,
        },
      }),
    ).toBe(4);
  });
});
