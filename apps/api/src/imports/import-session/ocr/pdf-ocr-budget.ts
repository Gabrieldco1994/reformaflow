import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  ImportSessionErrorCode,
  type PdfOcrUsageV2,
} from "@reformaflow/domain";
import { ImportSessionError } from "../import-session.errors";

export interface PdfOcrDailyBudgetLimits {
  readonly calls: Readonly<{ user: number; tenant: number; global: number }>;
  readonly pages: Readonly<{ user: number; tenant: number; global: number }>;
  readonly bytes: Readonly<{ user: number; tenant: number; global: number }>;
  readonly costUnits: Readonly<{
    user: number;
    tenant: number;
    global: number;
  }>;
}

export const PDF_OCR_DAILY_BUDGET_LIMITS: PdfOcrDailyBudgetLimits =
  Object.freeze({
    calls: Object.freeze({ user: 25, tenant: 100, global: 1_000 }),
    pages: Object.freeze({ user: 250, tenant: 1_000, global: 10_000 }),
    bytes: Object.freeze({
      user: 250_000_000,
      tenant: 1_000_000_000,
      global: 10_000_000_000,
    }),
    // Provider-neutral token units, deliberately not represented as currency.
    costUnits: Object.freeze({
      user: 819_200,
      tenant: 3_276_800,
      global: 32_768_000,
    }),
  });
export const PDF_OCR_RESERVED_COST_UNITS_PER_CALL = 32_768;
export const PDF_OCR_USAGE_OUTCOME = {
  ATTEMPTED: "ATTEMPTED",
  SUCCEEDED: "SUCCEEDED",
  NOT_DISPATCHED: "NOT_DISPATCHED",
  UNKNOWN: "UNKNOWN",
  AUTH: "AUTH",
  RATE_LIMITED: "RATE_LIMITED",
  UPSTREAM: "UPSTREAM",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  SAFETY: "SAFETY",
} as const;
export type PdfOcrUsageOutcome =
  (typeof PDF_OCR_USAGE_OUTCOME)[keyof typeof PDF_OCR_USAGE_OUTCOME];

export interface PdfOcrBudgetReservation {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerProjectId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly requestId: string;
  readonly pageCount: number;
  readonly byteCount: number;
  readonly now: Date;
}

type Scope = "user" | "tenant" | "global";
const exhausted = () =>
  new ImportSessionError(ImportSessionErrorCode.OCR_BUDGET_EXHAUSTED);

/**
 * Must run in the same SQLite writer transaction as the irreversible attempt
 * fence. SQLite serializes the insert, so a racing aggregate cannot over-admit.
 */
export async function reservePdfOcrBudget(
  tx: Prisma.TransactionClient,
  input: PdfOcrBudgetReservation,
  limits: PdfOcrDailyBudgetLimits = PDF_OCR_DAILY_BUDGET_LIMITS,
): Promise<void> {
  const day = input.now.toISOString().slice(0, 10);
  const scopes: readonly Readonly<{
    name: Scope;
    where: Prisma.ImportOcrUsageWhereInput;
  }>[] = [
    {
      name: "user",
      where: { day, tenantId: input.tenantId, actorId: input.actorId },
    },
    { name: "tenant", where: { day, tenantId: input.tenantId } },
    { name: "global", where: { day } },
  ];
  for (const scope of scopes) {
    const used = await tx.importOcrUsage.aggregate({
      where: scope.where,
      _sum: {
        reservedCalls: true,
        reservedPages: true,
        reservedBytes: true,
        reservedCostUnits: true,
      },
    });
    if (
      (used._sum.reservedCalls ?? 0) + 1 > limits.calls[scope.name] ||
      (used._sum.reservedPages ?? 0) + input.pageCount >
        limits.pages[scope.name] ||
      (used._sum.reservedBytes ?? 0) + input.byteCount >
        limits.bytes[scope.name] ||
      (used._sum.reservedCostUnits ?? 0) +
        PDF_OCR_RESERVED_COST_UNITS_PER_CALL >
        limits.costUnits[scope.name]
    )
      throw exhausted();
  }
  await tx.importOcrUsage.create({
    data: {
      id: input.id,
      day,
      tenantId: input.tenantId,
      ownerProjectId: input.ownerProjectId,
      actorId: input.actorId,
      sessionId: input.sessionId,
      attachmentId: input.attachmentId,
      artifactId: input.artifactId,
      artifactSha256: input.artifactSha256,
      requestId: input.requestId,
      provider: PDF_OCR_PROVIDER_ID,
      model: PDF_OCR_MODEL_ID,
      reservedCalls: 1,
      reservedPages: input.pageCount,
      reservedBytes: input.byteCount,
      reservedCostUnits: PDF_OCR_RESERVED_COST_UNITS_PER_CALL,
      outcome: PDF_OCR_USAGE_OUTCOME.ATTEMPTED,
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
}

export function newPdfOcrBudgetReservationId(): string {
  return randomUUID();
}

export async function reconcilePdfOcrBudget(
  tx: Prisma.TransactionClient,
  id: string,
  outcome: Exclude<PdfOcrUsageOutcome, "ATTEMPTED">,
  now: Date,
  usage: PdfOcrUsageV2 | null,
  responseId: string | null = null,
): Promise<void> {
  const changed = await tx.importOcrUsage.updateMany({
    where: { id, outcome: PDF_OCR_USAGE_OUTCOME.ATTEMPTED },
    data: {
      outcome,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      responseId,
      updatedAt: now,
    },
  });
  if (changed.count !== 1)
    throw new ImportSessionError(ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN);
}
