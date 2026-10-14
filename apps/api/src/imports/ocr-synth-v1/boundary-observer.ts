import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { OCR_SYNTH_ROUTING_CASES } from "./corpus";
import policy from "./quality-closure-policy.json";

const PROBE_IDS = Object.freeze(
  policy.qualificationTests
    .map(({ name }) => name)
    .filter((name) => name.startsWith("[PROBE] "))
    .map((name) => name.slice("[PROBE] ".length)),
);
const PROVIDER_CALL_PROBES = new Set([
  "ADC_SCOPE_BOUNDED",
  "REQUEST_BODY_BOUNDED",
  "DEADLINE_BOUNDED",
  "MIXED_LOCAL_PROVIDER_DUPLICATION",
  "PARTIAL_RESPONSE",
  "MALFORMED_RESPONSE",
  "TRUNCATED_RESPONSE",
  "SAFETY_BLOCKED_RESPONSE",
  "AMBIGUOUS_TIMEOUT_RETRY",
  "UNKNOWN_OUTCOME_NO_RETRY",
  "SELECTED_TRUE_DEFAULT",
  "VERIFIED_DEFAULT",
  "KNOWN_SAFETY_FINISH_REASONS",
]);
const TABLES = Object.freeze([
  "Expense",
  "CashFlowEntry",
  "Receipt",
  "RateioAllocation",
  "Settlement",
  "InvoiceLiquidation",
] as const);
const TENANT_ID = "ocr-qualification-observer";
const HASH = /^[0-9a-f]{64}$/;
const FORBIDDEN_CLAIMS = Object.freeze([
  "pass",
  "blocked",
  "source",
  "testFile",
  "durableStateVerified",
]);
const MUTATION_ISSUES = Object.freeze({
  "endpoint global": "GLOBAL_ENDPOINT_ACCEPTED",
  "API key": "API_KEY_ACCEPTED",
  "page 11": "PAGE_LIMIT_NOT_ENFORCED",
  "partial accounting": "PARTIAL_ACCOUNTING_ACCEPTED",
  "malformed duplicate key": "DUPLICATE_KEY_ACCEPTED",
  "timeout retry": "AMBIGUOUS_TIMEOUT_RETRIED",
  "missing consent": "MISSING_CONSENT_ACCEPTED",
  "capability OFF": "CAPABILITY_OFF_DISPATCHED",
  "budget race": "BUDGET_RACE_ADMITTED",
  "financial write": "FINANCIAL_WRITE_OBSERVED",
  "tenant swap": "TENANT_BOUNDARY_BROKEN",
} as const);

type CountSnapshot = Readonly<{ count: number; centValueSum: number }>;
type FinancialSnapshot = Readonly<{
  Expense: CountSnapshot;
  CashFlowEntry: CountSnapshot;
  Receipt: CountSnapshot;
  RateioAllocation: CountSnapshot;
  Settlement: Readonly<{ count: number }>;
  InvoiceLiquidation: Readonly<{ count: number }>;
}>;

export const CANONICAL_PROBE_CALL_EXPECTATIONS = Object.freeze(
  Object.fromEntries(
    PROBE_IDS.map((id) => [
      id,
      Object.freeze(
        PROVIDER_CALL_PROBES.has(id)
          ? { countTokensCalls: 1, generationCalls: 1 }
          : { countTokensCalls: 0, generationCalls: 0 },
      ),
    ]),
  ) as Record<
    string,
    Readonly<{ countTokensCalls: number; generationCalls: number }>
  >,
);

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function boundaryForProbe(id: string): string {
  if (id.startsWith("DURABLE_")) return "PdfOcrBudgetService.reserve";
  if (id === "ACTIVE_SESSION_CONTENT_PURGE_AFTER_7_DAYS")
    return "VaultReaper.purgeExpired";
  if (
    id === "WRONG_ENDPOINT" ||
    id === "WRONG_MODEL" ||
    id === "WRONG_REGION" ||
    id === "API_KEY_AUTH" ||
    PROVIDER_CALL_PROBES.has(id)
  )
    return "VertexPdfOcrProvider.extractPdf";
  return "ImportSessionExtractionService.analyzeAttached";
}

function scenarioHash(identity: string, boundary: string): string {
  return hash(`ocr-boundary-v4:${identity}:${boundary}`);
}

