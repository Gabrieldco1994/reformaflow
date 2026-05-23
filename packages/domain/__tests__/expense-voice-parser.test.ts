import { describe, expect, it } from 'vitest';
import { ExpenseStatus, ExpenseType, PaymentForm, parseVoiceExpense } from '../src';

describe('parseVoiceExpense', () => {
  const now = new Date('2026-05-22T12:00:00.000Z');

  it('interpreta frase pessoal com valor, categoria e forma', () => {
    const parsed = parseVoiceExpense({
      transcript: 'Gastei 85 reais no mercado no cartao hoje',
      allowedExpenseTypes: [
        ExpenseType.ALIMENTACAO,
        ExpenseType.CARTAO_CREDITO,
        ExpenseType.TRANSPORTE,
      ],
      defaultExpenseType: ExpenseType.ALIMENTACAO,
      now,
    });

    expect(parsed.valor).toBe(85);
    expect(parsed.tipoDespesa).toBe(ExpenseType.ALIMENTACAO);
    expect(parsed.formaPagamento).toBe(PaymentForm.PARCELADO);
    expect(parsed.status).toBe(ExpenseStatus.PLANEJADO);
    expect(parsed.dataReferencia).toBe('2026-05-22');
  });

  it('identifica parcela e status pago', () => {
    const parsed = parseVoiceExpense({
      transcript: 'Paguei 1200 reais de material de construcao em 10x amanha',
      allowedExpenseTypes: [ExpenseType.MATERIAL_CONSTRUCAO, ExpenseType.MAO_DE_OBRA],
      defaultExpenseType: ExpenseType.MATERIAL_CONSTRUCAO,
      now,
    });

    expect(parsed.valor).toBe(1200);
    expect(parsed.tipoDespesa).toBe(ExpenseType.MATERIAL_CONSTRUCAO);
    expect(parsed.formaPagamento).toBe(PaymentForm.PARCELADO);
    expect(parsed.quantidadeParcela).toBe(10);
    expect(parsed.status).toBe(ExpenseStatus.PAGO);
    expect(parsed.dataReferencia).toBe('2026-05-23');
  });

  it('mantem fallback de tipo quando não reconhece categoria', () => {
    const parsed = parseVoiceExpense({
      transcript: 'Despesa avulsa 37,90 dia 30',
      allowedExpenseTypes: [ExpenseType.OUTROS, ExpenseType.IMPREVISTOS],
      defaultExpenseType: ExpenseType.OUTROS,
      now,
    });

    expect(parsed.valor).toBe(37.9);
    expect(parsed.tipoDespesa).toBe(ExpenseType.OUTROS);
    expect(parsed.dataReferencia).toBe('2026-05-30');
    expect(parsed.formaPagamento).toBe(PaymentForm.A_VISTA);
    expect(parsed.quantidadeParcela).toBeNull();
  });

  it('retorna valor nulo quando não encontra número', () => {
    const parsed = parseVoiceExpense({
      transcript: 'gasto mercado cartao',
      allowedExpenseTypes: [ExpenseType.ALIMENTACAO],
      defaultExpenseType: ExpenseType.ALIMENTACAO,
      now,
    });
    expect(parsed.valor).toBeNull();
  });
});
