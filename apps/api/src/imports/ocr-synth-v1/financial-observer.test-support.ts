import {
  INCLUDE_SOFT_DELETED,
  PrismaService,
} from "../../prisma/prisma.service";

const TRACKED_MODELS = new Set([
  "Expense",
  "CashFlowEntry",
  "Receipt",
  "RateioAllocation",
  "CrossProjectSettlement",
  "ImportedInvoiceLiquidation",
]);

const WRITE_ACTION =
  /^(?:create|createMany|update|updateMany|upsert|delete|deleteMany)$/;
const SOFT_DELETED = { deletedAt: INCLUDE_SOFT_DELETED };

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

export async function fullFinancialSnapshot(prisma: PrismaService) {
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
  }) as Readonly<Record<string, readonly unknown[]>>;
}

export async function observeNoFinancialWrite<T>(
  prisma: PrismaService,
  act: () => Promise<T>,
) {
  const operations: string[] = [];
  let observing = false;
  prisma.$use(async (params, next) => {
    if (
      observing &&
      TRACKED_MODELS.has(params.model ?? "") &&
      WRITE_ACTION.test(params.action)
    )
      operations.push(`${params.model}.${params.action}`);
    return next(params);
  });
  const secondConnection = new PrismaService();
  await secondConnection.$connect();
  try {
    const before = await fullFinancialSnapshot(secondConnection);
    observing = true;
    const result = await act();
    observing = false;
    const after = await fullFinancialSnapshot(secondConnection);
    if (
      operations.length > 0 ||
      JSON.stringify(after) !== JSON.stringify(before)
    )
      throw Object.assign(new Error("FINANCIAL_WRITE_OBSERVED"), {
        before,
        after,
        operations,
      });
    return { result, before, after, operations };
  } finally {
    observing = false;
    await secondConnection.$disconnect();
  }
}
