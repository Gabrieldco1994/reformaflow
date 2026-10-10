import {
  ExpenseScheduleV1,
  isInvoiceDueMonth,
  parseExpenseSchedule,
  buildInstallments,
  InstallmentInput,
} from '@reformaflow/domain';
import {
  ScheduleEvidence,
  ScheduleOperationReceipt,
  ScheduleProjectionRef,
  StoredExpenseSchedule,
  DocumentaryCycle,
  AssistedCardProvenance,
  ASSISTED_CARD,
  ASSISTANCE_BASIS,
  REFERENCE_CHECK,
  MirrorCorrection,
  EVIDENCE_KIND,
  ScheduleEvidenceInput,
} from './documented-schedule.types';
import type { Prisma } from '@prisma/client';

const INVALID_SCHEDULE = 'Invalid documented expense schedule';
export function buildStoredExpenseInstallments(
  input: InstallmentInput & { documentedSchedule: string | null },
) {
  return buildInstallments({
    ...input,
    schedule: toPublicExpenseSchedule(
      parseStoredExpenseSchedule(input.documentedSchedule),
    ),
  });
}

export function financialMirrorIds(
  expenses: ReadonlyArray<{
    id: string;
    linkedExpenseId: string | null;
    documentedSchedule?: string | null;
  }>,
): Set<string> {
  const byId = new Map(expenses.map((expense) => [expense.id, expense]));
  const reverse = new Map<string, string[]>();
  for (const expense of expenses) {
    if (!expense.linkedExpenseId) continue;
    const ids = reverse.get(expense.linkedExpenseId) ?? [];
    ids.push(expense.id);
    reverse.set(expense.linkedExpenseId, ids);
  }
  const mirrors = new Set(
    expenses
      .filter(
        (expense) => !expense.documentedSchedule && expense.linkedExpenseId,
      )
      .map((expense) => expense.id),
  );
  for (const expense of expenses) {
    const schedule = parseStoredExpenseSchedule(expense.documentedSchedule);
    if (schedule?.kind !== 'source') continue;
    const targets = new Set([
      ...schedule.projections.map((ref) => ref.targetExpenseId),
      ...(expense.linkedExpenseId ? [expense.linkedExpenseId] : []),
      ...(reverse.get(expense.id) ?? []),
    ]);
    if (!targets.size) continue;
    const allVisible = [...targets].every((id) => byId.has(id));
    if (allVisible) mirrors.add(expense.id);
    else mirrors.delete(expense.id);
    for (const id of targets) {
      if (allVisible) mirrors.delete(id);
      else if (byId.has(id)) mirrors.add(id);
    }
  }
  return mirrors;
}

export async function financialExpenseFilter(
  db: Pick<Prisma.TransactionClient, 'expense'>,
  tenantId: string,
  projectIds: readonly string[] | null,
): Promise<Prisma.ExpenseWhereInput> {
  if (projectIds?.length === 0) return { linkedExpenseId: null };
  const expenses = await db.expense.findMany({
    where: {
      tenantId,
      deletedAt: null,
      ...(projectIds ? { projectId: { in: [...projectIds] } } : {}),
    },
    select: { id: true, linkedExpenseId: true, documentedSchedule: true },
  });
  if (!expenses.some((expense) => expense.documentedSchedule != null))
    return { linkedExpenseId: null };
  return { id: { notIn: [...financialMirrorIds(expenses)] } };
}

const PUBLIC_FIELDS = ['index', 'parcela', 'valor', 'data', 'invoiceDueMonth'];
const BASE_FIELDS = [
  'version',
  'kind',
  'tenantId',
  'sourceExpenseId',
  'sourceProjectId',
  'cardId',
  'recordedByUserId',
  'recordedAt',
  'occurrences',
];

function invalid(): never {
  throw new RangeError(INVALID_SCHEDULE);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return Object.fromEntries(Object.entries(value));
}

function fields(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid();
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result)
    return invalid();
  return result;
}

function hash(value: unknown): string {
  const result = text(value);
  if (!/^[a-f\d]{64}$/i.test(result)) return invalid();
  return result;
}

function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
}

