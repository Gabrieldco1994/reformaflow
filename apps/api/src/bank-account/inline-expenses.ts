import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExpenseTypeLabels, LaborCategoryLabels, hasFeature, ProjectType, reconcileUserModules, isNeutralExpenseType } from '@reformaflow/domain';
import { parseGrantJson } from '../auth/grant-json';
import { ACL_NOT_FOUND_MESSAGE, BANK_ACCOUNT_MODULE, EXPENSE_MODULE, userCanAccessProject, userCanAccessProjectModule } from '../common/access-rules';
import { RateioRequester } from '../expense/rateio.types';
import { parseInlineSnapshotV1, serializeInlineSnapshotV1 } from './inline-snapshot-v1';

export interface InlineTarget {
  targetProjectId: string;
  tipoDespesa: string;
  titulo?: string;
  fornecedor?: string;
  categoriaMaoDeObra?: string;
  roomId?: string;
}
export interface InlineExpense {
  sourceExpenseId: string;
  targetExpenseId: string;
  targetProjectId: string;
  amountCents: number;
}
export interface InlineCreation extends InlineExpense {
  sourceProjectId: string;
  snapshot: string;
}
export const INLINE_IMPORT_DRIFT = 'INLINE_IMPORT_DRIFT';
export function invalidInline(): never {
  throw new BadRequestException({ code: 'INLINE_TARGET_INVALID', message: 'Revise o destino deste lançamento antes de importar.' });
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Multipart JSON does not pass through DTO validation. Keep strictness scoped to inline decisions. */
export function validateInlineDecisions(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalidInline();
  const ids = new Set<string>();
  for (const decision of value) {
    if (!object(decision) || !Object.prototype.hasOwnProperty.call(decision, 'newTarget')) continue;
    if (!text(decision.externalId) || ids.has(decision.externalId)) invalidInline();
    ids.add(decision.externalId);
    if (Object.keys(decision).some(k => !['externalId', 'action', 'newTarget', 'overrides'].includes(k))) invalidInline();
    if (decision.action !== undefined && !['create', 'skip'].includes(String(decision.action))) invalidInline();
    const target = decision.newTarget;
    if (!object(target) || Object.keys(target).some(k =>
      !['targetProjectId', 'tipoDespesa', 'titulo', 'fornecedor', 'categoriaMaoDeObra', 'roomId'].includes(k))) invalidInline();
    if (!text(target.targetProjectId) || !text(target.tipoDespesa) ||
        !Object.prototype.hasOwnProperty.call(ExpenseTypeLabels, target.tipoDespesa) || isNeutralExpenseType(target.tipoDespesa) ||
        target.tipoDespesa === 'INVESTIMENTOS') invalidInline();
    for (const key of ['titulo', 'fornecedor', 'categoriaMaoDeObra', 'roomId']) {
      if (target[key] !== undefined && (typeof target[key] !== 'string' || target[key].length > 200)) invalidInline();
    }
    if (target.roomId !== undefined && !text(target.roomId)) invalidInline();
    if (target.categoriaMaoDeObra !== undefined &&
        !Object.prototype.hasOwnProperty.call(LaborCategoryLabels, String(target.categoriaMaoDeObra))) invalidInline();
    if (decision.overrides !== undefined) {
      if (!object(decision.overrides) || Object.keys(decision.overrides).some(k =>
        !['titulo', 'valorCents', 'category'].includes(k))) invalidInline();
      if (decision.overrides.titulo !== undefined && typeof decision.overrides.titulo !== 'string') invalidInline();
      if (decision.overrides.category !== undefined &&
          (!text(decision.overrides.category) || !Object.prototype.hasOwnProperty.call(ExpenseTypeLabels, decision.overrides.category))) invalidInline();
    }
  }
  // Do not let a second, legacy-shaped decision overwrite an inline draft in the map.
  for (const id of ids) if (value.filter(d => object(d) && d.externalId === id).length !== 1) invalidInline();
}

export async function currentInlineRequester(
  tx: Prisma.TransactionClient, tenantId: string, requester: RateioRequester,
): Promise<RateioRequester & { id: string }> {
  if (!requester.id) throw new UnauthorizedException('Sessão inválida');
  const user = await tx.user.findUnique({ where: { id: requester.id }, include: { tenant: true } });
  if (!user || user.tenantId !== tenantId || user.deletedAt || user.tenant.deletedAt ||
      (user.isGuest && user.tenant.expiresAt && user.tenant.expiresAt <= new Date())) {
    throw new UnauthorizedException('Sessão inválida');
  }
  const modules = parseGrantJson(user.allowedModules);
  const projects = parseGrantJson(user.allowedProjects);
  const types = parseGrantJson(user.allowedProjectTypes);
  if (!modules.valid || !projects.valid || !types.valid) throw new UnauthorizedException('Sessão inválida');
  return { id: user.id, role: user.role, allowedProjects: projects.values,
    allowedProjectTypes: types.values, allowedModules: reconcileUserModules(modules.values, types.values) };
}

export function canUseInlineProject(requester: RateioRequester, project: { id: string; type: string }, module = EXPENSE_MODULE) {
  return userCanAccessProject(requester.role, requester.allowedProjects, project.id) &&
    userCanAccessProjectModule(requester.role, requester.allowedProjectTypes, requester.allowedModules ?? [], project.type, module);
}

export async function assertInlineProject(
  tx: Prisma.TransactionClient, tenantId: string, id: string, requester: RateioRequester, module = EXPENSE_MODULE,
) {
  const project = await tx.project.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!project || !canUseInlineProject(requester, project, module) ||
      (module === EXPENSE_MODULE && !hasFeature(project.type as ProjectType, 'expenses'))) {
    throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
  }
  return project;
}

