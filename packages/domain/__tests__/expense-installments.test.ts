import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildInstallments,
  isSinglePaymentForm,
  normalizeInstallmentDateOverrides,
  PaymentForm,
} from '../src';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('buildInstallments', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('A_VISTA retorna 1 entrada com o valor total na dataPagamento', () => {
    const data = utc(2026, 5, 15);
    const out = buildInstallments({
      valorTotal: 12345,
      formaPagamento: PaymentForm.A_VISTA,
      dataPagamento: data,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ parcela: '1/1', valor: 12345, data });
  });

  it('A_VISTA sem data usa o dia-calendário BRT (meia-noite UTC)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T02:59:00.000Z')); // 23:59 do dia 09 no BRT
    const out = buildInstallments({
      valorTotal: 100,
      formaPagamento: PaymentForm.A_VISTA,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.parcela).toBe('1/1');
    expect(out[0]?.data.toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });

  it('QUINZENAL sem data de início usa o dia-calendário BRT como base', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T02:59:00.000Z')); // 31/01 23:59 BRT
    const out = buildInstallments({
      valorTotal: 300,
      formaPagamento: PaymentForm.QUINZENAL,
      quantidadeParcela: 3,
    });
    expect(out.map((p) => p.data.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-15',
      '2026-03-02',
    ]);
  });

  it.each([
    [PaymentForm.PARCELADO, ['2024-01-10', '2024-02-20', '2024-03-10']],
    [PaymentForm.QUINZENAL, ['2024-01-10', '2024-02-20', '2024-02-09']],
  ])(
    '%s legado sem data de início usa dataPagamento e mantém o override isolado',
    (formaPagamento, expectedDates) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
      const out = buildInstallments({
        valorTotal: 3000,
        formaPagamento,
        quantidadeParcela: 3,
        dataInicioParcela: null,
        dataPagamento: utc(2024, 1, 10),
        installmentDateOverrides: '{"1":"2024-02-20"}',
      });

      expect(out.map((p) => p.data.toISOString().slice(0, 10))).toEqual(expectedDates);
    },
  );

  it('PARCELADO 3x distribui em centavos com remainder na última parcela', () => {
    const out = buildInstallments({
      valorTotal: 1000, // 1000 / 3 = 333.33 → 333, 333, 334
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: 3,
      dataInicioParcela: utc(2026, 1, 10),
    });
    expect(out.map((p) => p.valor)).toEqual([333, 333, 334]);
    expect(out.reduce((acc, p) => acc + p.valor, 0)).toBe(1000);
    expect(out.map((p) => p.parcela)).toEqual(['1/3', '2/3', '3/3']);
    expect(out.map((p) => p.data.toISOString().slice(0, 10))).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
    ]);
  });

  it('PARCELADO divisível distribui igualmente sem remainder', () => {
    const out = buildInstallments({
      valorTotal: 900,
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: 3,
      dataInicioParcela: utc(2026, 6, 1),
    });
    expect(out.map((p) => p.valor)).toEqual([300, 300, 300]);
  });

  it('QUINZENAL 4x gera datas com intervalo de 15 dias', () => {
    const out = buildInstallments({
      valorTotal: 4000,
      formaPagamento: PaymentForm.QUINZENAL,
      quantidadeParcela: 4,
      dataInicioParcela: utc(2026, 3, 1),
    });
    expect(out).toHaveLength(4);
    expect(out.map((p) => p.data.toISOString().slice(0, 10))).toEqual([
      '2026-03-01',
      '2026-03-16',
      '2026-03-31',
      '2026-04-15',
    ]);
    expect(out.map((p) => p.valor)).toEqual([1000, 1000, 1000, 1000]);
    expect(out.map((p) => p.parcela)).toEqual(['1/4', '2/4', '3/4', '4/4']);
  });

  it('aplica override somente ao índice informado sem deslocar as demais parcelas', () => {
    const out = buildInstallments({
      valorTotal: 3000,
      formaPagamento: PaymentForm.QUINZENAL,
      quantidadeParcela: 3,
      dataInicioParcela: utc(2026, 8, 10),
      installmentDateOverrides: '{"1":"2026-09-20"}',
    });
    expect(out.map((p) => p.data.toISOString().slice(0, 10))).toEqual([
      '2026-08-10',
      '2026-09-20',
      '2026-09-09',
    ]);
    expect(out.map((p) => p.parcela)).toEqual(['1/3', '2/3', '3/3']);
    expect(out.map((p) => p.valor)).toEqual([1000, 1000, 1000]);
  });

  it('ignora JSON inválido e overrides inválidos ou fora do range', () => {
    const base = {
      valorTotal: 2000,
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: 2,
      dataInicioParcela: utc(2026, 8, 10),
    };
    expect(buildInstallments({ ...base, installmentDateOverrides: '{invalido' }).map(
      (p) => p.data.toISOString().slice(0, 10),
    )).toEqual(['2026-08-10', '2026-09-10']);
    expect(buildInstallments({
      ...base,
      installmentDateOverrides: '{"-1":"2026-01-01","2":"2026-02-01","1":"2026-02-30"}',
    }).map((p) => p.data.toISOString().slice(0, 10))).toEqual(['2026-08-10', '2026-09-10']);
  });

  it('ignora e limpa overrides para forma de pagamento única', () => {
    const data = utc(2026, 8, 10);
    const input = {
      valorTotal: 1000,
      formaPagamento: PaymentForm.A_VISTA,
      dataPagamento: data,
      installmentDateOverrides: '{"0":"2026-09-20"}',
    };
    expect(buildInstallments(input)[0]?.data).toEqual(data);
    expect(normalizeInstallmentDateOverrides(input)).toBeNull();
  });

  it('normaliza overrides ao reduzir a quantidade e preserva os que seguem no range', () => {
    expect(normalizeInstallmentDateOverrides({
      valorTotal: 2000,
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: 2,
      dataInicioParcela: utc(2026, 8, 10),
      installmentDateOverrides: '{"0":"2026-08-11","1":"2026-09-20","2":"2026-10-20"}',
    })).toBe('{"0":"2026-08-11","1":"2026-09-20"}');
  });

  it('PARCELADO em mês com 31 dias faz clamp para o último dia em fev', () => {
    const out = buildInstallments({
      valorTotal: 300,
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: 3,
      dataInicioParcela: utc(2026, 1, 31),
    });
    expect(out.map((p) => p.data.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });

  it('PARCELADO em ano bissexto usa 29/fev', () => {
    const out = buildInstallments({
      valorTotal: 200,
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: 2,
      dataInicioParcela: utc(2028, 1, 31), // 2028 é bissexto
    });
    expect(out.map((p) => p.data.toISOString().slice(0, 10))).toEqual([
      '2028-01-31',
      '2028-02-29',
    ]);
  });

  it('quantidadeParcela ausente vira 1 e gera uma parcela', () => {
    const out = buildInstallments({
      valorTotal: 500,
      formaPagamento: PaymentForm.PARCELADO,
      dataInicioParcela: utc(2026, 4, 5),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      parcela: '1/1',
      valor: 500,
      data: utc(2026, 4, 5),
    });
  });

  it('PIX é tratado como pagamento único', () => {
    const data = utc(2026, 6, 1);
    const out = buildInstallments({
      valorTotal: 9999,
      formaPagamento: PaymentForm.PIX,
      dataPagamento: data,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ parcela: '1/1', valor: 9999, data });
  });

  it('PAGAMENTO_CONTA é tratado como pagamento único', () => {
    const data = utc(2026, 6, 10);
    const out = buildInstallments({
      valorTotal: 25000,
      formaPagamento: PaymentForm.PAGAMENTO_CONTA,
      dataPagamento: data,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ parcela: '1/1', valor: 25000, data });
  });
});

describe('isSinglePaymentForm', () => {
  it('true para formas únicas (A_VISTA, PIX, PAGAMENTO_CONTA)', () => {
    expect(isSinglePaymentForm(PaymentForm.A_VISTA)).toBe(true);
    expect(isSinglePaymentForm(PaymentForm.PIX)).toBe(true);
    expect(isSinglePaymentForm(PaymentForm.PAGAMENTO_CONTA)).toBe(true);
  });

  it('false para PARCELADO e QUINZENAL', () => {
    expect(isSinglePaymentForm(PaymentForm.PARCELADO)).toBe(false);
    expect(isSinglePaymentForm(PaymentForm.QUINZENAL)).toBe(false);
  });

  it('true para null/undefined/desconhecido (compat com legados do importer)', () => {
    expect(isSinglePaymentForm(null)).toBe(true);
    expect(isSinglePaymentForm(undefined)).toBe(true);
    expect(isSinglePaymentForm('CARTAO_CREDITO')).toBe(true);
    expect(isSinglePaymentForm('CONTA_CORRENTE')).toBe(true);
  });
});
