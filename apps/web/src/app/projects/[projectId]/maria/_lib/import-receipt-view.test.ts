import { describe, expect, it } from 'vitest';
import { receiptFixture } from './import-session-fixtures';
import { buildReceiptView, KEEP_EXISTING_TITLE, lookupNames } from './import-receipt-view';

const names = lookupNames({
  projects: [
    { id: 'proj-pessoal', name: 'Pessoal' },
    { id: 'proj-reforma', name: 'Reforma da casa' },
  ],
  cards: [{ id: 'card-1', nickname: 'Nubank', last4: '1234', project: { id: 'proj-pessoal', name: 'Pessoal' } }],
});

describe('buildReceiptView', () => {
  it('reads only the approved snapshot: exact cents, no recomputation', () => {
    const view = buildReceiptView(receiptFixture(), names)!;
    expect(view.lines[0]).toMatchObject({
      title: 'Geladeira Frost Free',
      totalLabel: 'R$ 123.456,78',
      purchaseDate: '20/09/2026',
      outcomeLabel: 'Criada',
      sourceName: 'Pessoal',
    });
    expect(view.lines[0].occurrences).toEqual([
      { index: 0, label: 'Parcela 1/2', dateLabel: '10/10/2026', cycleLabel: '10/2026', valueLabel: 'R$ 61.728,39' },
      { index: 1, label: 'Parcela 2/2', dateLabel: '10/11/2026', cycleLabel: '11/2026', valueLabel: 'R$ 61.728,39' },
    ]);
    expect(view.createdTotalLabel).toBe('R$ 123.456,78');
    expect(view.invoiceDeltas).toEqual([
      { monthLabel: '10/2026', amountLabel: 'R$ 61.778,29' },
      { monthLabel: '11/2026', amountLabel: '-R$ 61.728,39' },
    ]);
  });

  it('shows a total exactly as approved even when lines would not add up to it', () => {
    const receipt = receiptFixture();
    receipt.snapshot.createdEconomicTotalCents = 1;
    expect(buildReceiptView(receipt, names)!.createdTotalLabel).toBe('R$ 0,01');
  });

  it('uses the fixed copy for a kept existing purchase, never a fabricated title or date', () => {
    const line = buildReceiptView(receiptFixture(), names)!.lines[1];
    expect(line.title).toBe(KEEP_EXISTING_TITLE);
    expect(KEEP_EXISTING_TITLE).toBe('Compra já existente (mantida)');
    expect(line.purchaseDate).toBeNull();
    expect(line.outcomeLabel).toBe('Mantida');
    expect(line.occurrences).toEqual([
      { index: 0, label: 'Lançamento', dateLabel: '10/10/2026', cycleLabel: '10/2026', valueLabel: 'R$ 49,90' },
    ]);
  });

  it('names targets from the authorized catalog and falls back to "Projeto", never a raw id', () => {
    const view = buildReceiptView(receiptFixture(), names)!;
    expect(view.lines[0].targets).toEqual([
      { name: 'Reforma da casa', amountLabel: 'R$ 100.000,00' },
      { name: 'Projeto', amountLabel: 'R$ 23.456,78' },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/proj-oculto/);
    const anonymous = buildReceiptView(receiptFixture(), lookupNames({}))!;
    expect(anonymous.lines[0].sourceName).toBe('Projeto');
  });

  it('prints appliedAt in BRT and exposes the continuation id only when present', () => {
    expect(buildReceiptView(receiptFixture(), names)!.appliedAtLabel).toBe('19/09/2026 às 23:30');
    expect(buildReceiptView(receiptFixture(), names)!.continuationSessionId).toBeNull();
    expect(buildReceiptView(receiptFixture({ continuationSessionId: 'sess-next' }), names)!.continuationSessionId).toBe('sess-next');
  });

  it('refuses a receipt whose lines and items are not 1:1', () => {
    const receipt = receiptFixture();
    receipt.items = receipt.items.slice(0, 1);
    expect(buildReceiptView(receipt, names)).toBeNull();
    const swapped = receiptFixture();
    swapped.items[0] = { ...swapped.items[0], lineId: 'other' };
    expect(buildReceiptView(swapped, names)).toBeNull();
  });

  it('carries no actions and no financial verbs', () => {
    expect(Object.keys(buildReceiptView(receiptFixture(), names)!)).not.toContain('actions');
  });
});

describe('lookupNames', () => {
  it('names a card by nickname, then last4, then a generic label', () => {
    expect(names.card('card-1')).toBe('Nubank');
    expect(lookupNames({ cards: [{ id: 'c', nickname: null, last4: '9999' }] }).card('c')).toBe('Cartão ••9999');
    expect(names.card('unknown')).toBe('Cartão');
    expect(names.project('unknown')).toBe('Projeto');
  });
});