export async function assertInlineAccount(
  tx: Prisma.TransactionClient, tenantId: string, projectId: string, accountId: string, requester: RateioRequester,
) {
  const project = await assertInlineProject(tx, tenantId, projectId, requester, BANK_ACCOUNT_MODULE);
  await assertInlineProject(tx, tenantId, projectId, requester);
  const account = await tx.bankAccount.findFirst({ where: { id: accountId, tenantId, projectId, deletedAt: null } });
  if (!account) {
    throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
  }
  return { ...project, account };
}

/** Full scalar state, cashflow and every financial dependency; IDs survive deleted edges in the ownership record. */
export async function inlineSnapshot(tx: Prisma.TransactionClient, tenantId: string, pair: InlineExpense) {
  const ids = [pair.sourceExpenseId, pair.targetExpenseId];
  const expenses = await tx.expense.findMany({
    where: { tenantId, id: { in: ids }, deletedAt: { not: undefined } },
    orderBy: { id: 'asc' },
    include: {
      cashFlow: { orderBy: { id: 'asc' }, where: { deletedAt: { not: undefined } } },
      rateioAsSource: { orderBy: { targetExpenseId: 'asc' } },
      rateioAsTarget: { orderBy: { targetExpenseId: 'asc' } },
      settlementsAsSource: { orderBy: { id: 'asc' } },
      settlementsAsTarget: { orderBy: { id: 'asc' } },
      financingInstallment: true,
      markers: { orderBy: { id: 'asc' } },
      importedInvoiceLiquidationsAsPayment: { orderBy: { id: 'asc' } },
      importedInvoiceLiquidationsAsPurchase: { orderBy: { id: 'asc' } },
    },
  });
  const dependents = await tx.expense.findMany({
    where: { tenantId, id: { notIn: ids }, OR: [
      { linkedExpenseId: { in: ids } }, { plannedExpenseId: { in: ids } }, { settledByExpenseId: { in: ids } },
    ] },
    orderBy: { id: 'asc' },
  });
  return { expenses, dependents };
}

