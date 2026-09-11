import { NotFoundException } from '@nestjs/common';
import { ACL_NOT_FOUND_MESSAGE } from '../common/access-rules';

type Scalar = 'string' | 'integer' | 'boolean' | 'date';
type Rule = Scalar | { readonly nullable: Rule } | { readonly array: Rule } | { readonly record: Shape };
type Shape = { readonly [key: string]: Rule };
type Value<R> = R extends 'string' | 'date' ? string
  : R extends 'integer' ? number : R extends 'boolean' ? boolean
  : R extends { nullable: infer N } ? Value<N> | null
  : R extends { array: infer A } ? Value<A>[]
  : R extends { record: infer S extends Shape } ? { [K in keyof S]: Value<S[K]> } : never;

const nullableString = { nullable: 'string' } as const;
const nullableInteger = { nullable: 'integer' } as const;
const nullableDate = { nullable: 'date' } as const;

// Frozen v1 projection, not introspection of the live schema/row. Future columns require an explicit protocol decision.
const expense = {
  id: 'string', projectId: 'string', tenantId: 'string', createdByUserId: nullableString,
  tipoDespesa: 'string', categoriaMaoDeObra: nullableString, roomId: nullableString,
  valor: 'integer', quantidade: 'integer', valorTotal: 'integer', titulo: nullableString, fornecedor: nullableString,
  link: nullableString, imageUrl: nullableString, formaPagamento: 'string', dataPagamento: nullableDate,
  quantidadeParcela: nullableInteger, dataInicioParcela: nullableDate, dataCompra: nullableDate,
  status: 'string', recorrente: 'boolean', recorrenciaFim: nullableDate, paidParcelas: nullableString,
  installmentDateOverrides: nullableString, plannedExpenseId: nullableString, settledByExpenseId: nullableString,
  importId: nullableString, externalId: nullableString, recurrenceKey: nullableString, seriesKey: nullableString,
  cardLast4: nullableString, bankLast4: nullableString, accountId: nullableString, origin: 'string',
  linkedExpenseId: nullableString, settlesInvoiceKey: nullableString, dedupeKeyStrong: nullableString,
  dedupeKeyNatural: nullableString, invoiceUndoState: nullableString, invoiceUndoParcelaCount: nullableInteger,
  invoiceUndoDueMonth: nullableString, invoiceUndoCardId: nullableString, invoiceUndoTrailVersion: nullableInteger,
  createdAt: 'date', updatedAt: 'date', deletedAt: nullableDate,
} as const satisfies Shape;

const cashFlow = {
  id: 'string', projectId: 'string', tenantId: 'string', receiptId: nullableString, expenseId: nullableString,
  budgetAllocationId: nullableString, valor: 'integer', tipo: 'string', data: 'date', categoria: 'string',
  subcategoria: nullableString, ambiente: nullableString, formaPagamento: nullableString, status: 'string',
  parcela: nullableString, createdAt: 'date', updatedAt: 'date', deletedAt: nullableDate,
} as const satisfies Shape;

const allocation = {
  id: 'string', tenantId: 'string', sourceExpenseId: 'string', targetExpenseId: 'string', allocation: 'integer',
  plannedStatus: 'string', plannedPaid: nullableString, plannedValor: nullableInteger, plannedQuantidade: nullableInteger,
  plannedValorTotal: nullableInteger, plannedForma: nullableString, plannedQtdParcela: nullableInteger,
  plannedDataInicio: nullableDate, plannedDataPagamento: nullableDate, plannedInstallmentDateOverrides: nullableString,
  createdAt: 'date',
} as const satisfies Shape;

const settlement = {
  id: 'string', tenantId: 'string', sourceExpenseId: 'string', targetExpenseId: 'string',
  parcelaIndex: 'integer', realValor: 'integer', plannedValor: 'integer', plannedStatus: 'string', createdAt: 'date',
} as const satisfies Shape;

const financing = {
  id: 'string', financingId: 'string', projectId: 'string', tenantId: 'string', numeroParcela: 'integer',
  dataVencimento: 'date', valorPrevisto: 'integer', saldoDevedorPrevisto: 'integer', status: 'string',
  valorPago: nullableInteger, dataPagamento: nullableDate, expenseId: nullableString,
  createdAt: 'date', updatedAt: 'date', deletedAt: nullableDate,
} as const satisfies Shape;

const marker = {
  id: 'string', floorPlanId: 'string', expenseId: 'string', bounds: 'string', createdAt: 'date', updatedAt: 'date',
} as const satisfies Shape;

const liquidation = {
  id: 'string', tenantId: 'string', paymentExpenseId: 'string', importId: 'string', purchaseExpenseId: 'string',
  cashFlowEntryId: 'string', cardId: 'string', prevStatus: 'string', entryValorCents: 'integer',
  parcela: nullableString, dueMonth: 'string', createdAt: 'date', deletedAt: nullableDate,
} as const satisfies Shape;

const snapshotV1 = {
  record: {
    expenses: { array: { record: {
      ...expense,
      cashFlow: { array: { record: cashFlow } },
      rateioAsSource: { array: { record: allocation } },
      rateioAsTarget: { array: { record: allocation } },
      settlementsAsSource: { array: { record: settlement } },
      settlementsAsTarget: { array: { record: settlement } },
      financingInstallment: { nullable: { record: financing } },
      markers: { array: { record: marker } },
      importedInvoiceLiquidationsAsPayment: { array: { record: liquidation } },
      importedInvoiceLiquidationsAsPurchase: { array: { record: liquidation } },
    } } },
    dependents: { array: { record: expense } },
  },
} as const satisfies Rule;

export type InlineSnapshotV1 = Value<typeof snapshotV1>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validScalar(value: unknown, rule: Scalar): boolean {
  if (rule === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (rule === 'date') return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  return typeof value === rule;
}

function valid(value: unknown, rule: Rule): boolean {
  if (typeof rule === 'string') return validScalar(value, rule);
  if ('nullable' in rule) return value === null || valid(value, rule.nullable);
  if ('array' in rule) return Array.isArray(value) && value.every(item => valid(item, rule.array));
  return isRecord(value) && Object.keys(value).length === Object.keys(rule.record).length &&
    Object.entries(rule.record).every(([key, child]) =>
      Object.prototype.hasOwnProperty.call(value, key) && valid(value[key], child));
}

/** Producer and comparison use the same explicit projection; never rebaseline persisted values from live rows. */
function project(value: unknown, rule: Rule): unknown {
  if (typeof rule === 'string') {
    const scalar = rule === 'date' && value instanceof Date ? value.toISOString() : value;
    if (!validScalar(scalar, rule)) throw new Error('Invalid inline snapshot v1 producer');
    return scalar;
  }
  if ('nullable' in rule) return value === null ? null : project(value, rule.nullable);
  if ('array' in rule) {
    if (!Array.isArray(value)) throw new Error('Invalid inline snapshot v1 array');
    return value.map(item => project(item, rule.array));
  }
  if (!isRecord(value)) throw new Error('Invalid inline snapshot v1 record');
  return Object.fromEntries(Object.entries(rule.record).map(([key, child]) => [key, project(value[key], child)]));
}

export function serializeInlineSnapshotV1(value: unknown): string {
  return JSON.stringify(project(value, snapshotV1));
}

export function parseInlineSnapshotV1(raw: string): InlineSnapshotV1 {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new NotFoundException(ACL_NOT_FOUND_MESSAGE); }
  if (!valid(value, snapshotV1)) throw new NotFoundException(ACL_NOT_FOUND_MESSAGE);
  return value as InlineSnapshotV1;
}
