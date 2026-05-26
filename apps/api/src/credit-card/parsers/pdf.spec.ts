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

  it('detecta estorno (sinal negativo) e mantém na seção atual', () => {
    const text = [
      '15/04/2026 LOJA A R$ 100,00',
      '20/04/2026 ESTORNO LOJA B - 250,50',
    ].join('\n');
    const { current } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    expect(current).toHaveLength(2);
    const refund = current.find((t) => /ESTORNO/i.test(t.merchant));
    expect(refund).toBeDefined();
    expect(refund!.amountCents).toBeLessThan(0);
  });

  it('skipa linhas de cabeçalho/totais/saldo/vencimento', () => {
    const text = [
      'Fatura MASTERCARD - Junho 2026',
      'Total: R$ 15.677,55',
      'Saldo anterior R$ 0,00',
      'Vencimento 01/06/2026',
      '15/04/2026 LOJA A R$ 100,00',
      'Subtotal R$ 100,00',
    ].join('\n');
    const { current } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    expect(current).toHaveLength(1);
    expect(current[0].merchant).toContain('LOJA');
  });

  it('aceita valores com e sem prefixo R$', () => {
    const text = [
      '15/04/2026 LOJA A R$ 100,00',
      '16/04/2026 LOJA B 250,00',
      '17/04/2026 LOJA C R$1.500,50',
    ].join('\n');
    const { current } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    expect(current).toHaveLength(3);
    expect(current.find((t) => /LOJA A/i.test(t.merchant))?.amountCents).toBe(10000);
    expect(current.find((t) => /LOJA B/i.test(t.merchant))?.amountCents).toBe(25000);
    expect(current.find((t) => /LOJA C/i.test(t.merchant))?.amountCents).toBe(150050);
  });

  it('infere ano correto baseado no mês de vencimento (parcela passada)', () => {
    // fatura de Janeiro 2027: lançamento Dezembro pertence a 2026
    const text = '15/12 LOJA NATAL R$ 500,00';
    const { current } = extractTransactionsFromText(text, 2027, { month: 1, year: 2027 });
    expect(current).toHaveLength(1);
    expect(current[0].date.getUTCFullYear()).toBe(2026);
    expect(current[0].date.getUTCMonth()).toBe(11);
  });

  it('rejeita linhas com data inválida (mês 13, dia 32)', () => {
    const text = [
      '32/04/2026 LOJA INVALIDA R$ 100,00',
      '15/13/2026 LOJA INVALIDA2 R$ 200,00',
      '15/04/2026 LOJA OK R$ 300,00',
    ].join('\n');
    const { current } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    expect(current).toHaveLength(1);
    expect(current[0].merchant).toContain('OK');
  });

  it('cenário realista: fatura com atual + futura + dedup nível 2', () => {
    // Simula o bug original: POLO MARMORESS aparece 1/3 + 2/3 com 1ct diff (duplicação),
    // e há uma seção futura também
    const text = [
      'Fatura MASTERCARD',
      '29/04/2026 POLO MARMORESS 1/3 R$ 2.158,34',
      '29/04/2026 POLO MARMORESS 2/3 R$ 2.158,33',
      '30/04/2026 PgConta ITAU R$ 6.644,42',
      '30/04/2026 NU PAGAMENTOS R$ 5.597,83',
      'Total R$ 16.558,92',
      'Próximos lançamentos parcelados',
      '29/05/2026 POLO MARMORESS 2/3 R$ 2.158,33',
      '29/06/2026 POLO MARMORESS 3/3 R$ 2.158,33',
    ].join('\n');
    const { current, future } = extractTransactionsFromText(text, 2026, { month: 6, year: 2026 });
    // Atual: POLO dedupado → 1 + 2 PgConta = 3
    expect(current).toHaveLength(3);
    const polo = current.find((t) => /POLO/i.test(t.merchant));
    expect(polo?.installmentCurrent).toBe(1);
    // Futuras: 2 parcelas separadas (datas distintas)
    expect(future).toHaveLength(2);
  });
});

