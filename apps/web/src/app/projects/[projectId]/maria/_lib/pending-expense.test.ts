import { describe, expect, it } from 'vitest';
import { detectPendingExpenseConfirmation } from './pending-expense';

describe('detectPendingExpenseConfirmation', () => {
  it('detecta cartão de conferência quando o agente resume e pede confirmação', () => {
    const result = detectPendingExpenseConfirmation({
      role: 'assistant',
      content:
        'Entendi assim — confere? R$ 45,00 · Supermercado · cartão Mastercard •5876 · hoje, 11 jul. Cai na fatura que fecha 5 ago.',
      toolsUsed: [],
    });
    expect(result).not.toBeNull();
    expect(result?.valorLabel).toBe('R$ 45,00');
  });

  it('não vira cartão se create_expense já foi chamado (despesa já criada)', () => {
    const result = detectPendingExpenseConfirmation({
      role: 'assistant',
      content: 'Lançado ✓ R$ 45,00 em Supermercado no Mastercard •5876. Confere?',
      toolsUsed: ['create_expense'],
    });
    expect(result).toBeNull();
  });

  it('não vira cartão sem valor em R$ reconhecível', () => {
    const result = detectPendingExpenseConfirmation({
      role: 'assistant',
      content: 'Entendi assim — confere?',
      toolsUsed: [],
    });
    expect(result).toBeNull();
  });

  it('não vira cartão sem frase de confirmação/resumo (resposta comum)', () => {
    const result = detectPendingExpenseConfirmation({
      role: 'assistant',
      content: 'Você tem R$ 6,4 mil em caixa hoje.',
      toolsUsed: ['get_account_balances'],
    });
    expect(result).toBeNull();
  });

  it('ignora mensagens do usuário', () => {
    const result = detectPendingExpenseConfirmation({
      role: 'user',
      content: 'quarenta e cinco no mercado no mastercard, confere?',
    });
    expect(result).toBeNull();
  });

  it('detecta variação "nova despesa" sem ponto de interrogação', () => {
    const result = detectPendingExpenseConfirmation({
      role: 'assistant',
      content: 'Nova despesa: R$ 30,00 de Uber, hoje. Correto?',
      toolsUsed: [],
    });
    // "Correto?" não está na lista de frases-gatilho, mas "nova despesa" é hint suficiente.
    expect(result).not.toBeNull();
  });
});
