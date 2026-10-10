import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CashFlowEntry, Expense, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ExpenseScheduleOccurrence,
  buildInstallments,
  caixaMonthForCardPurchase,
  isInvoiceDueMonth,
  isSinglePaymentForm,
  resolveInstallmentIndex,
} from '@reformaflow/domain';
import { canonical } from '../common/canonical';
import {
  AMBIGUOUS_CARD_MESSAGE,
  resolveUniqueLegacyMatch,
} from '../common/invoice-identity';
import {
  ACL_NOT_FOUND_MESSAGE,
  projectTypeHasModule,
} from '../common/access-rules';
import {
  assertInlineProject,
  currentInlineRequester,
} from '../bank-account/inline-expenses';
import { guardActiveFunding } from '../conciliacao/additive-settlement';
import { INCLUDE_SOFT_DELETED, PrismaService } from '../prisma/prisma.service';
import {
  assertRateioRequester,
  RateioRequester,
} from '../expense/rateio.types';
import {
  parseStoredExpenseSchedule,
  parseMirrorCorrection,
  parseScheduleEvidenceInput,
  toPublicExpenseSchedule,
} from '../expense/documented-schedule';
import {
  ScheduleEvidenceInput,
  StoredProjectionScheduleV1,
  StoredSourceSchedule,
  MirrorCorrection,
  ScheduleAssistance,
  ASSISTED_CARD,
  ASSISTANCE_BASIS,
  REFERENCE_CHECK,
  EVIDENCE_KIND,
} from '../expense/documented-schedule.types';

export interface AssistedDocumentedScheduleScope {
  tenantId: string;
  projectId: string;
  cardId: string;
  expenseId: string;
}
interface Scope extends AssistedDocumentedScheduleScope {
  importId: string;
}
interface Change {
  cashFlowEntryId: string;
  amountCents?: number;
  invoiceDueMonth?: string;
  evidence: ScheduleEvidenceInput;
  allocationBreakdown?: Array<{
    allocationId: string;
    targetCashFlowEntryId: string;
    amountCents: number;
  }>;
  mirrorCorrection?: MirrorCorrection;
}
type CorrectionRequest = (
  | { mode: 'preview'; changes: Change[] }
  | {
      mode: 'apply';
      requestId: string;
      expectedFingerprint: string;
      changes: Change[];
    }
) & { assistance?: ScheduleAssistance };
type Tx = Prisma.TransactionClient;
const INT_MAX = 2_147_483_647;
const AUDIT_ACTION = 'expenses.documented-schedule';
const UNSELECTED_MIRROR_DRIFT = 'UNSELECTED_MIRROR_DRIFT';
const missing = () => new NotFoundException(ACL_NOT_FOUND_MESSAGE);
const conflict = () =>
  new ConflictException(
    'Cronograma ou vínculos alterados; revise a prévia documental.',
  );
const invalid = () => new BadRequestException('Correção documental inválida.');
const hash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const cents = (value: unknown, min = 1): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= INT_MAX;
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

function requestEvidence(value: unknown): ScheduleEvidenceInput {
  try {
    return parseScheduleEvidenceInput(value);
  } catch (error) {
    if (error instanceof RangeError) throw invalid();
    throw error;
  }
}

