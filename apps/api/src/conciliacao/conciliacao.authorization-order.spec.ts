// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../scripts/test-db-env.cjs");

import { ConciliacaoService } from "./conciliacao.service";
import { RateioRequester } from "../expense/rateio.types";

const TENANT = "rateio-acl-tenant";
const SOURCE_PROJECT = "rateio-acl-source-project";
const ALLOWED_PROJECT = "rateio-acl-allowed-project";
const HIDDEN_PROJECT = "rateio-acl-hidden-project";

const MANAGED: RateioRequester = {
  role: "USER",
  allowedProjects: [SOURCE_PROJECT, ALLOWED_PROJECT],
  allowedProjectTypes: ["PESSOAL", "REFORMA"],
  allowedModules: ["expenses"],
};

type DeniedKind = "hidden" | "missing" | "cross-tenant";

function expense(id: string, projectId: string, valorTotal: number): any {
  return {
    id,
    tenantId: TENANT,
    projectId,
    tipoDespesa: "MATERIAL_CONSTRUCAO",
    valor: valorTotal,
    quantidade: 1,
    valorTotal,
    formaPagamento: "A_VISTA",
    dataPagamento: new Date("2026-08-18T12:00:00.000Z"),
    quantidadeParcela: null,
    dataInicioParcela: null,
    installmentDateOverrides: null,
    status: "PLANEJADO",
    paidParcelas: null,
    linkedExpenseId: null,
    room: null,
    project: {
      id: projectId,
      type: projectId === SOURCE_PROJECT ? "PESSOAL" : "REFORMA",
      tenantId: TENANT,
      deletedAt: null,
    },
  };
}

function buildTx(
  options: {
    deniedKind?: DeniedKind;
    existingHidden?: boolean;
    deletedTargetProject?: boolean;
  } = {},
) {
  const source = expense("source", SOURCE_PROJECT, 20_000);
  const allowed = expense("allowed-target", ALLOWED_PROJECT, 10_000);
  if (options.deletedTargetProject) {
    allowed.project.deletedAt = new Date("2026-08-19T12:00:00.000Z");
  }
  const denied = expense("denied-target", HIDDEN_PROJECT, 10_000);
  if (options.deniedKind === "cross-tenant") {
    denied.tenantId = "another-tenant";
    denied.project.tenantId = "another-tenant";
  }
  const oldHidden = expense("old-hidden-target", HIDDEN_PROJECT, 20_000);
  const allocationStore = new Map<string, any>();
  if (options.existingHidden) {
    allocationStore.set(oldHidden.id, {
      tenantId: TENANT,
      sourceExpenseId: source.id,
      targetExpenseId: oldHidden.id,
      allocation: 20_000,
      plannedStatus: "PLANEJADO",
      plannedPaid: null,
      plannedValor: 20_000,
      plannedQuantidade: 1,
      plannedValorTotal: 20_000,
      plannedForma: "A_VISTA",
      plannedQtdParcela: null,
      plannedDataInicio: null,
      plannedDataPagamento: new Date("2026-08-18T12:00:00.000Z"),
      plannedInstallmentDateOverrides: null,
    });
    source.linkedExpenseId = oldHidden.id;
  }

  const writes: string[] = [];
  const rows: Record<string, any> = {
    [source.id]: source,
    [allowed.id]: allowed,
    [oldHidden.id]: oldHidden,
  };
  if (options.deniedKind !== "missing") rows[denied.id] = denied;

  const tx: any = {
    expense: {
      findFirst: jest.fn(async ({ where, include }: any) => {
        const row = rows[where.id];
        if (!row || (where.tenantId && row.tenantId !== where.tenantId))
          return null;
        return include?.project ? row : { ...row, project: undefined };
      }),
      findMany: jest.fn(async ({ where, include, select }: any) => {
        const ids: string[] = where.id?.in ?? Object.keys(rows);
        return ids
          .map((id) => rows[id])
          .filter(
            (row) =>
              row &&
              (!where.tenantId || row.tenantId === where.tenantId) &&
              (where.deletedAt === undefined ||
                (row.deletedAt ?? null) === where.deletedAt),
          )
          .map((row) => {
            if (select) {
              return Object.fromEntries(
                Object.keys(select)
                  .filter((key) => select[key])
                  .map((key) => [key, row[key]]),
              );
            }
            return include?.project ? row : { ...row, project: undefined };
          });
      }),
      update: jest.fn(async ({ where, data }: any) => {
        writes.push(`expense.update:${where.id}`);
        Object.assign(rows[where.id], data);
        return rows[where.id];
      }),
    },
    rateioAllocation: {
      count: jest.fn(async () => allocationStore.size),
      findMany: jest.fn(async ({ where }: any) =>
        Array.from(allocationStore.values()).filter(
          (row) =>
            row.tenantId === where.tenantId &&
            row.sourceExpenseId === where.sourceExpenseId,
        ),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        if (typeof where.targetExpenseId === "string") {
          return allocationStore.get(where.targetExpenseId) ?? null;
        }
        if (Array.isArray(where.sourceExpenseId?.in)) {
          return (
            Array.from(allocationStore.values()).find((row) =>
              where.sourceExpenseId.in.includes(row.sourceExpenseId),
            ) ?? null
          );
        }
        if (typeof where.sourceExpenseId === "string") {
          return (
            Array.from(allocationStore.values()).find(
              (row) => row.sourceExpenseId === where.sourceExpenseId,
            ) ?? null
          );
        }
        return null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        writes.push(`rateioAllocation.upsert:${where.targetExpenseId}`);
        allocationStore.set(where.targetExpenseId, {
          ...(allocationStore.get(where.targetExpenseId) ?? create),
          ...update,
        });
        return allocationStore.get(where.targetExpenseId);
      }),
      delete: jest.fn(async ({ where }: any) => {
        writes.push(`rateioAllocation.delete:${where.targetExpenseId}`);
        allocationStore.delete(where.targetExpenseId);
        return {};
      }),
    },
    crossProjectSettlement: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    cashFlowEntry: {
      updateMany: jest.fn(async ({ where }: any) => {
        writes.push(`cashFlowEntry.updateMany:${where.expenseId}`);
        return { count: 0 };
      }),
      createMany: jest.fn(async ({ data }: any) => {
        writes.push(`cashFlowEntry.createMany:${data[0]?.expenseId}`);
        return { count: data.length };
      }),
    },
  };

  return { tx, writes };
}

