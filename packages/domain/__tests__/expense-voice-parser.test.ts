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

  describe('auto-vínculo de cartão/conta/projeto', () => {
    const cards = [
      { id: 'card-personnalite', last4: '5868', nickname: 'Itaú Personnalité', brand: 'Mastercard' },
      { id: 'card-nubank', last4: '8838', nickname: 'Nubank UV', brand: 'Mastercard' },
      { id: 'card-latam', last4: '7259', nickname: 'Latampass', brand: 'Visa' },
    ];
    const accounts = [
      { id: 'acc-itau', last4: '3636', nickname: 'Itaú Pessoal', institution: 'Itaú' },
    ];
    const projects = [
      { id: 'pj-pessoal', name: 'Meu Pessoal', type: 'PESSOAL' },
      { id: 'pj-reforma', name: 'Reforma Apto', type: 'REFORMA' },
      { id: 'pj-carro', name: 'Hilux 2020', type: 'CARRO' },
    ];

    it('detecta cartão por last4 no texto', () => {
      const parsed = parseVoiceExpense({
        transcript: 'paguei 200 reais no mercado no 5868',
        allowedExpenseTypes: [ExpenseType.ALIMENTACAO],
        defaultExpenseType: ExpenseType.ALIMENTACAO,
        cards,
        now,
      });
      expect(parsed.creditCardId).toBe('card-personnalite');
    });

    it('detecta cartão por nickname (nubank)', () => {
      const parsed = parseVoiceExpense({
        transcript: 'gastei 150 no nubank ontem',
        allowedExpenseTypes: [ExpenseType.OUTROS],
        defaultExpenseType: ExpenseType.OUTROS,
        cards,
        now,
      });
      expect(parsed.creditCardId).toBe('card-nubank');
    });

    it('detecta conta bancária quando frase tem pix/débito', () => {
      const parsed = parseVoiceExpense({
        transcript: 'transferi 500 reais por pix do itau',
        allowedExpenseTypes: [ExpenseType.OUTROS],
        defaultExpenseType: ExpenseType.OUTROS,
        accounts,
        now,
      });
      expect(parsed.bankAccountId).toBe('acc-itau');
      expect(parsed.creditCardId).toBeNull();
    });

    it('NÃO confunde "cartão de crédito" com conta', () => {
      const parsed = parseVoiceExpense({
        transcript: 'paguei 80 no cartao de credito do itau',
        allowedExpenseTypes: [ExpenseType.OUTROS],
        defaultExpenseType: ExpenseType.OUTROS,
        accounts,
        cards,
        now,
      });
      expect(parsed.bankAccountId).toBeNull();
    });

    it('detecta projeto cross "para a reforma"', () => {
      const parsed = parseVoiceExpense({
        transcript: 'comprei 300 de cimento no 5868 para a reforma',
        allowedExpenseTypes: [ExpenseType.MATERIAL_CONSTRUCAO, ExpenseType.OUTROS],
        defaultExpenseType: ExpenseType.OUTROS,
        cards,
        projects,
        currentProjectId: 'pj-pessoal',
        now,
      });
      expect(parsed.creditCardId).toBe('card-personnalite');
      expect(parsed.linkedProjectId).toBe('pj-reforma');
    });

    it('detecta projeto cross por nome ("hilux")', () => {
      const parsed = parseVoiceExpense({
        transcript: 'gastei 220 com oleo do hilux',
        allowedExpenseTypes: [ExpenseType.OUTROS],
        defaultExpenseType: ExpenseType.OUTROS,
        projects,
        currentProjectId: 'pj-pessoal',
        now,
      });
      expect(parsed.linkedProjectId).toBe('pj-carro');
    });

    it('NÃO auto-linka para o próprio projeto', () => {
      const parsed = parseVoiceExpense({
        transcript: 'gastei 100 reais na reforma',
        allowedExpenseTypes: [ExpenseType.OUTROS],
        defaultExpenseType: ExpenseType.OUTROS,
        projects,
        currentProjectId: 'pj-reforma',
        now,
      });
      expect(parsed.linkedProjectId).toBeNull();
    });
  });
});
