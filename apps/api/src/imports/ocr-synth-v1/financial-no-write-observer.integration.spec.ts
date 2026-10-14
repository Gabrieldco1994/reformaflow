import {
  INCLUDE_SOFT_DELETED,
  PrismaService,
} from "../../prisma/prisma.service";
import { extractPdfDocument } from "../../credit-card/parsers/pdf-document";
import { OCR_SYNTH_ROUTING_CASES } from "./corpus";
import { generateArtifact } from "./fixture-generator";

const TRACKED_MODELS = new Set([
  "Expense",
  "CashFlowEntry",
  "Receipt",
  "RateioAllocation",
  "CrossProjectSettlement",
  "ImportedInvoiceLiquidation",
]);
const SOFT_DELETED = {
  deletedAt: INCLUDE_SOFT_DELETED,
};

const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};

async function financialSnapshot(prisma: PrismaService) {
  const [
    expenses,
    cashFlowEntries,
    receipts,
    allocations,
    settlements,
    liquidations,
  ] = await Promise.all([
    prisma.expense.findMany({
      where: SOFT_DELETED,
      orderBy: { id: "asc" },
    }),
    prisma.cashFlowEntry.findMany({
      where: SOFT_DELETED,
      orderBy: { id: "asc" },
    }),
    prisma.receipt.findMany({
      where: SOFT_DELETED,
      orderBy: { id: "asc" },
    }),
    prisma.rateioAllocation.findMany({ orderBy: { id: "asc" } }),
    prisma.crossProjectSettlement.findMany({ orderBy: { id: "asc" } }),
    prisma.importedInvoiceLiquidation.findMany({
      where: SOFT_DELETED,
      orderBy: { id: "asc" },
    }),
  ]);
  return canonical({
    Expense: expenses,
    CashFlowEntry: cashFlowEntries,
    Receipt: receipts,
    RateioAllocation: allocations,
    CrossProjectSettlement: settlements,
    ImportedInvoiceLiquidation: liquidations,
  }) as Record<string, unknown[]>;
}

async function observeNoFinancialWrite<T>(
  prisma: PrismaService,
  act: () => Promise<T>,
) {
  const operations: string[] = [];
  let observing = false;
  prisma.$use(async (params, next) => {
    if (
      observing &&
      TRACKED_MODELS.has(params.model ?? "") &&
      /^(?:create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(
        params.action,
      )
    )
      operations.push(`${params.model}.${params.action}`);
    return next(params);
  });
  const before = await financialSnapshot(prisma);
  observing = true;
  const result = await act();
  observing = false;
  const after = await financialSnapshot(prisma);
  if (operations.length > 0 || JSON.stringify(after) !== JSON.stringify(before))
    throw Object.assign(new Error("FINANCIAL_WRITE_OBSERVED"), {
      before,
      after,
      operations,
    });
  return { result, before, after, operations };
}

async function fixture(prisma: PrismaService, label: string) {
  const tenantId = `b3-tenant-${label}`;
  const projectId = `b3-project-${label}`;
  await prisma.tenant.create({
    data: { id: tenantId, name: `Band 3 ${label}` },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      tenantId,
      name: `Band 3 ${label}`,
      type: "PESSOAL",
    },
  });
  const expense = (suffix: string, valorTotal = 20_696) =>
    prisma.expense.create({
      data: {
        id: `b3-expense-${label}-${suffix}`,
        tenantId,
        projectId,
        tipoDespesa: "OUTROS",
        valor: valorTotal,
        quantidade: 1,
        valorTotal,
        formaPagamento: "A_VISTA",
        titulo: `Band 3 ${suffix}`,
      },
    });
  return { tenantId, projectId, expense };
}

