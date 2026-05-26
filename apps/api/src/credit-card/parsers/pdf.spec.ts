import { extractTransactionsFromText } from './pdf';

describe('extractTransactionsFromText - future installments section', () => {
  it('separa lançamentos futuros de "Próximos lançamentos parcelados"', () => {
    const text = [
      '29/04/2026 POLO MARMORESS 1/3 R$ 2.158,34',
      '30/04/2026 ITAU UNIBANCO S R$ 6.644,42',
      'Próximos lançamentos parcelados',
      '29/04/2026 POLO MARMORESS 2/3 R$ 2.158,33',
      '29/04/2026 POLO MARMORESS 3/3 R$ 2.158,33',
    ].join('\n');
    const { current, future } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    expect(current).toHaveLength(2);
    expect(current.find((t) => /POLO/i.test(t.merchant))?.installmentCurrent).toBe(1);
    expect(future).toHaveLength(2);
    expect(future.every((t) => t.isFuture)).toBe(true);
  });

  it('dedup nível 2: mesma série com 1ct de diff é deduplicada (mesma seção)', () => {
    const text = [
      '29/04/2026 POLO MARMORESS 1/3 R$ 2.158,34',
      '29/04/2026 POLO MARMORESS 2/3 R$ 2.158,33',
    ].join('\n');
    const { current } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    expect(current).toHaveLength(1);
    expect(current[0].installmentCurrent).toBe(1);
    expect(current[0].amountCents).toBe(215834);
  });

  it('parcelas em datas diferentes NÃO são deduplicadas', () => {
    const text = [
      '29/04/2026 POLO MARMORESS 1/3 R$ 2.158,34',
      '29/05/2026 POLO MARMORESS 2/3 R$ 2.158,33',
    ].join('\n');
    const { current } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    expect(current).toHaveLength(2);
  });

  it('detecta variantes de seção futura', () => {
    const headers = [
      'Próximas faturas',
      'PRÓXIMAS COMPRAS PARCELADAS',
      'compras parceladas a vencer',
      'Parcelas futuras',
      'Pré-fatura',
      'Pagamentos futuros parcelados',
    ];
    for (const h of headers) {
      const text = [
        '01/04/2026 LOJA A R$ 100,00',
        h,
        '01/04/2026 LOJA FUTURA R$ 999,99',
      ].join('\n');
      const { current, future } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
      expect(current.find((t) => /FUTURA/i.test(t.merchant))).toBeUndefined();
      expect(current).toHaveLength(1);
      expect(future.find((t) => /FUTURA/i.test(t.merchant))).toBeDefined();
    }
  });
});

