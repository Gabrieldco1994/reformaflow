import { moneyDetail } from '@/lib/money';
import type { ImportReceiptRead } from './import-session-read';
import { isReceiptRead, isRecord } from './import-session-read';
import { formatDateOnly, formatDueMonth, formatInstantBRT } from './import-format';

export const KEEP_EXISTING_TITLE = 'Compra já existente (mantida)';
const FALLBACK_PROJECT = 'Projeto';
const FALLBACK_CARD = 'Cartão';

/** The catalog is untrusted decoration: members are read defensively, never assumed. */
export interface CatalogInput {
  projects?: unknown;
  cards?: unknown;
}

export interface NameLookup {
  project(id: string): string;
  card(id: string): string;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** Names come only from the authorized catalog. A missing entry is generic, never a raw id. */
export function lookupNames(catalog: CatalogInput): NameLookup {
  const projects = new Map<string, string>();
  const cards = new Map<string, string>();
  const members = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value) ? value.filter(isRecord) : [];
  const rememberProject = (project: unknown) => {
    if (!isRecord(project)) return;
    const name = text(project.name);
    if (typeof project.id === 'string' && name) projects.set(project.id, name);
  };
  for (const card of members(catalog.cards)) {
    rememberProject(card.project);
    if (typeof card.id !== 'string') continue;
    const nickname = text(card.nickname);
    const last4 = text(card.last4);
    cards.set(card.id, nickname ?? (last4 ? `${FALLBACK_CARD} ••${last4}` : FALLBACK_CARD));
  }
  for (const project of members(catalog.projects)) rememberProject(project);
  return {
    project: (id) => projects.get(id) ?? FALLBACK_PROJECT,
    card: (id) => cards.get(id) ?? FALLBACK_CARD,
  };
}

/**
 * One approved occurrence, as approved: `data` is the nominal date and `invoiceDueMonth` the explicit
 * invoice cycle. Neither is derived from the other and no cycle is inferred when it is null.
 */
export interface ReceiptOccurrenceView {
  index: number;
  label: string;
  dateLabel: string | null;
  cycleLabel: string | null;
  valueLabel: string;
}

export interface ReceiptLineView {
  lineId: string;
  title: string;
  totalLabel: string;
  purchaseDate: string | null;
  outcomeLabel: string;
  occurrences: ReceiptOccurrenceView[];
  sourceName: string;
  targets: Array<{ name: string; amountLabel: string }>;
}

export interface ReceiptView {
  appliedAtLabel: string | null;
  createdTotalLabel: string;
  bankCashDeltaLabel: string;
  invoiceDeltas: Array<{ monthLabel: string; amountLabel: string }>;
  lines: ReceiptLineView[];
  continuationSessionId: string | null;
}

/**
 * Pure projection of the approved snapshot. Amounts, dates and cycles are printed exactly as approved:
 * nothing is summed, rounded, re-ordered or re-read from current expenses. Returns null when the
 * receipt is malformed or not coherent (lines and items must be 1:1, same order).
 */
export function buildReceiptView(
  receipt: ImportReceiptRead,
  names: NameLookup,
): ReceiptView | null {
  // Defence in depth: the api client already validated, but a projection must never throw on a bad snapshot.
  if (!isReceiptRead(receipt)) return null;
  const { snapshot, items } = receipt;
  if (snapshot.lines.length !== items.length) return null;
  const lines: ReceiptLineView[] = [];
  for (let index = 0; index < items.length; index++) {
    const line = snapshot.lines[index];
    const item = items[index];
    if (line.lineId !== item.lineId) return null;
    lines.push({
      lineId: line.lineId,
      title: line.titulo ?? KEEP_EXISTING_TITLE,
      totalLabel: moneyDetail(line.totalCents),
      purchaseDate: formatDateOnly(line.dataCompra),
      outcomeLabel: item.outcome === 'CREATED' ? 'Criada' : 'Mantida',
      occurrences: line.schedule.occurrences.map((occurrence) => ({
        index: occurrence.index,
        label: occurrence.parcela ? `Parcela ${occurrence.parcela}` : 'Lançamento',
        dateLabel: formatDateOnly(occurrence.data),
        cycleLabel: formatDueMonth(occurrence.invoiceDueMonth),
        valueLabel: moneyDetail(occurrence.valor),
      })),
      sourceName: names.project(line.sourceProjectId),
      targets: line.targets.map((target) => ({
        name: names.project(target.projectId),
        amountLabel: moneyDetail(target.amountCents),
      })),
    });
  }
  return {
    appliedAtLabel: formatInstantBRT(receipt.appliedAt),
    createdTotalLabel: moneyDetail(snapshot.createdEconomicTotalCents),
    bankCashDeltaLabel: moneyDetail(snapshot.bankCashDeltaCents),
    invoiceDeltas: snapshot.invoiceDeltas.map((delta) => ({
      monthLabel: formatDueMonth(delta.invoiceDueMonth) ?? '—',
      amountLabel: moneyDetail(delta.amountCents),
    })),
    lines,
    continuationSessionId: receipt.continuationSessionId ?? null,
  };
}