function request(body: unknown, assisted: boolean): CorrectionRequest {
  if (
    !object(body) ||
    !['preview', 'apply'].includes(String(body.mode)) ||
    !keys(body, [
      ...(body.mode === 'preview'
        ? ['mode', 'changes']
        : ['mode', 'changes', 'requestId', 'expectedFingerprint']),
      ...(assisted ? ['assistance'] : []),
    ]) ||
    !Array.isArray(body.changes) ||
    !body.changes.length
  )
    throw invalid();
  let assistance: ScheduleAssistance | undefined;
  if (assisted) {
    const value = body.assistance;
    if (
      !object(value) ||
      !keys(value, ['basis', 'reason', 'evidence']) ||
      (value.basis !== ASSISTANCE_BASIS.NONE &&
        value.basis !== ASSISTANCE_BASIS.ABSENT) ||
      !text(value.reason)
    )
      throw invalid();
    assistance = {
      basis: value.basis,
      reason: value.reason,
      evidence: requestEvidence(value.evidence),
    };
  }
  const changes: Change[] = body.changes.map((item: unknown) => {
    if (
      !object(item) ||
      !keys(item, [
        'cashFlowEntryId',
        'amountCents',
        'invoiceDueMonth',
        'evidence',
        'allocationBreakdown',
        'mirrorCorrection',
      ]) ||
      !text(item.cashFlowEntryId) ||
      (!('amountCents' in item) && !('invoiceDueMonth' in item)) ||
      ('amountCents' in item && !cents(item.amountCents)) ||
      ('invoiceDueMonth' in item && !isInvoiceDueMonth(item.invoiceDueMonth))
    )
      throw invalid();
    let mirrorCorrection: MirrorCorrection | undefined;
    if ('mirrorCorrection' in item) {
      if ('allocationBreakdown' in item || !cents(item.amountCents))
        throw invalid();
      try {
        mirrorCorrection = parseMirrorCorrection(item.mirrorCorrection);
      } catch (error) {
        if (error instanceof RangeError) throw invalid();
        throw error;
      }
      if (item.amountCents !== mirrorCorrection.after.sourceAmountCents)
        throw invalid();
    }
    let allocationBreakdown: Change['allocationBreakdown'];
    if ('allocationBreakdown' in item) {
      if (
        !Array.isArray(item.allocationBreakdown) ||
        !item.allocationBreakdown.length
      )
        throw invalid();
      allocationBreakdown = item.allocationBreakdown.map((cell: unknown) => {
        if (
          !object(cell) ||
          !keys(cell, [
            'allocationId',
            'targetCashFlowEntryId',
            'amountCents',
          ]) ||
          !text(cell.allocationId) ||
          !text(cell.targetCashFlowEntryId) ||
          !cents(cell.amountCents, 0)
        )
          throw invalid();
        return {
          allocationId: cell.allocationId,
          targetCashFlowEntryId: cell.targetCashFlowEntryId,
          amountCents: cell.amountCents,
        };
      });
    }
    return {
      cashFlowEntryId: item.cashFlowEntryId,
      ...(typeof item.amountCents === 'number'
        ? { amountCents: item.amountCents }
        : {}),
      ...(typeof item.invoiceDueMonth === 'string'
        ? { invoiceDueMonth: item.invoiceDueMonth }
        : {}),
      evidence: requestEvidence(item.evidence),
      ...(allocationBreakdown ? { allocationBreakdown } : {}),
      ...(mirrorCorrection ? { mirrorCorrection } : {}),
    };
  });
  if (
    new Set(changes.map((item) => item.cashFlowEntryId)).size !== changes.length
  )
    throw invalid();
  if (body.mode === 'preview')
    return { mode: 'preview', changes, ...(assistance ? { assistance } : {}) };
  if (
    !text(body.requestId) ||
    body.requestId.length > 200 ||
    !text(body.expectedFingerprint) ||
    !/^[a-f\d]{64}$/.test(body.expectedFingerprint)
  )
    throw invalid();
  return {
    mode: 'apply',
    requestId: body.requestId,
    expectedFingerprint: body.expectedFingerprint,
    changes,
    ...(assistance ? { assistance } : {}),
  };
}

function orderedEntries(expense: Expense, cash: CashFlowEntry[]) {
  const rows = cash.filter(
    (row) => row.expenseId === expense.id && row.deletedAt === null,
  );
  const schedule = toPublicExpenseSchedule(
    parseStoredExpenseSchedule(expense.documentedSchedule),
  );
  const count = isSinglePaymentForm(expense.formaPagamento)
    ? 1
    : expense.quantidadeParcela;
  if (
    !count ||
    rows.length !== count ||
    new Set(rows.map((row) => row.parcela)).size !== count ||
    rows.some(
      (row) =>
        row.tenantId !== expense.tenantId ||
        row.projectId !== expense.projectId ||
        row.tipo !== 'DESPESA' ||
        row.receiptId ||
        row.budgetAllocationId ||
        !cents(row.valor, 0) ||
        row.data.toISOString().slice(11) !== '00:00:00.000Z',
    ) ||
    rows.reduce((sum, row) => sum + row.valor, 0) !== expense.valorTotal ||
    !cents(expense.quantidade) ||
    expense.valor * expense.quantidade !== expense.valorTotal
  )
    throw conflict();
  if (schedule) {
    const installments = buildInstallments({ ...expense, schedule });
    rows.sort(
      (a, b) =>
        resolveInstallmentIndex(installments, a.parcela) -
        resolveInstallmentIndex(installments, b.parcela),
    );
    if (
      rows.some(
        (row, index) =>
          row.valor !== installments[index].valor ||
          row.data.getTime() !== installments[index].data.getTime() ||
          row.invoiceDueMonth !== installments[index].invoiceDueMonth,
      )
    )
      throw conflict();
  } else {
    rows.sort((a, b) =>
      (a.parcela ?? '').localeCompare(b.parcela ?? '', 'en', { numeric: true }),
    );
  }
  let paid: unknown = [];
  try {
    paid = expense.paidParcelas ? JSON.parse(expense.paidParcelas) : [];
  } catch (error) {
    if (error instanceof SyntaxError) throw conflict();
    throw error;
  }
  if (
    !Array.isArray(paid) ||
    paid.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= count,
    ) ||
    new Set(paid).size !== paid.length ||
    !['PAGO', 'PLANEJADO'].includes(expense.status)
  )
    throw conflict();
  const indices = new Set<number>(paid);
  if (
    rows.some(
      (row, index) =>
        row.status !==
        (expense.status === 'PAGO' || indices.has(index)
          ? 'PAGO'
          : 'PLANEJADO'),
    )
  )
    throw conflict();
  return rows;
}