async function captureError(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe("ConciliacaoService.ratearSource — preflight ACL antes da primeira write", () => {
  it.each<DeniedKind>(["hidden", "missing", "cross-tenant"])(
    "%s é indistinguível e não permite write parcial no alvo anterior",
    async (deniedKind) => {
      const { tx, writes } = buildTx({ deniedKind });
      const service = new ConciliacaoService({} as any);

      const error = await captureError(() =>
        service.ratearSource(
          tx,
          {
            tenantId: TENANT,
            sourceExpenseId: "source",
            allocations: [
              { targetExpenseId: "allowed-target", allocation: 10_000 },
              { targetExpenseId: "denied-target", allocation: 10_000 },
            ],
          },
          MANAGED,
        ),
      );

      expect(error).not.toBeNull();
      expect({
        name: error?.constructor.name,
        status: (error as any)?.getStatus?.(),
      }).toEqual({ name: "BadRequestException", status: 400 });
      expect(writes).toEqual([]);
    },
  );

  it("autoriza participantes existentes e novos antes de desfazer o rateio atual", async () => {
    const { tx, writes } = buildTx({ existingHidden: true });
    const service = new ConciliacaoService({} as any);

    const error = await captureError(() =>
      service.ratearSource(
        tx,
        {
          tenantId: TENANT,
          sourceExpenseId: "source",
          allocations: [
            { targetExpenseId: "allowed-target", allocation: 20_000 },
          ],
        },
        MANAGED,
      ),
    );

    expect(error).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it("requester undefined falha fechado antes de qualquer write", async () => {
    const { tx, writes } = buildTx();
    const service = new ConciliacaoService({} as any);

    await expect(
      (service as any).ratearSource(tx, {
        tenantId: TENANT,
        sourceExpenseId: "source",
        allocations: [
          { targetExpenseId: "allowed-target", allocation: 20_000 },
        ],
      }),
    ).rejects.toBeDefined();
    expect(writes).toEqual([]);
  });

  it("reversão com requester undefined também falha fechado sem restaurar participantes", async () => {
    const { tx, writes } = buildTx({ existingHidden: true });
    const service = new ConciliacaoService({} as any);

    await expect(
      (service as any).reverseSourceLinks(tx, {
        tenantId: TENANT,
        sourceExpenseId: "source",
      }),
    ).rejects.toBeDefined();
    expect(writes).toEqual([]);
  });

  it.each(["OWNER", "ADMIN"])(
    "%s pode ratear alvo do mesmo tenant",
    async (role) => {
      const { tx } = buildTx({ deniedKind: "hidden" });
      const service = new ConciliacaoService({} as any);

      const result = await service.ratearSource(
        tx,
        {
          tenantId: TENANT,
          sourceExpenseId: "source",
          allocations: [
            { targetExpenseId: "denied-target", allocation: 20_000 },
          ],
        },
        {
          role,
          allowedProjects: [],
          allowedProjectTypes: [],
          allowedModules: [],
        },
      );

      expect(result).toEqual({ targets: ["denied-target"] });
    },
  );

  it.each([
    ["USER autorizado", MANAGED],
    [
      "OWNER",
      {
        role: "OWNER",
        allowedProjects: [],
        allowedProjectTypes: [],
        allowedModules: [],
      } satisfies RateioRequester,
    ],
  ])(
    "%s rejeita alvo ativo cujo projeto pai foi removido, sem writes",
    async (_label, requester) => {
      const { tx, writes } = buildTx({ deletedTargetProject: true });
      const service = new ConciliacaoService({} as any);

      const error = await captureError(() =>
        service.assertCanSettleTargets(
          tx,
          { tenantId: TENANT, targetExpenseIds: ["allowed-target"] },
          requester,
        ),
      );

      expect({
        name: error?.constructor.name,
        status: (error as any)?.getStatus?.(),
        message: error?.message,
      }).toEqual({
        name: "NotFoundException",
        status: 404,
        message: "Despesa alvo não encontrada",
      });
      expect(writes).toEqual([]);
    },
  );
});