export function parseDocumentaryCycle(value: unknown): DocumentaryCycle {
  const item = record(value);
  fields(item, ['invoiceDueMonth', 'evidence']);
  if (!isInvoiceDueMonth(item.invoiceDueMonth)) return invalid();
  const proof = parseScheduleEvidenceInput(item.evidence);
  // Import overrides remain documentary; attestation admission belongs to the
  // existing-purchase correction, where current identities and graph ACL run.
  if (proof.evidenceKind === EVIDENCE_KIND.USER_ATTESTATION) return invalid();
  return {
    invoiceDueMonth: item.invoiceDueMonth,
    evidence: proof,
  };
}

export function parseScheduleEvidenceInput(
  value: unknown,
): ScheduleEvidenceInput {
  const item = record(value);
  const attestation = item.evidenceKind === EVIDENCE_KIND.USER_ATTESTATION;
  fields(item, [
    'documentSha256',
    'reference',
    ...('evidenceKind' in item ? ['evidenceKind'] : []),
    ...(attestation ? ['attestedByUserId', 'attestedAt'] : []),
  ]);
  const artifact = {
    documentSha256: hash(item.documentSha256),
    reference: text(item.reference),
  };
  if (attestation)
    return {
      ...artifact,
      evidenceKind: EVIDENCE_KIND.USER_ATTESTATION,
      attestedByUserId: text(item.attestedByUserId),
      attestedAt: timestamp(item.attestedAt),
    };
  if (!('evidenceKind' in item)) return artifact;
  if (item.evidenceKind === EVIDENCE_KIND.DOCUMENT)
    return { ...artifact, evidenceKind: EVIDENCE_KIND.DOCUMENT };
  return invalid();
}

function evidence(value: unknown): ScheduleEvidence | null {
  if (value === null) return null;
  const { actorUserId, recordedAt, ...input } = record(value);
  const proof = parseScheduleEvidenceInput(input);
  const recorded = timestamp(recordedAt);
  if (
    proof.evidenceKind === EVIDENCE_KIND.USER_ATTESTATION &&
    new Date(proof.attestedAt).getTime() > new Date(recorded).getTime()
  )
    return invalid();
  return {
    ...proof,
    actorUserId: text(actorUserId),
    recordedAt: recorded,
  };
}

export function parseMirrorCorrection(value: unknown): MirrorCorrection {
  const item = record(value);
  fields(item, ['targetCashFlowEntryId', 'before', 'after']);
  const amounts = (
    value: unknown,
    before: boolean,
  ): MirrorCorrection['before'] => {
    const pair = record(value);
    fields(pair, ['sourceAmountCents', 'targetAmountCents']);
    const sourceAmountCents = index(pair.sourceAmountCents);
    const targetAmountCents = index(pair.targetAmountCents);
    if (
      sourceAmountCents < 1 ||
      sourceAmountCents > 2_147_483_647 ||
      targetAmountCents > 2_147_483_647 ||
      (!before && targetAmountCents !== sourceAmountCents)
    )
      return invalid();
    return { sourceAmountCents, targetAmountCents };
  };
  return {
    targetCashFlowEntryId: text(item.targetCashFlowEntryId),
    before: amounts(item.before, true),
    after: amounts(item.after, false),
  };
}

function assistedProvenance(value: unknown): AssistedCardProvenance {
  const item = record(value);
  const absent = item.basis === ASSISTANCE_BASIS.ABSENT;
  fields(item, [
    'kind',
    'basis',
    'originalImportId',
    'originalExternalId',
    'reason',
    'evidence',
    'referenceCheck',
    ...(absent ? ['checkedAt'] : []),
  ]);
  if (item.kind !== ASSISTED_CARD) return invalid();
  const proof = evidence(item.evidence);
  if (!proof) return invalid();
  const base = {
    kind: ASSISTED_CARD as typeof ASSISTED_CARD,
    reason: text(item.reason),
    evidence: proof,
    originalExternalId:
      item.originalExternalId === null ? null : text(item.originalExternalId),
  };
  if (absent && item.referenceCheck === REFERENCE_CHECK.ABSENT)
    return {
      ...base,
      basis: ASSISTANCE_BASIS.ABSENT,
      originalImportId: text(item.originalImportId),
      referenceCheck: REFERENCE_CHECK.ABSENT,
      checkedAt: timestamp(item.checkedAt),
    };
  if (
    item.basis === ASSISTANCE_BASIS.NONE &&
    item.originalImportId === null &&
    item.referenceCheck === REFERENCE_CHECK.NONE
  )
    return {
      ...base,
      basis: ASSISTANCE_BASIS.NONE,
      originalImportId: null,
      referenceCheck: REFERENCE_CHECK.NONE,
    };
  return invalid();
}