describe("Band-3 real PrismaService financial no-write observer", () => {
  let prisma: PrismaService;

  beforeEach(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("[B3] detects row replacement despite stable live count and cent sum", async () => {
    const data = await fixture(prisma, "replacement");
    const original = await data.expense("original");

    await expect(
      observeNoFinancialWrite(prisma, async () => {
        await prisma.expense.delete({ where: { id: original.id } });
        await data.expense("replacement");
      }),
    ).rejects.toMatchObject({
      message: "FINANCIAL_WRITE_OBSERVED",
      operations: ["Expense.update", "Expense.create"],
    });
  });

  it("[B3] detects soft deletion while explicitly retaining deleted rows", async () => {
    const data = await fixture(prisma, "soft-delete");
    const original = await data.expense("original");

    await expect(
      observeNoFinancialWrite(prisma, async () => {
        await prisma.expense.delete({ where: { id: original.id } });
      }),
    ).rejects.toMatchObject({
      message: "FINANCIAL_WRITE_OBSERVED",
      operations: ["Expense.update"],
      after: {
        Expense: expect.arrayContaining([
          expect.objectContaining({
            id: original.id,
            deletedAt: expect.stringMatching(/^2026-|^20\d\d-/),
          }),
        ]),
      },
    });
  });

  it("[B3] detects create-then-delete with zero live aggregate", async () => {
    const data = await fixture(prisma, "create-delete");

    await expect(
      observeNoFinancialWrite(prisma, async () => {
        const created = await data.expense("ephemeral", 1);
        await prisma.expense.delete({ where: { id: created.id } });
      }),
    ).rejects.toMatchObject({
      message: "FINANCIAL_WRITE_OBSERVED",
      operations: ["Expense.create", "Expense.update"],
    });
  });

  it("[B3] detects another-tenant and globally enumerated settlement writes", async () => {
    const observer = await fixture(prisma, "observer");
    await observer.expense("anchor");
    const other = await fixture(prisma, "other");
    const source = await other.expense("source", 10_000);
    const target = await other.expense("target", 10_000);

    await expect(
      observeNoFinancialWrite(prisma, async () => {
        await prisma.expense.update({
          where: { id: source.id },
          data: { titulo: "second tenant changed" },
        });
      }),
    ).rejects.toThrow("FINANCIAL_WRITE_OBSERVED");

    await expect(
      observeNoFinancialWrite(prisma, async () => {
        await prisma.crossProjectSettlement.create({
          data: {
            id: "b3-global-settlement",
            tenantId: other.tenantId,
            sourceExpenseId: source.id,
            targetExpenseId: target.id,
            parcelaIndex: 0,
            realValor: 10_000,
            plannedValor: 10_000,
            plannedStatus: "PLANEJADO",
          },
        });
      }),
    ).rejects.toMatchObject({
      message: "FINANCIAL_WRITE_OBSERVED",
      operations: ["CrossProjectSettlement.create"],
    });
  });

  it("[B3] fails closed on concurrent activity through a second PrismaService", async () => {
    const data = await fixture(prisma, "concurrent");
    const second = new PrismaService();
    await second.$connect();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const observation = observeNoFinancialWrite(prisma, async () => {
        entered();
        await released;
      });
      await paused;
      await second.expense.create({
        data: {
          id: "b3-expense-concurrent-external",
          tenantId: data.tenantId,
          projectId: data.projectId,
          tipoDespesa: "OUTROS",
          valor: 1,
          quantidade: 1,
          valorTotal: 1,
          formaPagamento: "A_VISTA",
        },
      });
      release();

      await expect(observation).rejects.toMatchObject({
        message: "FINANCIAL_WRITE_OBSERVED",
        operations: [],
      });
    } finally {
      release();
      await second.$disconnect();
    }
  });

  it("[B3] positive route control preserves exact enumerable rows in all six tables", async () => {
    await fixture(prisma, "positive");
    const route = OCR_SYNTH_ROUTING_CASES[0]!;

    const observed = await observeNoFinancialWrite(prisma, async () =>
      extractPdfDocument(await generateArtifact(route)),
    );

    expect(observed.result.documentKind).not.toBe("SCANNED");
    expect(observed.operations).toEqual([]);
    expect(observed.after).toEqual(observed.before);
    expect(Object.keys(observed.before)).toEqual([
      "CashFlowEntry",
      "CrossProjectSettlement",
      "Expense",
      "ImportedInvoiceLiquidation",
      "RateioAllocation",
      "Receipt",
    ]);
    for (const rows of Object.values(observed.before)) {
      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows)
        expect(
          Object.keys(row as Record<string, unknown>).length,
        ).toBeGreaterThan(1);
    }
  });
});
