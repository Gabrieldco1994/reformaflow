import { describe, expect, it } from 'vitest';
import { receiptFixture } from './import-session-fixtures';
import { buildReceiptView, lookupNames, type CatalogInput } from './import-receipt-view';

describe('lookupNames tolerates a catalog that is only decoration', () => {
  it('falls back to generic names for null, primitive or malformed members without throwing', () => {
    const catalog = {
      cards: [null, 7, { id: 'card-1' }, { id: 'card-2', nickname: 5, last4: {}, project: 'x' }, { id: 'card-3', project: { id: null, name: 3 } }],
      projects: [null, 'p', { id: 'p1' }, { id: 'p2', name: 9 }, { id: 'p3', name: 'Reforma' }],
    } as unknown as CatalogInput;
    const names = lookupNames(catalog);
    expect(names.card('card-1')).toBe('Cartão');
    expect(names.card('card-2')).toBe('Cartão');
    expect(names.card('card-3')).toBe('Cartão');
    expect(names.card('unknown')).toBe('Cartão');
    expect(names.project('p1')).toBe('Projeto');
    expect(names.project('p2')).toBe('Projeto');
    expect(names.project('p3')).toBe('Reforma');
  });

  it('accepts a non-array catalog body', () => {
    expect(lookupNames({ cards: {}, projects: 'x' } as unknown as CatalogInput).card('c')).toBe('Cartão');
  });
});

describe('buildReceiptView defends the snapshot it projects', () => {
  const broken = (mutate: (snapshot: Record<string, unknown>, line: Record<string, unknown>) => void) => {
    const receipt = JSON.parse(JSON.stringify(receiptFixture()));
    mutate(receipt.snapshot, receipt.snapshot.lines[0]);
    return receipt;
  };
  const names = lookupNames({});

  it('returns null instead of throwing when targets, invoiceDeltas or schedule are not arrays', () => {
    expect(buildReceiptView(broken((_s, l) => void delete l.targets), names)).toBeNull();
    expect(buildReceiptView(broken((s) => void delete s.invoiceDeltas), names)).toBeNull();
    expect(buildReceiptView(broken((_s, l) => void delete l.schedule), names)).toBeNull();
    expect(buildReceiptView(broken((_s, l) => void ((l.schedule as Record<string, unknown>).occurrences = null)), names)).toBeNull();
    expect(buildReceiptView(broken((s) => void ((s.lines as unknown[])[0] = null)), names)).toBeNull();
  });

  it('returns null for an impossible bank effect instead of printing it', () => {
    for (const value of [1, -1]) {
      expect(buildReceiptView(broken((s) => void ((s as Record<string, unknown>).bankCashDeltaCents = value)), names)).toBeNull();
    }
    expect(buildReceiptView(broken(() => undefined), names)!.bankCashDeltaLabel).toBe('R$ 0,00');
  });

  it('never fabricates R$ 0 for a money field that is missing or not an integer', () => {
    expect(buildReceiptView(broken((_s, l) => void delete l.totalCents), names)).toBeNull();
    expect(buildReceiptView(broken((s) => void ((s as Record<string, unknown>).createdEconomicTotalCents = undefined)), names)).toBeNull();
  });
});