function operation(value: unknown): ScheduleOperationReceipt | null {
  if (value === null) return null;
  const item = record(value);
  fields(item, [
    'requestId',
    'payloadHash',
    'resultingStateHash',
    'actorUserId',
    'recordedAt',
    ...('mirrorCorrections' in item ? ['mirrorCorrections'] : []),
  ]);
  let mirrorCorrections: ScheduleOperationReceipt['mirrorCorrections'];
  if ('mirrorCorrections' in item) {
    if (
      !Array.isArray(item.mirrorCorrections) ||
      !item.mirrorCorrections.length
    )
      return invalid();
    mirrorCorrections = item.mirrorCorrections.map((raw: unknown) => {
      const entry = record(raw);
      const { cashFlowEntryId, ...matrix } = entry;
      return {
        cashFlowEntryId: text(cashFlowEntryId),
        ...parseMirrorCorrection(matrix),
      };
    });
    if (
      new Set(mirrorCorrections.map((row) => row.cashFlowEntryId)).size !==
        mirrorCorrections.length ||
      new Set(mirrorCorrections.map((row) => row.targetCashFlowEntryId))
        .size !== mirrorCorrections.length
    )
      return invalid();
  }
  return {
    requestId: text(item.requestId),
    payloadHash: hash(item.payloadHash),
    resultingStateHash: hash(item.resultingStateHash),
    actorUserId: text(item.actorUserId),
    recordedAt: timestamp(item.recordedAt),
    ...(mirrorCorrections ? { mirrorCorrections } : {}),
  };
}

function projection(value: unknown, count: number): ScheduleProjectionRef {
  const item = record(value);
  if (item.kind !== 'mirror' && item.kind !== 'rateio') return invalid();
  fields(item, [
    'kind',
    'targetExpenseId',
    'occurrenceMap',
    ...(item.kind === 'rateio' ? ['allocationId'] : []),
  ]);
  if (!Array.isArray(item.occurrenceMap) || !item.occurrenceMap.length)
    return invalid();
  const occurrenceMap = item.occurrenceMap.map((value: unknown) => {
    const pair = record(value);
    fields(pair, ['sourceIndex', 'targetIndex']);
    const sourceIndex = index(pair.sourceIndex);
    if (sourceIndex >= count) return invalid();
    return { sourceIndex, targetIndex: index(pair.targetIndex) };
  });
  if (
    new Set(occurrenceMap.map((pair) => pair.sourceIndex)).size !==
      occurrenceMap.length ||
    new Set(occurrenceMap.map((pair) => pair.targetIndex)).size !==
      occurrenceMap.length
  )
    return invalid();
  const targetExpenseId = text(item.targetExpenseId);
  return item.kind === 'mirror'
    ? { kind: 'mirror', targetExpenseId, occurrenceMap }
    : {
        kind: 'rateio',
        allocationId: text(item.allocationId),
        targetExpenseId,
        occurrenceMap,
      };
}