function occurrence(
  row: CashFlowEntry,
  index: number,
): ExpenseScheduleOccurrence {
  return {
    index,
    parcela: row.parcela,
    valor: row.valor,
    data: row.data.toISOString().slice(0, 10),
    invoiceDueMonth: row.invoiceDueMonth,
  };
}

function expenseHashState(expense: Expense, sourceId: string) {
  if (expense.id !== sourceId || !expense.documentedSchedule) return expense;
  const stored = parseStoredExpenseSchedule(expense.documentedSchedule);
  return {
    ...expense,
    documentedSchedule:
      stored?.kind === 'source'
        ? {
            ...stored,
            lastOperation: stored.lastOperation
              ? { ...stored.lastOperation, resultingStateHash: null }
              : null,
          }
        : stored,
  };
}

@Injectable()
export class DocumentedScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  private async graph(
    tx: Tx,
    scope: Scope | AssistedDocumentedScheduleScope,
    requester: RateioRequester,
  ) {
    const actor = await currentInlineRequester(tx, scope.tenantId, requester);
    await assertInlineProject(tx, scope.tenantId, scope.projectId, actor);
    const project = await assertInlineProject(
      tx,
      scope.tenantId,
      scope.projectId,
      actor,
      'creditCards',
    );
    if (!projectTypeHasModule(project.type, 'creditCards')) throw missing();
    const card = await tx.creditCard.findFirst({
      where: {
        id: scope.cardId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        deletedAt: null,
      },
    });
    const batch =
      'importId' in scope
        ? await tx.creditCardStatementImport.findFirst({
            where: {
              id: scope.importId,
              tenantId: scope.tenantId,
              cardId: scope.cardId,
              status: 'COMPLETED',
              deletedAt: null,
            },
          })
        : null;
    const source = await tx.expense.findFirst({
      where: {
        id: scope.expenseId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        ...('importId' in scope ? { importId: scope.importId } : {}),
        deletedAt: null,
      },
    });
    if (
      !card ||
      ('importId' in scope && !batch) ||
      !source ||
      source.cardLast4 !== card.last4
    )
      throw missing();
    // Only the authorized source supplies this marker. Existence probes deliberately
    // include deleted/foreign records and return no data beyond their primary keys.
    let admission: {
      basis: ScheduleAssistance['basis'];
      originalImportId: string | null;
      originalExternalId: string | null;
      referenceCheck: (typeof REFERENCE_CHECK)[keyof typeof REFERENCE_CHECK];
    } | null = null;
    if (!('importId' in scope)) {
      const identity = resolveUniqueLegacyMatch(
        await tx.creditCard.findMany({
          where: {
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            last4: source.cardLast4!,
            deletedAt: null,
          },
          select: { id: true },
          take: 2,
        }),
        AMBIGUOUS_CARD_MESSAGE,
      );
      if (identity?.id !== card.id) throw missing();
      if (source.importId !== null) {
        if (!text(source.importId)) throw missing();
        const cardImport = await tx.creditCardStatementImport.findUnique({
          where: { id: source.importId },
          select: { id: true },
        });
        const bankImport = await tx.bankStatementImport.findUnique({
          where: { id: source.importId },
          select: { id: true },
        });
        if (cardImport || bankImport) throw missing();
      }
      admission = {
        basis:
          source.importId === null
            ? ASSISTANCE_BASIS.NONE
            : ASSISTANCE_BASIS.ABSENT,
        originalImportId: source.importId,
        originalExternalId: source.externalId,
        referenceCheck:
          source.importId === null
            ? REFERENCE_CHECK.NONE
            : REFERENCE_CHECK.ABSENT,
      };
    }
    const ids = new Set([source.id]);
    for (;;) {
      const selected = [...ids];
      const expenses = await tx.expense.findMany({
        where: {
          tenantId: scope.tenantId,
          OR: [
            { id: { in: selected } },
            { linkedExpenseId: { in: selected } },
            { plannedExpenseId: { in: selected } },
            { settledByExpenseId: { in: selected } },
          ],
          deletedAt: INCLUDE_SOFT_DELETED,
        },
        orderBy: { id: 'asc' },
      });
      if (selected.some((id) => !expenses.some((row) => row.id === id)))
        throw missing();
      for (const expense of expenses) {
        if (expense.deletedAt) throw missing();
        await assertInlineProject(tx, scope.tenantId, expense.projectId, actor);
        ids.add(expense.id);
        for (const id of [
          expense.linkedExpenseId,
          expense.plannedExpenseId,
          expense.settledByExpenseId,
        ])
          if (id) ids.add(id);
      }
      const allocations = await tx.rateioAllocation.findMany({
        where: {
          tenantId: scope.tenantId,
          OR: [
            { sourceExpenseId: { in: selected } },
            { targetExpenseId: { in: selected } },
          ],
        },
        orderBy: { id: 'asc' },
      });
      const funding = await tx.crossProjectSettlement.findMany({
        where: {
          tenantId: scope.tenantId,
          OR: [
            { sourceExpenseId: { in: selected } },
            { targetExpenseId: { in: selected } },
          ],
        },
        orderBy: { id: 'asc' },
      });
      const cash = await tx.cashFlowEntry.findMany({
        where: {
          tenantId: scope.tenantId,
          expenseId: { in: selected },
          deletedAt: INCLUDE_SOFT_DELETED,
        },
        orderBy: { id: 'asc' },
      });
      const claims = await tx.importedInvoiceLiquidation.findMany({
        where: {
          tenantId: scope.tenantId,
          OR: [
            { purchaseExpenseId: { in: selected } },
            { paymentExpenseId: { in: selected } },
            { cashFlowEntryId: { in: cash.map((row) => row.id) } },
          ],
          deletedAt: INCLUDE_SOFT_DELETED,
        },
        orderBy: { id: 'asc' },
      });
      for (const row of [
        ...allocations,
        ...funding.filter((row) => row.reversedAt === null),
      ]) {
        ids.add(row.sourceExpenseId);
        ids.add(row.targetExpenseId);
      }
      for (const row of claims.filter((row) => row.deletedAt === null)) {
        ids.add(row.purchaseExpenseId);
        ids.add(row.paymentExpenseId);
      }
      if (ids.size === selected.length)
        return {
          actor,
          project,
          card,
          batch,
          ...(admission ? { admission } : {}),
          source,
          expenses,
          allocations,
          funding,
          cash,
          claims,
        };
    }
  }

  correct(
    scope: Scope,
    requester: RateioRequester,
    body: unknown,
  ): ReturnType<DocumentedScheduleService['execute']> {
    return this.execute(scope, requester, body);
  }

  correctAssisted(
    scope: AssistedDocumentedScheduleScope,
    requester: RateioRequester,
    body: unknown,
  ): ReturnType<DocumentedScheduleService['correct']> {
    return this.execute(scope, requester, body);
  }

  private async execute(
    scope: Scope | AssistedDocumentedScheduleScope,
    requester: RateioRequester,
    body: unknown,
  ) {
    assertRateioRequester(requester, missing());
    if (Object.values(scope).some((value) => !text(value))) throw missing();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Reserve the tenant's SQLite writer before reading authorization or financial state.
          if (object(body) && body.mode === 'apply') {
            await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${scope.tenantId}`;
          }
          const graph = await this.graph(tx, scope, requester);
          const dto = request(body, !('importId' in scope));
          if (dto.assistance && dto.assistance.basis !== graph.admission?.basis)
            throw invalid();
          const {
            source,
            expenses,
            allocations,
            funding,
            cash,
            claims,
            actor,
          } = graph;
          // A supplied artifact identifies the claimed attester, not authenticated
          // authorship. Validate current tenant/ACL separately from the applying
          // actor, even on exact retries, without rewriting either attribution.
          const attesters = new Map<string, RateioRequester>();
          for (const proof of [
            ...dto.changes.map((change) => change.evidence),
            ...(dto.assistance ? [dto.assistance.evidence] : []),
          ]) {
            if (proof.evidenceKind !== EVIDENCE_KIND.USER_ATTESTATION) continue;
            if (new Date(proof.attestedAt).getTime() > Date.now())
              throw invalid();
            if (attesters.has(proof.attestedByUserId)) continue;
            let attester: RateioRequester;
            try {
              attester = await currentInlineRequester(tx, scope.tenantId, {
                id: proof.attestedByUserId,
              });
            } catch (error) {
              if (error instanceof UnauthorizedException) throw missing();
              throw error;
            }
            await assertInlineProject(
              tx,
              scope.tenantId,
              scope.projectId,
              attester,
              'creditCards',
            );
            for (const projectId of new Set(
              expenses.map((expense) => expense.projectId),
            ))
              await assertInlineProject(
                tx,
                scope.tenantId,
                projectId,
                attester,
              );
            attesters.set(proof.attestedByUserId, attester);
          }
          const assertSelectedScope = (): void => {
            for (const change of dto.changes) {
              if (
                !cash.some(
                  (row) =>
                    row.id === change.cashFlowEntryId &&
                    row.expenseId === source.id &&
                    row.deletedAt === null,
                )
              )
                throw missing();
              for (const cell of change.allocationBreakdown ?? []) {
                const allocation = allocations.find(
                  (row) =>
                    row.id === cell.allocationId &&
                    row.sourceExpenseId === source.id,
                );
                if (
                  !allocation ||
                  !cash.some(
                    (row) =>
                      row.id === cell.targetCashFlowEntryId &&
                      row.expenseId === allocation.targetExpenseId &&
                      row.deletedAt === null,
                  )
                )
                  throw missing();
              }
              if (
                change.mirrorCorrection &&
                !cash.some(
                  (row) =>
                    row.id === change.mirrorCorrection!.targetCashFlowEntryId &&
                    row.expenseId !== source.id &&
                    row.deletedAt === null,
                )
              )
                throw missing();
            }
          };
          if (dto.mode === 'preview') assertSelectedScope();
          const stored = parseStoredExpenseSchedule(source.documentedSchedule);
          if (
            stored &&
            (stored.kind !== 'source' ||
              stored.tenantId !== scope.tenantId ||
              stored.sourceExpenseId !== source.id ||
              stored.sourceProjectId !== scope.projectId ||
              stored.cardId !== scope.cardId ||
              ('importId' in scope
                ? stored.version !== 1 ||
                  stored.importId !== scope.importId ||
                  stored.externalId !== source.externalId
                : stored.version !== 2 ||
                  stored.provenance.originalImportId !== source.importId ||
                  stored.provenance.originalExternalId !== source.externalId ||
                  stored.provenance.basis !== graph.admission?.basis))
          )
            throw conflict();
          const payloadHash = hash(
            dto.assistance
              ? { changes: dto.changes, assistance: dto.assistance }
              : dto.changes,
          );
          const state = () => ({
            ...graph,
            actor: undefined,
            source: undefined,
            expenses: expenses.map((expense) =>
              expenseHashState(expense, source.id),
            ),
          });
          const currentHash = hash(state());
          if (
            dto.mode === 'apply' &&
            stored?.kind === 'source' &&
            stored.lastOperation?.requestId === dto.requestId
          ) {
            if (
              stored.lastOperation.payloadHash !== payloadHash ||
              stored.lastOperation.resultingStateHash !== currentHash
            )
              throw conflict();
            return { alreadyApplied: true, applied: false };
          }
          const fingerprint = hash({
            state: state(),
            actor,
            changes: dto.changes,
            ...(dto.assistance ? { assistance: dto.assistance } : {}),
            ...(attesters.size ? { attesters: [...attesters.values()] } : {}),
          });
          if (dto.mode === 'apply' && dto.expectedFingerprint !== fingerprint)
            throw conflict();
          if (dto.mode === 'apply') assertSelectedScope();
          if (
            ('importId' in scope && !source.externalId) ||
            source.externalId?.startsWith('m1:') ||
            source.valorTotal <= 0 ||
            source.bankLast4 ||
            source.accountId ||
            source.recorrente ||
            source.recurrenceKey ||
            source.plannedExpenseId ||
            source.settledByExpenseId ||
            source.settlesInvoiceKey ||
            source.tipoDespesa === 'PAGAMENTO_FATURA_CARTAO'
          )
            throw conflict();
          const sourceAllocations = allocations.filter(
            (row) => row.sourceExpenseId === source.id,
          );
          const linked = expenses.filter(
            (row) =>
              row.id !== source.id &&
              (source.linkedExpenseId === row.id ||
                row.linkedExpenseId === source.id),
          );
          const targetIds = sourceAllocations.length
            ? sourceAllocations.map((row) => row.targetExpenseId)
            : linked.map((row) => row.id);
          if (
            new Set(targetIds).size !== targetIds.length ||
            (!sourceAllocations.length && targetIds.length > 1) ||
            allocations.some((row) => row.sourceExpenseId !== source.id) ||
            (sourceAllocations.length &&
              linked.some((row) => !targetIds.includes(row.id)))
          )
            throw conflict();
          const participants = [
            source,
            ...targetIds.map((id) => expenses.find((row) => row.id === id)!),
          ];
          for (const target of participants.slice(1)) {
            const projection = parseStoredExpenseSchedule(
              target.documentedSchedule,
            );
            const allocation = sourceAllocations.find(
              (row) => row.targetExpenseId === target.id,
            );
            if (
              target.plannedExpenseId ||
              target.settledByExpenseId ||
              (projection &&
                (projection.kind !== 'projection' ||
                  projection.tenantId !== scope.tenantId ||
                  projection.sourceExpenseId !== source.id ||
                  projection.sourceProjectId !== source.projectId ||
                  projection.cardId !== scope.cardId ||
                  projection.targetExpenseId !== target.id ||
                  projection.targetProjectId !== target.projectId ||
                  projection.via !== (allocation ? 'rateio' : 'mirror') ||
                  projection.allocationId !== (allocation?.id ?? null))) ||
              (target.linkedExpenseId &&
                target.linkedExpenseId !== source.id) ||
              expenses.some(
                (row) =>
                  row.id !== source.id &&
                  row.id !== target.id &&
                  row.linkedExpenseId === target.id,
              )
            )
              throw conflict();
          }
          const participantIds = participants.map((row) => row.id);
          await guardActiveFunding(tx, scope.tenantId, participantIds);
          if (
            funding.some(
              (row) =>
                row.reversedAt === null &&
                (participantIds.includes(row.sourceExpenseId) ||
                  participantIds.includes(row.targetExpenseId)),
            )
          )
            throw conflict();
          const rows = new Map(
            participants.map((expense) => [
              expense.id,
              orderedEntries(expense, cash),
            ]),
          );
          const sourceRows = rows.get(source.id)!;
          if (
            sourceRows.some((row) => row.valor <= 0) ||
            dto.changes.length > sourceRows.length
          )
            throw conflict();
          if (
            participants.some(
              (expense) => rows.get(expense.id)!.length !== sourceRows.length,
            )
          )
            throw conflict();
          if (
            sourceAllocations.length &&
            (sourceAllocations.reduce((sum, row) => sum + row.allocation, 0) !==
              source.valorTotal ||
              sourceAllocations.some(
                (row) =>
                  row.allocation !==
                  participants.find((e) => e.id === row.targetExpenseId)!
                    .valorTotal,
              ))
          )
            throw conflict();
          const indices = new Map(
            dto.changes.map((change) => {
              const index = sourceRows.findIndex(
                (row) => row.id === change.cashFlowEntryId,
              );
              if (index < 0) throw missing();
              return [index, change];
            }),
          );
          const mirrorChanges = dto.changes.filter(
            (change) => change.mirrorCorrection,
          );
          for (const [index, change] of indices) {
            const matrix = change.mirrorCorrection;
            if (!matrix) continue;
            if (sourceAllocations.length || targetIds.length !== 1)
              throw conflict();
            const targetRow = rows.get(targetIds[0])![index];
            if (
              matrix.targetCashFlowEntryId !== targetRow.id ||
              matrix.before.sourceAmountCents !== sourceRows[index].valor ||
              matrix.before.targetAmountCents !== targetRow.valor
            )
              throw conflict();
          }
          const unselectedOccurrenceIndices: number[] = [];
          for (let index = 0; index < sourceRows.length; index++) {
            const sum = participants
              .slice(1)
              .reduce(
                (sum, target) => sum + rows.get(target.id)![index].valor,
                0,
              );
            if (
              targetIds.length &&
              sum !== sourceRows[index].valor &&
              !(
                sourceAllocations.length > 1 &&
                indices.get(index)?.allocationBreakdown
              ) &&
              !indices.get(index)?.mirrorCorrection
            )
              if (mirrorChanges.length && !indices.has(index))
                unselectedOccurrenceIndices.push(index);
              else throw conflict();
          }
          const assertMutable = (row: CashFlowEntry) => {
            if (
              row.status !== 'PLANEJADO' ||
              claims.some(
                (claim) =>
                  claim.deletedAt === null && claim.cashFlowEntryId === row.id,
              )
            )
              throw conflict();
          };
          for (const index of indices.keys()) assertMutable(sourceRows[index]);
          const requiresAllocationBreakdown =
            sourceAllocations.length > 1 &&
            dto.changes.some((change) => !change.allocationBreakdown);
          if (requiresAllocationBreakdown) {
            if (dto.mode === 'apply') throw conflict();
            return {
              fingerprint,
              requiresAllocationBreakdown: true,
              applicable: false,
            };
          }
          const next = new Map(
            participants.map((expense) => [
              expense.id,
              rows.get(expense.id)!.map(occurrence),
            ]),
          );
          for (const [index, change] of indices) {
            const sourceCell = next.get(source.id)![index];
            sourceCell.valor = change.amountCents ?? sourceCell.valor;
            sourceCell.invoiceDueMonth =
              change.invoiceDueMonth ?? sourceCell.invoiceDueMonth;
            const cells = change.allocationBreakdown;
            if (
              cells &&
              (cells.length !== sourceAllocations.length ||
                new Set(cells.map((cell) => cell.allocationId)).size !==
                  cells.length ||
                new Set(cells.map((cell) => cell.targetCashFlowEntryId))
                  .size !== cells.length)
            )
              throw invalid();
            for (const target of participants.slice(1)) {
              const targetRow = rows.get(target.id)![index];
              const allocation = sourceAllocations.find(
                (row) => row.targetExpenseId === target.id,
              );
              const cell = cells?.find(
                (item) => item.allocationId === allocation?.id,
              );
              if (
                cells &&
                (!cell || cell.targetCashFlowEntryId !== targetRow.id)
              )
                throw invalid();
              const targetCell = next.get(target.id)![index];
              targetCell.valor = cell?.amountCents ?? sourceCell.valor;
              targetCell.invoiceDueMonth = sourceCell.invoiceDueMonth;
              if (
                targetCell.valor !== targetRow.valor ||
                targetCell.invoiceDueMonth !== targetRow.invoiceDueMonth
              )
                assertMutable(targetRow);
            }
            if (
              targetIds.length &&
              participants
                .slice(1)
                .reduce((sum, e) => sum + next.get(e.id)![index].valor, 0) !==
                sourceCell.valor
            )
              throw invalid();
          }
          if (unselectedOccurrenceIndices.length) {
            if (dto.mode === 'apply') throw conflict();
            return {
              fingerprint,
              applicable: false,
              reason: UNSELECTED_MIRROR_DRIFT,
              unselectedOccurrenceIndices,
            };
          }
          const totals = new Map(
            participants.map((expense) => {
              const total = next
                .get(expense.id)!
                .reduce((sum, item) => sum + item.valor, 0);
              if (
                !cents(total, expense.id === source.id ? 1 : 0) ||
                !Number.isInteger(total / expense.quantidade)
              )
                throw conflict();
              const allocation = sourceAllocations.find(
                (row) => row.targetExpenseId === expense.id,
              );
              if (
                allocation &&
                allocation.plannedValorTotal === null &&
                total !== expense.valorTotal
              )
                throw conflict();
              return [expense.id, total];
            }),
          );
          const response = {
            fingerprint,
            requiresAllocationBreakdown: false,
            applicable: true,
            beforeTotalCents: source.valorTotal,
            afterTotalCents: totals.get(source.id)!,
            changes: [...indices].map(([index]) => ({
              cashFlowEntryId: sourceRows[index].id,
              before: occurrence(sourceRows[index], index),
              after: next.get(source.id)![index],
            })),
            affectedCycles: [
              ...new Set(
                [...indices.keys()].flatMap((index) =>
                  [sourceRows[index], next.get(source.id)![index]].map((row) =>
                    caixaMonthForCardPurchase(
                      row.data,
                      graph.card.closingDay,
                      graph.card.dueDay,
                      row.invoiceDueMonth,
                    ),
                  ),
                ),
              ),
            ].sort(),
          };
          if (dto.mode === 'preview') return response;
          const auditAction = `${AUDIT_ACTION}:${source.id}:${dto.requestId}`;
          if (
            await tx.userActivityLog.count({
              where: {
                tenantId: scope.tenantId,
                action: auditAction,
                createdAt: { gte: source.createdAt },
              },
            })
          )
            throw conflict();
          const now = new Date();
          const base = {
            version: 1 as const,
            tenantId: scope.tenantId,
            sourceExpenseId: source.id,
            sourceProjectId: source.projectId,
            cardId: scope.cardId,
            recordedByUserId: actor.id,
            recordedAt: now.toISOString(),
          };
          const schedule: StoredSourceSchedule = {
            ...base,
            kind: 'source',
            ...('importId' in scope
              ? { importId: scope.importId, externalId: source.externalId! }
              : {
                  version: 2 as const,
                  provenance: {
                    kind: ASSISTED_CARD,
                    originalExternalId: source.externalId,
                    reason: dto.assistance!.reason,
                    evidence: {
                      ...dto.assistance!.evidence,
                      actorUserId: actor.id,
                      recordedAt: now.toISOString(),
                    },
                    ...(source.importId === null
                      ? {
                          basis: ASSISTANCE_BASIS.NONE,
                          originalImportId: null,
                          referenceCheck: REFERENCE_CHECK.NONE,
                        }
                      : {
                          basis: ASSISTANCE_BASIS.ABSENT,
                          originalImportId: source.importId,
                          referenceCheck: REFERENCE_CHECK.ABSENT,
                          checkedAt: now.toISOString(),
                        }),
                  },
                }),
            occurrences: next.get(source.id)!.map((item) => {
              const change = indices.get(item.index);
              const proof = change
                ? {
                    ...change.evidence,
                    actorUserId: actor.id,
                    recordedAt: now.toISOString(),
                  }
                : null;
              const old =
                stored?.kind === 'source'
                  ? stored.occurrences[item.index]
                  : undefined;
              return {
                ...item,
                amountEvidence:
                  change?.amountCents !== undefined
                    ? proof
                    : (old?.amountEvidence ?? null),
                cycleEvidence:
                  change?.invoiceDueMonth !== undefined
                    ? proof
                    : (old?.cycleEvidence ?? null),
              };
            }),
            projections: participants.slice(1).map((target) => {
              const allocation = sourceAllocations.find(
                (row) => row.targetExpenseId === target.id,
              );
              const occurrenceMap = sourceRows.map((_, index) => ({
                sourceIndex: index,
                targetIndex: index,
              }));
              return allocation
                ? {
                    kind: 'rateio',
                    allocationId: allocation.id,
                    targetExpenseId: target.id,
                    occurrenceMap,
                  }
                : { kind: 'mirror', targetExpenseId: target.id, occurrenceMap };
            }),
            lastOperation: {
              requestId: dto.requestId,
              payloadHash,
              resultingStateHash: '0'.repeat(64),
              actorUserId: actor.id,
              recordedAt: now.toISOString(),
              ...(mirrorChanges.length
                ? {
                    mirrorCorrections: mirrorChanges.map((change) => ({
                      cashFlowEntryId: change.cashFlowEntryId,
                      ...change.mirrorCorrection!,
                    })),
                  }
                : {}),
            },
          };
          const sourceBeforeReceipt = JSON.stringify(schedule);
          for (const expense of participants) {
            let documentedSchedule: string;
            if (expense.id === source.id)
              documentedSchedule = sourceBeforeReceipt;
            else {
              const allocation = sourceAllocations.find(
                (row) => row.targetExpenseId === expense.id,
              );
              const projection: StoredProjectionScheduleV1 = {
                ...base,
                kind: 'projection',
                targetExpenseId: expense.id,
                targetProjectId: expense.projectId,
                occurrences: next
                  .get(expense.id)!
                  .map((item) => ({ ...item, sourceIndex: item.index })),
                ...(allocation
                  ? { via: 'rateio', allocationId: allocation.id }
                  : { via: 'mirror', allocationId: null }),
              };
              documentedSchedule = JSON.stringify(projection);
            }
            parseStoredExpenseSchedule(documentedSchedule);
            const updated = await tx.expense.updateMany({
              where: {
                id: expense.id,
                tenantId: scope.tenantId,
                projectId: expense.projectId,
                deletedAt: null,
                updatedAt: expense.updatedAt,
                valorTotal: expense.valorTotal,
                documentedSchedule: expense.documentedSchedule,
              },
              data: {
                valorTotal: totals.get(expense.id),
                valor: totals.get(expense.id)! / expense.quantidade,
                documentedSchedule,
                updatedAt: now,
              },
            });
            if (updated.count !== 1) throw conflict();
            for (const [index, row] of rows.get(expense.id)!.entries()) {
              const value = next.get(expense.id)![index];
              if (
                value.valor === row.valor &&
                value.invoiceDueMonth === row.invoiceDueMonth
              )
                continue;
              const result = await tx.cashFlowEntry.updateMany({
                where: {
                  id: row.id,
                  tenantId: scope.tenantId,
                  expenseId: expense.id,
                  deletedAt: null,
                  valor: row.valor,
                  invoiceDueMonth: row.invoiceDueMonth,
                  status: row.status,
                  updatedAt: row.updatedAt,
                },
                data: {
                  valor: value.valor,
                  invoiceDueMonth: value.invoiceDueMonth,
                  updatedAt: now,
                },
              });
              if (result.count !== 1) throw conflict();
            }
          }
          for (const allocation of sourceAllocations) {
            const result = await tx.rateioAllocation.updateMany({
              where: {
                id: allocation.id,
                tenantId: scope.tenantId,
                sourceExpenseId: source.id,
                targetExpenseId: allocation.targetExpenseId,
                allocation: allocation.allocation,
              },
              data: { allocation: totals.get(allocation.targetExpenseId) },
            });
            if (result.count !== 1) throw conflict();
          }
          const after = await this.graph(tx, scope, requester);
          schedule.lastOperation!.resultingStateHash = hash({
            ...after,
            actor: undefined,
            source: undefined,
            expenses: after.expenses.map((expense) =>
              expenseHashState(expense, source.id),
            ),
          });
          const receipt = await tx.expense.updateMany({
            where: {
              id: source.id,
              tenantId: scope.tenantId,
              deletedAt: null,
              documentedSchedule: sourceBeforeReceipt,
            },
            data: {
              documentedSchedule: JSON.stringify(schedule),
              updatedAt: now,
            },
          });
          if (receipt.count !== 1) throw conflict();
          await tx.userActivityLog.create({
            data: {
              tenantId: scope.tenantId,
              userId: actor.id,
              action: auditAction,
            },
          });
          return { ...response, applied: true, alreadyApplied: false };
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2028', 'P2034', 'P1008'].includes(error.code)
      )
        throw conflict();
      throw error;
    }
  }
}
