import { describe, expect, it } from 'vitest';
import {
  buildCashAxis,
  buildInstallments,
  caixaDateForCardPurchase,
  caixaMonthForCardPurchase,
  parseExpenseSchedule,
  resolveInstallmentIndex,
} from '../src';

const schedule = {
  version: 1 as const,
  occurrences: [
    {
      index: 0,
      parcela: '2/3',
      valor: 12345,
      data: '2026-08-31',
      invoiceDueMonth: '2026-11',
    },
    {
      index: 1,
      parcela: '3/3',
      valor: 12340,
      data: '2026-09-30',
      invoiceDueMonth: null,
    },
  ],
};

describe('documented schedule', () => {
  it.each([
    null,
    '',
    {},
    { ...schedule, version: 2 },
    { ...schedule, occurrences: [] },
    { ...schedule, occurrences: Array(1) },
    { ...schedule, private: true },
    ...[
      { index: 1 },
      { index: -1 },
      { valor: 1.1 },
      { valor: Number.MAX_SAFE_INTEGER + 1 },
      { data: '2026-02-29' },
      { data: '2026-13-01' },
      { data: '2026-08-31T00:00:00Z' },
      { invoiceDueMonth: '2026-13' },
      { invoiceDueMonth: undefined },
      { parcela: '' },
      { amountEvidence: 'private' },
    ].map((patch) => ({
      version: 1,
      occurrences: [{ ...schedule.occurrences[0], ...patch }],
    })),
    {
      version: 1,
      occurrences: [
        { ...schedule.occurrences[0], valor: Number.MAX_SAFE_INTEGER },
        { ...schedule.occurrences[1], valor: 1 },
      ],
    },
  ])('rejects malformed public input without a fallback (%j)', (value) => {
    expect(() => parseExpenseSchedule(value)).toThrow(RangeError);
  });

  it('copies valid data, accepts zero distribution cells and real leap days', () => {
    const value = {
      version: 1,
      occurrences: [
        {
          index: 0,
          parcela: null,
          valor: 0,
          data: '2024-02-29',
          invoiceDueMonth: null,
        },
      ],
    };
    const parsed = parseExpenseSchedule(value);
    expect(parsed).toEqual(value);
    expect(parsed).not.toBe(value);
    expect(parsed.occurrences[0]).not.toBe(value.occurrences[0]);
  });

  it('preserves cents, printed labels and local indices instead of dividing again', () => {
    const input = {
      valorTotal: 24685,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 2,
      dataInicioParcela: new Date('2026-08-31'),
      installmentDateOverrides: '{"1":"2026-10-01"}',
      schedule,
    };
    expect(buildInstallments(input)).toEqual([
      { ...schedule.occurrences[0], data: new Date('2026-08-31') },
      { ...schedule.occurrences[1], data: new Date('2026-10-01') },
    ]);
  });

  it.each([12345, -7, -321])(
    'keeps signed %i cents in the documented cycle',
    (valor) => {
      const input = {
        valorTotal: valor,
        formaPagamento: 'A_VISTA',
        dataPagamento: new Date('2026-08-31'),
        schedule: {
          version: 1 as const,
          occurrences: [{ ...schedule.occurrences[0], parcela: null, valor }],
        },
      };
      const [entry] = buildInstallments(input);
      expect(entry).toEqual({
        index: 0,
        parcela: null,
        valor,
        data: new Date('2026-08-31'),
        invoiceDueMonth: '2026-11',
      });

      expect(
        caixaMonthForCardPurchase(entry!.data, 20, 5, entry!.invoiceDueMonth),
      ).toBe('2026-11');
      expect(
        caixaMonthForCardPurchase(
          entry!.data,
          null,
          null,
          entry!.invoiceDueMonth,
        ),
      ).toBe('2026-11');
      expect(
        caixaDateForCardPurchase(
          entry!.data,
          null,
          null,
          entry!.invoiceDueMonth,
        ),
      ).toEqual(new Date('2026-11-30'));
      expect(entry!.data).toEqual(new Date('2026-08-31'));
    },
  );

  it.each([
    '2026-00',
    '2026-13',
    '26-11',
    '2026-1',
    '2026-11-01',
    '0000-11',
    '',
  ])('rejects invalid explicit cycles in both calculators (%s)', (month) => {
    expect(() =>
      caixaMonthForCardPurchase('2026-01-01', null, null, month),
    ).toThrow(RangeError);
    expect(() => caixaDateForCardPurchase('2026-01-01', 20, 5, month)).toThrow(
      RangeError,
    );
  });

  it('clamps projection only and keeps legacy null-cycle behavior', () => {
    expect(caixaDateForCardPurchase('2026-08-31', 20, 31, '2028-02')).toEqual(
      new Date('2028-02-29'),
    );
    expect(caixaMonthForCardPurchase('2026-08-31', 20, 5, null)).toBe(
      caixaMonthForCardPurchase('2026-08-31', 20, 5),
    );
    expect(caixaDateForCardPurchase('2026-08-31', null, null, null)).toEqual(
      new Date('2026-08-31'),
    );
  });

  it('rejects count/total mismatches and resolves labels locally, never numerator minus one', () => {
    const input = {
      schedule,
      valorTotal: 24685,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 2,
    };
    expect(() => buildInstallments({ ...input, valorTotal: 24686 })).toThrow(
      RangeError,
    );
    expect(() => buildInstallments({ ...input, quantidadeParcela: 3 })).toThrow(
      RangeError,
    );
    const entries = buildInstallments(input);
    expect(resolveInstallmentIndex(entries, '2/3')).toBe(0);
    expect(resolveInstallmentIndex(entries, '3/3')).toBe(1);
    expect(() => resolveInstallmentIndex(entries, '1/3')).toThrow(RangeError);
    expect(() => resolveInstallmentIndex(entries, null)).toThrow(RangeError);
    expect(() =>
      resolveInstallmentIndex([entries[0]!, entries[0]!], '2/3'),
    ).toThrow(RangeError);
    const legacy = buildInstallments({
      valorTotal: 5,
      formaPagamento: 'A_VISTA',
    });
    expect(resolveInstallmentIndex(legacy, null)).toBe(0);
    expect(resolveInstallmentIndex(legacy, '1/1')).toBe(0);
    expect(() => resolveInstallmentIndex(legacy, '2/3')).toThrow(RangeError);
    expect(
      buildInstallments({
        valorTotal: 12345,
        formaPagamento: 'A_VISTA',
        schedule: { version: 1, occurrences: [schedule.occurrences[0]!] },
      })[0]?.parcela,
    ).toBe('2/3');
  });

  it('projects the purchase and credits to one signed obligation without bank debits', () => {
    const entries = [12345, -7, -321].map((valor, index) => ({
      tipo: 'DESPESA',
      categoria: 'OUTROS',
      valor,
      cardLast4: '0701',
      data: `2026-0${index + 6}-15`,
      invoiceDueMonth: '2026-11',
    }));
    const result = buildCashAxis(entries, []);
    expect(result.porMes).toEqual({
      '2026-11': { faturaCartao: 12017, debitos: 0, total: 12017 },
    });
    expect(result.detalhePorCartao[0]?.itens.map((item) => item.valor)).toEqual(
      [12345, -7, -321],
    );
  });
});

describe('P01 documentary cycle integration', () => {
  it.each(['2026-09-25', '2026-09-28'])(
    'P01 preserva novembro documentado nos dois lados do fechamento: %s',
    (purchaseDate) => {
      expect(
        caixaMonthForCardPurchase(purchaseDate, 27, 5, '2026-11'),
      ).toBe('2026-11');

      expect(
        caixaDateForCardPurchase(purchaseDate, 27, 5, '2026-11'),
      ).toEqual(new Date('2026-11-05T00:00:00.000Z'));
    },
  );
});