export function parseStoredExpenseSchedule(
  raw: string | null | undefined,
): StoredExpenseSchedule | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return invalid();
    throw error;
  }
  const value = record(parsed);
  if (
    (value.version !== 1 &&
      !(value.version === 2 && value.kind === 'source')) ||
    (value.kind !== 'source' && value.kind !== 'projection')
  )
    return invalid();
  if (!Array.isArray(value.occurrences)) return invalid();
  const privateOccurrences = value.occurrences.map(record);
  let schedule: ExpenseScheduleV1;
  try {
    schedule = parseExpenseSchedule({
      version: 1,
      occurrences: privateOccurrences.map((item) => ({
        index: item.index,
        parcela: item.parcela,
        valor: item.valor,
        data: item.data,
        invoiceDueMonth: item.invoiceDueMonth,
      })),
    });
  } catch (error) {
    if (error instanceof RangeError) return invalid();
    throw error;
  }
  const base = {
    version: 1 as const,
    tenantId: text(value.tenantId),
    sourceExpenseId: text(value.sourceExpenseId),
    sourceProjectId: text(value.sourceProjectId),
    cardId: text(value.cardId),
    recordedByUserId: text(value.recordedByUserId),
    recordedAt: timestamp(value.recordedAt),
  };
  if (value.kind === 'source') {
    fields(value, [
      ...BASE_FIELDS,
      ...(value.version === 2 ? ['provenance'] : ['importId', 'externalId']),
      'projections',
      'lastOperation',
    ]);
    if (!Array.isArray(value.projections)) return invalid();
    return {
      ...base,
      kind: 'source',
      ...(value.version === 2
        ? {
            version: 2 as const,
            provenance: assistedProvenance(value.provenance),
          }
        : {
            importId: text(value.importId),
            externalId: text(value.externalId),
          }),
      occurrences: schedule.occurrences.map((item, i) => {
        const privateItem = privateOccurrences[i]!;
        fields(privateItem, [
          ...PUBLIC_FIELDS,
          'amountEvidence',
          'cycleEvidence',
        ]);
        const cycleEvidence = evidence(privateItem.cycleEvidence);
        if ((item.invoiceDueMonth === null) !== (cycleEvidence === null))
          return invalid();
        return {
          ...item,
          amountEvidence: evidence(privateItem.amountEvidence),
          cycleEvidence,
        };
      }),
      projections: value.projections.map((item: unknown) =>
        projection(item, schedule.occurrences.length),
      ),
      lastOperation: operation(value.lastOperation),
    };
  }
  fields(value, [
    ...BASE_FIELDS,
    'targetExpenseId',
    'targetProjectId',
    'via',
    'allocationId',
  ]);
  const target = {
    ...base,
    kind: 'projection' as const,
    targetExpenseId: text(value.targetExpenseId),
    targetProjectId: text(value.targetProjectId),
    occurrences: schedule.occurrences.map((item, i) => {
      const privateItem = privateOccurrences[i]!;
      fields(privateItem, [...PUBLIC_FIELDS, 'sourceIndex']);
      return { ...item, sourceIndex: index(privateItem.sourceIndex) };
    }),
  };
  if (value.via === 'mirror' && value.allocationId === null) {
    return { ...target, via: 'mirror', allocationId: null };
  }
  if (value.via === 'rateio') {
    return { ...target, via: 'rateio', allocationId: text(value.allocationId) };
  }
  return invalid();
}

export function toPublicExpenseSchedule(
  stored: StoredExpenseSchedule | null,
): ExpenseScheduleV1 | null {
  if (stored === null) return null;
  return {
    version: 1,
    occurrences: stored.occurrences.map((item) => ({
      index: item.index,
      parcela: item.parcela,
      valor: item.valor,
      data: item.data,
      invoiceDueMonth: item.invoiceDueMonth,
    })),
  };
}

export function serializeFinancialScheduleResponse(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(serializeFinancialScheduleResponse);
  if (!value || typeof value !== 'object') return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const entries = Object.entries(value);
  const result = Object.fromEntries(
    entries
      .filter(
        ([key]) =>
          key !== 'documentedSchedule' && key !== 'plannedDocumentedSchedule',
      )
      .map(([key, item]) => [key, serializeFinancialScheduleResponse(item)]),
  );
  if (Object.prototype.hasOwnProperty.call(value, 'documentedSchedule')) {
    const raw: unknown = Reflect.get(value, 'documentedSchedule');
    if (raw !== null && raw !== undefined && typeof raw !== 'string')
      return invalid();
    result.schedule = toPublicExpenseSchedule(parseStoredExpenseSchedule(raw));
  }
  return result;
}