/** ACL first, then drift. This read-only preflight runs before even invoice-ledger undo writes. */
export async function preflightInlineUndo(
  tx: Prisma.TransactionClient, tenantId: string, projectId: string, accountId: string,
  importId: string, raw: string, requester: RateioRequester, alreadyUndone = false,
): Promise<{ creations: InlineCreation[]; canUndo: boolean; blockReason: string | null }> {
  const actor = await currentInlineRequester(tx, tenantId, requester);
  await assertInlineAccount(tx, tenantId, projectId, accountId, actor);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new NotFoundException(ACL_NOT_FOUND_MESSAGE); }
  if (!object(value) || Object.keys(value).some(key => !['version', 'creations'].includes(key)) ||
      !Array.isArray(value.creations) || !value.creations.length) {
    throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
  }
  // Validate stable scope even when another protocol field is corrupt.
  for (const entry of value.creations) {
    if (object(entry) && text(entry.targetProjectId)) {
      await assertInlineProject(tx, tenantId, entry.targetProjectId, actor);
    }
    if (object(entry) && text(entry.sourceProjectId)) {
      await assertInlineProject(tx, tenantId, entry.sourceProjectId, actor);
    }
  }
  if (value.version !== 1) throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
  const creations: InlineCreation[] = [];
  const ids = new Set<string>();
  for (const entry of value.creations) {
    if (!object(entry) || Object.keys(entry).some(key => ![
      'sourceExpenseId', 'targetExpenseId', 'sourceProjectId', 'targetProjectId', 'amountCents', 'snapshot',
    ].includes(key)) || !text(entry.sourceExpenseId) || !text(entry.targetExpenseId) ||
        !text(entry.targetProjectId) || entry.sourceProjectId !== projectId ||
        entry.targetProjectId === projectId || !text(entry.snapshot) ||
        typeof entry.amountCents !== 'number' || !Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0 ||
        ids.has(entry.sourceExpenseId) || ids.has(entry.targetExpenseId)) throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
    const snapshot = parseInlineSnapshotV1(entry.snapshot);
    if (snapshot.expenses.length !== 2) throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
    for (const expense of snapshot.expenses) {
      if (expense.tenantId !== tenantId || !text(expense.projectId)) throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
      await assertInlineProject(tx, tenantId, expense.projectId, actor);
    }
    if (!snapshot.expenses.some(e => object(e) && e.id === entry.sourceExpenseId && e.projectId === projectId) ||
        !snapshot.expenses.some(e => object(e) && e.id === entry.targetExpenseId && e.projectId === entry.targetProjectId)) {
      throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
    }
    for (const dependent of snapshot.dependents) {
      if (!object(dependent) || dependent.tenantId !== tenantId || !text(dependent.projectId)) {
        throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
      }
      await assertInlineProject(tx, tenantId, dependent.projectId, actor);
    }
    ids.add(entry.sourceExpenseId); ids.add(entry.targetExpenseId);
    creations.push({ sourceExpenseId: entry.sourceExpenseId, targetExpenseId: entry.targetExpenseId,
      targetProjectId: entry.targetProjectId, sourceProjectId: projectId, amountCents: entry.amountCents,
      snapshot: serializeInlineSnapshotV1(snapshot) });
  }
  const states: Awaited<ReturnType<typeof inlineSnapshot>>[] = [];
  for (const pair of creations) {
    const state = await inlineSnapshot(tx, tenantId, pair);
    const relatedIds = new Set(state.expenses.flatMap(e => [
      e.linkedExpenseId, e.plannedExpenseId, e.settledByExpenseId,
      ...e.rateioAsSource.map(r => r.targetExpenseId), ...e.rateioAsTarget.map(r => r.sourceExpenseId),
      ...e.settlementsAsSource.map(r => r.targetExpenseId), ...e.settlementsAsTarget.map(r => r.sourceExpenseId),
      ...e.importedInvoiceLiquidationsAsPayment.map(r => r.purchaseExpenseId),
      ...e.importedInvoiceLiquidationsAsPurchase.map(r => r.paymentExpenseId),
    ]).filter((id): id is string => !!id));
    const related = await tx.expense.findMany({
      where: { tenantId, id: { in: [...relatedIds] }, deletedAt: { not: undefined } },
      select: { projectId: true },
    });
    const rooms = await tx.room.findMany({
      where: { id: { in: state.expenses.flatMap(e => e.roomId ? [e.roomId] : []) }, deletedAt: { not: undefined } },
      select: { projectId: true },
    });
    for (const id of new Set([
      ...state.expenses, ...state.dependents, ...related, ...rooms, ...state.expenses.flatMap(e => e.cashFlow),
    ].map(e => e.projectId))) {
      await assertInlineProject(tx, tenantId, id, actor);
    }
    states.push(state);
  }
  const intact = alreadyUndone || creations.every((pair, i) => {
    const source = states[i].expenses.find(e => e.id === pair.sourceExpenseId);
    const target = states[i].expenses.find(e => e.id === pair.targetExpenseId);
    return source?.projectId === projectId && source.importId === importId &&
      source.accountId === accountId && source.valorTotal === pair.amountCents &&
      target?.projectId === pair.targetProjectId && target.valorTotal === pair.amountCents &&
      target.importId === null && target.externalId === null && target.bankLast4 === null && target.cardLast4 === null &&
      serializeInlineSnapshotV1(states[i]) === pair.snapshot;
  });
  return { creations, canUndo: intact, blockReason: intact ? null : INLINE_IMPORT_DRIFT };
}

export function publicInlineExpenses(creations: InlineCreation[]): InlineExpense[] {
  return creations.map(({ sourceExpenseId, targetExpenseId, targetProjectId, amountCents }) =>
    ({ sourceExpenseId, targetExpenseId, targetProjectId, amountCents }));
}
