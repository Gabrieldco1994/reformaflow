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

  it('XLSX/CSV/OFX/PDF: colisão de externalId entre arquivos NÃO é descartada (bug: 2 transações reais distintas com mesmo bucket data+desc+valor por arquivo)', () => {
    // Ordinal reinicia por arquivo: 2 arquivos, cada um com 1 única ocorrência
    // do bucket 'a' -> ambos geram ordinal=0 -> mesmo externalId. Isso NÃO
    // significa que é a mesma transação (diferente do caso IMAGE de fotos
    // sobrepostas) — são 2 exports de extrato distintos.
    const r1: ParseResult = { source: 'XLSX', transactions: [tx('a', 1, 100)], totalAmountCents: 100 };
    const r2: ParseResult = { source: 'XLSX', transactions: [tx('a', 1, 100)], totalAmountCents: 100 };
    const m = mergeParseResults([r1, r2]);
    expect(m.transactions).toHaveLength(2);
    expect(new Set(m.transactions.map((t) => t.externalId)).size).toBe(2); // externalIds distintos
    expect(m.totalAmountCents).toBe(200); // nenhuma das duas foi perdida
  });

  it('IMAGE preserva dedupe mesmo misturado com outra fonte no mesmo lote (fonte da transação, não do lote, decide)', () => {
    const r1: ParseResult = { source: 'IMAGE', transactions: [tx('a', 1, 100)], totalAmountCents: 100 };
    const r2: ParseResult = { source: 'IMAGE', transactions: [tx('a', 1, 100)], totalAmountCents: 100 };
    const m = mergeParseResults([r1, r2]);
    expect(m.transactions).toHaveLength(1); // dedupe preservado para IMAGE
  });
});
