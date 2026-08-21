import { describe, it, expect } from 'vitest';
import { assertFinancialItemCardV1Shape, type FinancialItemCardV1 } from '@reformaflow/domain';
import type { MonthlyOverviewEntry } from '@reformaflow/domain';

function validCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'exp-1',
    kind: 'expense',
    origin: 'PESSOAL',
    originProjectId: 'proj-1',
    originProjectName: 'Pessoal',
    purpose: 'OUTROS',
    purposeLabel: 'Outros',
    amountCents: 15000,
    date: '2026-03-10T00:00:00.000Z',
    status: 'PAGO',
    title: null,
    supplier: 'Leroy Merlin',
    installment: '1/3',
    paymentForm: 'CARTAO_CREDITO',
    relationship: { cardLast4: '1234', bankLast4: null },
    hasEvidence: false,
    actions: [{ actionId: 'view-detail' }],
    isEspelho: false,
    isNeutral: false,
    ...overrides,
  };
}

describe('FinancialItemCardV1 — assertFinancialItemCardV1Shape', () => {
  // U3-01
  it('U3-01 shape válido completo → não lança', () => {
    expect(() => assertFinancialItemCardV1Shape(validCard())).not.toThrow();
  });

  // U3-02
  it('U3-02 falta amountCents → lança', () => {
    const card = validCard();
    delete card.amountCents;
    expect(() => assertFinancialItemCardV1Shape(card)).toThrow(/amountCents/);
  });

  // U3-03
  it('U3-03 amountCents: 150.5 → lança (guarda integer, não > 0)', () => {
    expect(() => assertFinancialItemCardV1Shape(validCard({ amountCents: 150.5 }))).toThrow(/amountCents/);
  });

  // U3-04
  it('U3-04 amountCents: -1 → lança; 0 é válido', () => {
    expect(() => assertFinancialItemCardV1Shape(validCard({ amountCents: -1 }))).toThrow(/amountCents/);
    expect(() => assertFinancialItemCardV1Shape(validCard({ amountCents: 0 }))).not.toThrow();
  });

  // U3-05
  it('U3-05 Object.keys não contém chaves internas (url/path/fileName/importId)', () => {
    const card = validCard();
    const keys = Object.keys(card);
    const banned = /^(url|path|filePath|fileUrl|fileName|importId)$/i;
    expect(keys.filter((k) => banned.test(k))).toEqual([]);

    // Also: asserting a card WITH a banned key is rejected
    expect(() => assertFinancialItemCardV1Shape({ ...validCard(), importId: 'imp-1' })).toThrow(/banned key/i);
    expect(() => assertFinancialItemCardV1Shape({ ...validCard(), fileName: 'a.ofx' })).toThrow(/banned key/i);
  });

  // U3-06
  it('U3-06 hasEvidence: 1 (number truthy) → lança', () => {
    expect(() => assertFinancialItemCardV1Shape(validCard({ hasEvidence: 1 }))).toThrow(/hasEvidence/);
  });

  // U3-07
  it('U3-07 relationship: null → válido', () => {
    expect(() => assertFinancialItemCardV1Shape(validCard({ relationship: null }))).not.toThrow();
  });

  // U3-08
  it('U3-08 actions: ["pay"] (formato antigo strings) → lança; precisa ser [{actionId}]', () => {
    expect(() => assertFinancialItemCardV1Shape(validCard({ actions: ['pay'] }))).toThrow(/action/i);
  });

  // U3-09
  it('U3-09 actions: [] → válido', () => {
    expect(() => assertFinancialItemCardV1Shape(validCard({ actions: [] }))).not.toThrow();
  });

  // U3-10 [TRAVA] MonthlyOverviewEntry still exports tipo/valor/status/data
  it('U3-10 [TRAVA] MonthlyOverviewEntry still exports tipo/valor/status/data', () => {
    // This is a structural lock test — MonthlyOverviewEntry must keep these fields.
    const keys: Array<keyof MonthlyOverviewEntry> = ['tipo', 'valor', 'status', 'data'];
    // If any of these are removed from the type, this test fails at compile time.
    expect(keys).toEqual(['tipo', 'valor', 'status', 'data']);
  });
});