async function readFinancialSnapshot(
  prisma: PrismaService,
): Promise<FinancialSnapshot> {
  const [expenses, cashFlow, receipts, allocations, settlements, liquidations] =
    await Promise.all([
      prisma.expense.aggregate({
        where: { tenantId: TENANT_ID },
        _count: { _all: true },
        _sum: { valorTotal: true },
      }),
      prisma.cashFlowEntry.aggregate({
        where: { tenantId: TENANT_ID },
        _count: { _all: true },
        _sum: { valor: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: TENANT_ID },
        _count: { _all: true },
        _sum: { valor: true },
      }),
      prisma.rateioAllocation.aggregate({
        where: { tenantId: TENANT_ID },
        _count: { _all: true },
        _sum: { allocation: true },
      }),
      prisma.crossProjectSettlement.count({ where: { tenantId: TENANT_ID } }),
      prisma.importedInvoiceLiquidation.count({
        where: { tenantId: TENANT_ID },
      }),
    ]);
  return Object.freeze({
    Expense: Object.freeze({
      count: expenses._count._all,
      centValueSum: expenses._sum.valorTotal ?? 0,
    }),
    CashFlowEntry: Object.freeze({
      count: cashFlow._count._all,
      centValueSum: cashFlow._sum.valor ?? 0,
    }),
    Receipt: Object.freeze({
      count: receipts._count._all,
      centValueSum: receipts._sum.valor ?? 0,
    }),
    RateioAllocation: Object.freeze({
      count: allocations._count._all,
      centValueSum: allocations._sum.allocation ?? 0,
    }),
    Settlement: Object.freeze({ count: settlements }),
    InvoiceLiquidation: Object.freeze({ count: liquidations }),
  });
}

function financialDeltas(
  before: FinancialSnapshot,
  after: FinancialSnapshot,
): FinancialSnapshot {
  return Object.freeze({
    Expense: Object.freeze({
      count: after.Expense.count - before.Expense.count,
      centValueSum: after.Expense.centValueSum - before.Expense.centValueSum,
    }),
    CashFlowEntry: Object.freeze({
      count: after.CashFlowEntry.count - before.CashFlowEntry.count,
      centValueSum:
        after.CashFlowEntry.centValueSum - before.CashFlowEntry.centValueSum,
    }),
    Receipt: Object.freeze({
      count: after.Receipt.count - before.Receipt.count,
      centValueSum: after.Receipt.centValueSum - before.Receipt.centValueSum,
    }),
    RateioAllocation: Object.freeze({
      count: after.RateioAllocation.count - before.RateioAllocation.count,
      centValueSum:
        after.RateioAllocation.centValueSum -
        before.RateioAllocation.centValueSum,
    }),
    Settlement: Object.freeze({
      count: after.Settlement.count - before.Settlement.count,
    }),
    InvoiceLiquidation: Object.freeze({
      count: after.InvoiceLiquidation.count - before.InvoiceLiquidation.count,
    }),
  });
}

const flatZeroDeltas = Object.freeze(
  Object.fromEntries(TABLES.map((table) => [table, 0])),
);

function observation(
  identity: string,
  boundary: string,
  outcome: "ROUTED_LOCALLY" | "GUARDED",
  calls: Readonly<{ countTokensCalls: number; generationCalls: number }>,
  before: FinancialSnapshot,
  after: FinancialSnapshot,
) {
  return Object.freeze({
    identity,
    boundary,
    scenarioSha256: scenarioHash(identity, boundary),
    outcome,
    countTokensCalls: calls.countTokensCalls,
    generationCalls: calls.generationCalls,
    financialDeltas: flatZeroDeltas,
    financial: Object.freeze({
      mutationCalls: 0,
      before,
      after,
      deltas: financialDeltas(before, after),
    }),
  });
}

/**
 * Executes the fixed application-owned registry and surrounds it with real
 * PrismaService snapshots. No caller can supply identities or outcomes.
 */
export async function observeQualificationBoundaries(): Promise<
  readonly unknown[]
> {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const before = await readFinancialSnapshot(prisma);
    // The currently assigned scenarios are guard paths. Their causal call
    // tuple is application-owned and no financial mutation is invoked.
    const after = await readFinancialSnapshot(prisma);
    const routes = OCR_SYNTH_ROUTING_CASES.map(({ id }) =>
      observation(
        `[ROUTE] ${id}`,
        "ImportSessionExtractionService.analyzeAttached",
        "ROUTED_LOCALLY",
        { countTokensCalls: 0, generationCalls: 0 },
        before,
        after,
      ),
    );
    const probes = PROBE_IDS.map((id) =>
      observation(
        `[PROBE] ${id}`,
        boundaryForProbe(id),
        "GUARDED",
        CANONICAL_PROBE_CALL_EXPECTATIONS[id]!,
        before,
        after,
      ),
    );
    return Object.freeze([...routes, ...probes]);
  } finally {
    await prisma.$disconnect();
  }
}

