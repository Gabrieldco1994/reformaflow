import { describe, it, expect } from 'vitest';
import { caixaMonthForCardPurchase, caixaDateForCardPurchase } from '../src';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('caixaMonthForCardPurchase', () => {
  it('compra ANTES do fechamento → fatura fecha no mês corrente', () => {
    // fecha dia 10, vence dia 20 (dueDay >= closingDay → vence no mesmo mês do fechamento)
    expect(caixaMonthForCardPurchase(utc(2026, 3, 5), 10, 20)).toBe('2026-03');
  });

  it('compra DEPOIS do fechamento → fatura fecha no mês seguinte', () => {
    expect(caixaMonthForCardPurchase(utc(2026, 3, 15), 10, 20)).toBe('2026-04');
  });

  it('compra EXATAMENTE no dia do fechamento → vai para a PRÓXIMA fatura', () => {
    // decisão de produto: dia == closingDay cai na próxima fatura
    expect(caixaMonthForCardPurchase(utc(2026, 3, 10), 10, 20)).toBe('2026-04');
  });

  it('dueDay < closingDay → vencimento no mês seguinte ao fechamento', () => {
    // fecha dia 28, vence dia 7: compra 15/jan fecha 28/jan, vence 07/fev
    expect(caixaMonthForCardPurchase(utc(2026, 1, 15), 28, 7)).toBe('2026-02');
  });

  it('dueDay < closingDay + compra após fechamento', () => {
    // compra 28/jan (>= 28) fecha 28/fev, vence 07/mar
    expect(caixaMonthForCardPurchase(utc(2026, 1, 28), 28, 7)).toBe('2026-03');
  });

  it('dueDay >= closingDay → vencimento no mesmo mês do fechamento', () => {
    expect(caixaMonthForCardPurchase(utc(2026, 6, 3), 5, 15)).toBe('2026-06');
  });

  it('virada de ano: compra em dezembro vence em janeiro do ano seguinte', () => {
    // fecha 28, vence 7: compra 20/dez fecha 28/dez, vence 07/jan/2027
    expect(caixaMonthForCardPurchase(utc(2026, 12, 20), 28, 7)).toBe('2027-01');
  });

  it('virada de ano: compra após fechamento em dezembro pula para fevereiro', () => {
    // compra 29/dez fecha 28/jan/2027, vence 07/fev/2027
    expect(caixaMonthForCardPurchase(utc(2026, 12, 29), 28, 7)).toBe('2027-02');
  });

  it('closingDay nulo → fallback para o mês da própria compra (competência)', () => {
    expect(caixaMonthForCardPurchase(utc(2026, 5, 9), null, 20)).toBe('2026-05');
  });

  it('dueDay nulo → fallback para o mês da própria compra (competência)', () => {
    expect(caixaMonthForCardPurchase(utc(2026, 5, 9), 10, null)).toBe('2026-05');
  });

  it('closingDay 31 não quebra em fevereiro (compra antes do fechamento)', () => {
    // fecha 31, vence 10: compra 27/fev (27 < 31) fecha em fev, vence 10/mar
    expect(caixaMonthForCardPurchase(utc(2026, 2, 27), 31, 10)).toBe('2026-03');
  });

  it('aceita string ISO como data de compra', () => {
    expect(caixaMonthForCardPurchase('2026-03-05T00:00:00.000Z', 10, 20)).toBe('2026-03');
  });

  it('respeita Date com hora (não só meia-noite)', () => {
    // 23:59 no BRT = 02:59 UTC do dia seguinte (dia 10 em UTC).
    // A função usa dia UTC, portanto cai na próxima fatura.
    expect(caixaMonthForCardPurchase(new Date('2026-06-09T23:59:00-03:00'), 10, 20)).toBe('2026-07');
  });
});

describe('caixaDateForCardPurchase', () => {
  it('retorna a data de VENCIMENTO (dueDay) no mês de caixa', () => {
    // fecha 28, vence 7: compra 15/jan vence 07/fev
    expect(caixaDateForCardPurchase(utc(2026, 1, 15), 28, 7).toISOString().slice(0, 10)).toBe('2026-02-07');
  });

  it('compra após o fechamento empurra o vencimento um mês', () => {
    expect(caixaDateForCardPurchase(utc(2026, 1, 28), 28, 7).toISOString().slice(0, 10)).toBe('2026-03-07');
  });

  it('dueDay >= closingDay vence no mesmo mês do fechamento', () => {
    expect(caixaDateForCardPurchase(utc(2026, 6, 3), 5, 15).toISOString().slice(0, 10)).toBe('2026-06-15');
  });

  it('faz clamp do dueDay para o último dia de meses curtos', () => {
    // due 31 em abril (30 dias) → 2026-04-30
    expect(caixaDateForCardPurchase(utc(2026, 4, 5), 10, 31).toISOString().slice(0, 10)).toBe('2026-04-30');
  });

  it('dias nulos → fallback para a própria data da compra (competência)', () => {
    expect(caixaDateForCardPurchase(utc(2026, 5, 9), null, 7).toISOString().slice(0, 10)).toBe('2026-05-09');
  });

  it('é consistente com caixaMonthForCardPurchase (mesmo ano-mês)', () => {
    const d = caixaDateForCardPurchase(utc(2026, 12, 29), 28, 7);
    expect(d.toISOString().slice(0, 7)).toBe(caixaMonthForCardPurchase(utc(2026, 12, 29), 28, 7));
  });
});
