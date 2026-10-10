import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LEGACY_REPLACEMENT } from '../conciliacao/additive-settlement';
import { assertRateioRequester, RateioRequester } from './rateio.types';
import { refundCleanupFrom } from './refund-purpose.service';
import {
  assertCanMutateLinkedRowsFrom,
  assertRemovableProvenance,
  evaluateRateioParticipation,
  evaluateSettlementParticipation,
  evaluateUnratearSource,
  evaluateUnsettleBySource,
  loadRefundFacts,
  RemovalContext,
  uniqueIds,
} from './removal-context';

export type ExpenseRemovalPlan = {
  mode: 'ordinary' | 'refund' | 'rateio' | 'settlement';
  ids: string[];
};

/**
 * Prefetches every fact `decideRemoval` reads for `subjectIds`, inside the
 * caller's transaction, in a bounded number of chunked `IN` queries. Rows are
 * read fresh here; nothing is inherited from a list the caller already held.
 */
export async function loadRemovalFacts(
  tx: Prisma.TransactionClient,
  ctx: RemovalContext,
  subjectIds: string[],
  extra: { projectIds?: string[] } = {},
): Promise<void> {
  const subjects = uniqueIds(subjectIds);
  await ctx.loadExpenses(tx, subjects);
  await ctx.loadAllocations(tx, subjects);
  await ctx.loadSettlements(tx, subjects);
  await ctx.loadIncoming(tx, subjects);

  const live = subjects.flatMap((id) => {
    const row = ctx.liveExpense(id);
    return row ? [row] : [];
  });
  const linked = live.map((row) => row.linkedExpenseId);
  const mirrors = live.flatMap((row) =>
    ctx.mirrorsOf(row.id).map((mirror) => mirror.id),
  );
  const counterparts = [
    ...ctx.allocationsOf(subjects),
    ...ctx.settlementsOf(subjects),
  ].flatMap((row) => [row.sourceExpenseId, row.targetExpenseId]);
  const related = uniqueIds([...linked, ...mirrors, ...counterparts]);
  await ctx.loadExpenses(tx, related);
  await ctx.loadAllocations(tx, related);
  await ctx.loadSettlements(tx, related);
  await ctx.loadIncoming(tx, uniqueIds([...linked, ...mirrors]));
  await ctx.loadLedgerByExpense(tx, [...subjects, ...related]);

  const refundSources = subjects.filter((id) =>
    ctx
      .allocationsOf([id])
      .some((row) => row.sourceExpenseId === id && row.isRefundCredit),
  );
  if (refundSources.length) await loadRefundFacts(tx, ctx, refundSources);
  await ctx.loadReferencedProjects(tx, extra.projectIds ?? []);
}

/** Does deciding `subjectIds` need the session reloaded (negative rows / refund cleanup)? */
export function removalNeedsActor(
  ctx: RemovalContext,
  subjectIds: string[],
): boolean {
  return uniqueIds(subjectIds).some((id) => {
    const row = ctx.liveExpense(id);
    return (
      !!row &&
      (row.valorTotal < 0 ||
        ctx
          .allocationsOf([id])
          .some((edge) => edge.sourceExpenseId === id && edge.isRefundCredit))
    );
  });
}

/**
 * Pure removal decision — the ONE implementation behind `DELETE` and the
 * batched `canDelete` read. Ordering of checks (and therefore which policy
 * exception wins) is that of the historical `ExpenseService.prepareRemoval`.
 */
export function decideRemoval(
  ctx: RemovalContext,
  params: { projectId: string; id: string; requester: RateioRequester },
): ExpenseRemovalPlan {
  const { projectId, id } = params;
  let requester = params.requester;
  assertRateioRequester(
    requester,
    new NotFoundException('Despesa não encontrada'),
  );
  if (!ctx.liveProject(projectId))
    throw new NotFoundException('Projeto não encontrado');
  const expense = ctx.liveExpense(id);
  if (!expense || expense.projectId !== projectId)
    throw new NotFoundException('Despesa não encontrada');
  if (expense.valorTotal < 0) requester = ctx.resolvedActor();
  assertCanMutateLinkedRowsFrom(ctx, expense, requester);
  assertRemovableProvenance(expense, ctx.activePurchaseTrail([id]).size > 0);
  if (refundCleanupFrom(ctx, id, () => ctx.resolvedActor())) {
    return { mode: 'refund', ids: [id] };
  }

  const rateioRows = () => ctx.allocationsOf([id]);
  if (evaluateRateioParticipation(rateioRows(), id, true, false) === 'source') {
    evaluateUnratearSource(ctx, id, requester);
    return { mode: 'rateio', ids: [id] };
  }

  const activeSettlements = () => ctx.activeSettlementsOf([id]);
  if (
    evaluateSettlementParticipation(activeSettlements(), id, true, false) ===
    'source'
  ) {
    evaluateUnsettleBySource(ctx, id, requester, LEGACY_REPLACEMENT);
    return { mode: 'settlement', ids: [id] };
  }

  // Legacy 1:1: a simple pair is removed together; settlements stay isolated.
  const ids = new Set<string>([id]);
  const involvedInSettlement = (expenseId: string): boolean =>
    ctx.activeSettlementsOf([expenseId]).length > 0;
  // A cascade must not drag an active rateio participant along.
  const isRateioParticipant = (expenseId: string): boolean =>
    evaluateRateioParticipation(ctx.allocationsOf([expenseId]), expenseId, true, true) !==
    null;

  if (!involvedInSettlement(id)) {
    if (expense.linkedExpenseId) {
      const target = ctx.liveExpense(expense.linkedExpenseId);
      if (
        target &&
        !involvedInSettlement(target.id) &&
        !isRateioParticipant(target.id)
      ) {
        ids.add(target.id);
      }
    }
    for (const mirror of ctx.mirrorsOf(id)) {
      if (!involvedInSettlement(mirror.id) && !isRateioParticipant(mirror.id)) {
        ids.add(mirror.id);
      }
    }
  }

  const idArr = [...ids];
  // The cascade soft-deletes every id's cash flow: an active import claim cannot be dragged along.
  for (const cascadeId of idArr) {
    if (cascadeId === id) continue;
    const cascadeExpense = ctx.expense(cascadeId);
    if (cascadeExpense) {
      assertRemovableProvenance(
        cascadeExpense,
        ctx.activePurchaseTrail([cascadeId]).size > 0,
      );
    }
  }
  return { mode: 'ordinary', ids: idArr };
}