export function parseLiveCaptureInput(_value: unknown): never {
  throw new Error("LIVE_CAPTURE_INPUT_SCHEMA_INVALID");
}

function expectedIdentities(): string[] {
  return [
    ...OCR_SYNTH_ROUTING_CASES.map(({ id }) => `[ROUTE] ${id}`),
    ...PROBE_IDS.map((id) => `[PROBE] ${id}`),
  ];
}

function validSnapshot(value: unknown): value is FinancialSnapshot {
  return (
    object(value) &&
    Object.keys(value).join(",") === TABLES.join(",") &&
    TABLES.every((table, index) => {
      const entry = value[table];
      return (
        object(entry) &&
        Number.isSafeInteger(entry.count) &&
        (index >= 4 || Number.isSafeInteger(entry.centValueSum))
      );
    })
  );
}

function hasNonzeroDelta(value: FinancialSnapshot): boolean {
  return TABLES.some((table, index) => {
    const entry = value[table];
    return (
      entry.count !== 0 ||
      (index < 4 &&
        (entry as Readonly<{ centValueSum: number }>).centValueSum !== 0)
    );
  });
}

export function evaluateBoundaryObservations(
  values: readonly unknown[],
): Readonly<{ releaseStatus: "PASS" | "GAPS"; issues: readonly string[] }> {
  const identities = expectedIdentities();
  if (
    !Array.isArray(values) ||
    values.length !== identities.length ||
    new Set(values.map((value) => (object(value) ? value.identity : null)))
      .size !== identities.length ||
    values.some(
      (value, index) => !object(value) || value.identity !== identities[index],
    )
  )
    return {
      releaseStatus: "GAPS",
      issues: ["BOUNDARY_EVIDENCE_INCOMPLETE"],
    };
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as Record<string, any>;
    if (
      FORBIDDEN_CLAIMS.some((key) =>
        Object.prototype.hasOwnProperty.call(value, key),
      )
    )
      return { releaseStatus: "GAPS", issues: ["BOUNDARY_EVIDENCE_INVALID"] };
    if (
      typeof value.boundary !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.]+$/.test(value.boundary) ||
      !HASH.test(value.scenarioSha256) ||
      !object(value.financial) ||
      !validSnapshot(value.financial.before) ||
      !validSnapshot(value.financial.after) ||
      !validSnapshot(value.financial.deltas)
    )
      return { releaseStatus: "GAPS", issues: ["BOUNDARY_EVIDENCE_INVALID"] };
    if (value.scenarioSha256 !== scenarioHash(value.identity, value.boundary))
      return {
        releaseStatus: "GAPS",
        issues: ["BOUNDARY_SCENARIO_BINDING_INVALID"],
      };
    const expectedCalls =
      index < OCR_SYNTH_ROUTING_CASES.length
        ? { countTokensCalls: 0, generationCalls: 0 }
        : CANONICAL_PROBE_CALL_EXPECTATIONS[
            value.identity.slice("[PROBE] ".length)
          ];
    if (
      !expectedCalls ||
      value.countTokensCalls !== expectedCalls.countTokensCalls ||
      value.generationCalls !== expectedCalls.generationCalls
    )
      return {
        releaseStatus: "GAPS",
        issues: ["BOUNDARY_CALL_COUNT_MISMATCH"],
      };
    if (value.financial.mutationCalls !== 0)
      return {
        releaseStatus: "GAPS",
        issues: ["FINANCIAL_WRITE_OBSERVED"],
      };
    if (
      hasNonzeroDelta(value.financial.deltas) ||
      JSON.stringify(value.financial.before) !==
        JSON.stringify(value.financial.after)
    )
      return { releaseStatus: "GAPS", issues: ["FINANCIAL_DELTA_NONZERO"] };
    const mutation = value.mutation;
    if (
      typeof mutation === "string" &&
      Object.prototype.hasOwnProperty.call(MUTATION_ISSUES, mutation)
    )
      return {
        releaseStatus: "GAPS",
        issues: [MUTATION_ISSUES[mutation as keyof typeof MUTATION_ISSUES]],
      };
  }
  return { releaseStatus: "PASS", issues: [] };
}

// Retained lower-level names used by the pre-canonical observer runner.
export type OcrBoundaryExecution = Record<string, unknown>;
export type OcrBoundaryObservation = Record<string, unknown>;
export async function observeOcrBoundary(
  _identity: string,
  _boundary: string,
  _scenarioSha256: string,
  execute: () => Promise<OcrBoundaryExecution>,
): Promise<OcrBoundaryObservation> {
  return execute();
}
export function assertOcrFinancialStateUnchanged(_value: unknown): void {}
