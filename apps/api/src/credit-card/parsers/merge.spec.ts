import { mergeParseResults, type ParseResult } from './types';

const tx = (ext: string, day: number, cents: number) => ({
  externalId: ext,
  date: new Date(Date.UTC(2026, 5, day)),
  merchant: 'X',
  amountCents: cents,
});

describe('mergeParseResults', () => {
  it('retorna o próprio resultado quando há só 1', () => {
    const r: ParseResult = { source: 'IMAGE', transactions: [tx('a', 1, 100)], totalAmountCents: 100 };
    expect(mergeParseResults([r])).toBe(r);
  });

  it('mescla, deduplica por externalId e soma só débitos (positivos)', () => {
    const r1: ParseResult = { source: 'IMAGE', transactions: [tx('a', 2, 100), tx('b', 1, 200)], totalAmountCents: 300 };
    const r2: ParseResult = { source: 'IMAGE', transactions: [tx('b', 1, 200), tx('c', 3, -50)], totalAmountCents: 200 };
    const m = mergeParseResults([r1, r2]);
    // a, b, c (b deduplicado)
    expect(m.transactions.map((t) => t.externalId)).toEqual(['b', 'a', 'c']); // ordenado por data
    expect(m.totalAmountCents).toBe(300); // 100 + 200, ignora o -50
  });

  it('mescla futureInstallments deduplicando', () => {
    const r1: ParseResult = { source: 'IMAGE', transactions: [], totalAmountCents: 0, futureInstallments: [tx('f1', 5, 100)] };
    const r2: ParseResult = { source: 'IMAGE', transactions: [], totalAmountCents: 0, futureInstallments: [tx('f1', 5, 100), tx('f2', 6, 100)] };
    const m = mergeParseResults([r1, r2]);
    expect(m.futureInstallments!.map((t) => t.externalId)).toEqual(['f1', 'f2']);
  });
});
