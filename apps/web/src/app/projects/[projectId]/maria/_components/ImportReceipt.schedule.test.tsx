import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { receiptFixture } from '../_lib/import-session-fixtures';
import { buildReceiptView, lookupNames } from '../_lib/import-receipt-view';
import { ImportReceipt } from './ImportReceipt';

/**
 * The approved schedule is printed as approved. `data` is the NOMINAL date of the occurrence and
 * `invoiceDueMonth` is the explicit invoice cycle (see docs/visao-conta-faturas.md §Cronograma
 * documentado): a valid cycle prevails over any closing/due inference and the nominal date is never
 * replaced by it. A remaining set can be labelled 2/3, 3/3 with asymmetric cents.
 */
function receiptWithSchedule(occurrences: Array<{ index: number; parcela: string | null; valor: number; data: string; invoiceDueMonth: string | null }>) {
  const base = receiptFixture();
  const total = occurrences.reduce((sum, occurrence) => sum + occurrence.valor, 0);
  return receiptFixture({
    items: [base.items[0]],
    snapshot: {
      ...base.snapshot,
      lines: [
        {
          ...base.snapshot.lines[0],
          totalCents: total,
          targets: [],
          schedule: { version: 1, occurrences },
        },
      ],
      invoiceDeltas: [{ invoiceDueMonth: '2026-11', amountCents: total }],
    },
  });
}

function renderReceipt(occurrences: Parameters<typeof receiptWithSchedule>[0]) {
  const view = buildReceiptView(receiptWithSchedule(occurrences), lookupNames({}));
  expect(view).not.toBeNull();
  return render(<ImportReceipt view={view!} />);
}

describe('receipt schedule presentation', () => {
  const EXCEPTIONAL = [
    { index: 0, parcela: '2/3', valor: 10_000, data: '2026-07-14', invoiceDueMonth: '2026-11' },
    { index: 1, parcela: '3/3', valor: 6_000, data: '2026-08-14', invoiceDueMonth: null },
  ];

  it('never turns the nominal date into a due date', () => {
    renderReceipt(EXCEPTIONAL);
    expect(screen.queryByText(/Primeira parcela em/i)).toBeNull();
    expect(screen.queryByText(/vencimento|vence/i)).toBeNull();
  });

  it('prints every approved occurrence with its own label, nominal date, explicit cycle and cents', () => {
    renderReceipt(EXCEPTIONAL);
    const rows = screen.getAllByTestId('receipt-occurrence');
    expect(rows).toHaveLength(2);

    expect(within(rows[0]).getByText(/Parcela 2\/3/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/14\/07\/2026/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Fatura 11\/2026/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('R$ 100,00')).toBeInTheDocument();

    expect(within(rows[1]).getByText(/Parcela 3\/3/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/14\/08\/2026/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('R$ 60,00')).toBeInTheDocument();
  });

  it('does not infer a cycle when invoiceDueMonth is null, nor fabricate 1/2 labels', () => {
    renderReceipt(EXCEPTIONAL);
    const rows = screen.getAllByTestId('receipt-occurrence');
    expect(within(rows[1]).queryByText(/Fatura/)).toBeNull();
    expect(screen.queryByText(/\b1\/2\b|\b2\/2\b|\b1\/3\b/)).toBeNull();
  });

  it('shows a null label as a single launch, not as an invented parcela', () => {
    renderReceipt([{ index: 0, parcela: null, valor: 4_990, data: '2026-10-10', invoiceDueMonth: '2026-10' }]);
    const [row] = screen.getAllByTestId('receipt-occurrence');
    expect(within(row).getByText(/Lançamento/)).toBeInTheDocument();
    expect(within(row).queryByText(/Parcela/)).toBeNull();
    expect(within(row).getByText(/10\/10\/2026/)).toBeInTheDocument();
    expect(within(row).getByText(/Fatura 10\/2026/)).toBeInTheDocument();
  });

  it('keeps the approved order even when dates are not chronological', () => {
    renderReceipt([
      { index: 0, parcela: '2/3', valor: 10_000, data: '2026-09-01', invoiceDueMonth: '2026-11' },
      { index: 1, parcela: '3/3', valor: 6_000, data: '2026-07-14', invoiceDueMonth: '2026-12' },
    ]);
    const rows = screen.getAllByTestId('receipt-occurrence');
    expect(within(rows[0]).getByText(/Parcela 2\/3/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Parcela 3\/3/)).toBeInTheDocument();
  });

  // UNIT instrument against recomputation only: 16.001 vs 16.000 is NOT a snapshot the API would accept
  // (B1 requires allocations to sum to the total). Browser/API fixtures use coherent sums.
  it('does not recompute totals: the line total is the approved one, occurrences are printed as they are', () => {
    const receipt = receiptWithSchedule(EXCEPTIONAL);
    receipt.snapshot.lines[0].totalCents = 16_001; // deliberately not the sum
    const view = buildReceiptView(receipt, lookupNames({}));
    render(<ImportReceipt view={view!} />);
    expect(screen.getByText('R$ 160,01')).toBeInTheDocument();
    expect(screen.getByText('R$ 100,00')).toBeInTheDocument();
    expect(screen.getByText('R$ 60,00')).toBeInTheDocument();
  });

  // Approved limits (IMPORT_SESSION_LIMITS, pinned literally on purpose): 10 selected lines per batch
  // and 24 installments per purchase => 240 occurrences (= expandedCFEsPerBatch).
  it('keeps every occurrence of a batch at the approved limit readable: 10 lines x 24 occurrences', () => {
    const base = receiptFixture();
    const lines = Array.from({ length: 10 }, (_, lineIndex) => ({
      ...base.snapshot.lines[0],
      lineId: `line-${lineIndex}`,
      titulo: `Compra ${lineIndex}`,
      totalCents: 24 * 1_000,
      targets: [],
      schedule: {
        version: 1 as const,
        occurrences: Array.from({ length: 24 }, (_, index) => ({
          index,
          parcela: `${index + 1}/24`,
          valor: 1_000,
          data: `2026-${String((index % 12) + 1).padStart(2, '0')}-14`,
          invoiceDueMonth: null,
        })),
      },
    }));
    const receipt = receiptFixture({
      items: lines.map((line) => ({ ...base.items[0], lineId: line.lineId })),
      snapshot: { ...base.snapshot, lines, invoiceDeltas: [] },
    });
    const view = buildReceiptView(receipt, lookupNames({}));
    expect(view).not.toBeNull();
    render(<ImportReceipt view={view!} />);
    expect(screen.getAllByTestId('receipt-occurrence')).toHaveLength(240);
    expect(screen.getAllByText(/Parcela 24\/24/)).toHaveLength(10);
    // Long schedules fold behind a native <details>; short ones stay open.
    const details = document.querySelectorAll('details');
    expect(details).toHaveLength(10);
    expect([...details].every((d) => !d.open)).toBe(true);
  });

  it('keeps a short schedule open by default', () => {
    renderReceipt([{ index: 0, parcela: null, valor: 4_990, data: '2026-10-10', invoiceDueMonth: '2026-10' }]);
    expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });
});
