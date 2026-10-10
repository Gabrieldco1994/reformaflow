import { Prisma } from "@prisma/client";

export function refundPurposeAccountScope(
  tenantId: string,
): Prisma.ExpenseWhereInput {
  return { rateioAsTarget: { none: { tenantId, isRefundCredit: true } } };
}

/** Marked refund source whose owned target is not visible in `projectIds` (null = every project). */
export function hiddenRefundSourceClause(
  tenantId: string,
  projectIds: string[] | null,
): Prisma.ExpenseWhereInput {
  const visibleTarget: Prisma.RateioAllocationWhereInput = {
    tenantId,
    isRefundCredit: true,
    target: {
      tenantId,
      deletedAt: null,
      project: { tenantId, deletedAt: null },
      ...(projectIds === null ? {} : { projectId: { in: projectIds } }),
    },
  };
  return {
    rateioAsSource: { some: { tenantId, isRefundCredit: true }, none: visibleTarget },
  };
}

/** Only marked credits change deduplication; ordinary positive mirrors keep their contract. */
export function refundPurposeScope(
  tenantId: string,
  projectIds: string[] | null,
  excludeOrdinaryMirrors = true,
): Prisma.ExpenseWhereInput {
  return {
    OR: [
      excludeOrdinaryMirrors
        ? { linkedExpenseId: null }
        : { rateioAsSource: { none: { tenantId, isRefundCredit: true } } },
      hiddenRefundSourceClause(tenantId, projectIds),
    ],
  };
}

/**
 * Composes an existing financial de-duplication filter (e.g. #701
 * `financialExpenseFilter`) with the #704 exception: a marked refund source
 * whose owned target is not visible in the lens still counts once. The base
 * filter keeps its own contract for every other row.
 */
export function withRefundPurposeScope(
  base: Prisma.ExpenseWhereInput,
  tenantId: string,
  projectIds: string[] | null,
): Prisma.ExpenseWhereInput {
  return { OR: [base, hiddenRefundSourceClause(tenantId, projectIds)] };
}

export const refundPurposeSourceSelect = {
  where: { isRefundCredit: true },
  select: {
    target: {
      select: {
        projectId: true,
        deletedAt: true,
        project: { select: { deletedAt: true } },
      },
    },
  },
} satisfies Prisma.RateioAllocationFindManyArgs;

export function isRedundantRefundSource(
  expense: {
    linkedExpenseId: string | null;
    rateioAsSource?: {
      target: {
        projectId: string;
        deletedAt: Date | null;
        project: { deletedAt: Date | null };
      };
    }[];
  } | null,
  projectIds: string[],
): boolean {
  if (!expense?.linkedExpenseId) return false;
  if (!expense.rateioAsSource?.length) return true;
  return expense.rateioAsSource.some(
    ({ target }) =>
      !target.deletedAt &&
      !target.project.deletedAt &&
      projectIds.includes(target.projectId),
  );
}

/**
 * A marked refund source whose owned target is NOT visible in the lens: it is the
 * only visible representation of the credit, so it must not be treated as a
 * mirror by any de-duplication (ordinary or #701 documented-schedule) rule.
 */
export function isHiddenRefundSource(
  expense: Parameters<typeof isRedundantRefundSource>[0],
  projectIds: string[],
): boolean {
  return (
    !!expense?.linkedExpenseId &&
    !!expense.rateioAsSource?.length &&
    !isRedundantRefundSource(expense, projectIds)
  );
}
