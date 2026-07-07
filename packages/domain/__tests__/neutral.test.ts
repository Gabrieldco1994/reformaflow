import { describe, it, expect } from 'vitest';
import {
  isNeutralExpenseType,
  isConsumptionNeutralExpenseType,
  isNeutralReceiptType,
} from '../src/enums';

describe('neutro-de-caixa (settlement) — inalterado', () => {
  it('PAGAMENTO_FATURA_CARTAO e MOVIMENTACAO_INTERNA são settlement', () => {
    expect(isNeutralExpenseType('PAGAMENTO_FATURA_CARTAO')).toBe(true);
    expect(isNeutralExpenseType('MOVIMENTACAO_INTERNA')).toBe(true);
  });
  it('INVESTIMENTOS NÃO é settlement (não pode sumir do eixo caixa/§10)', () => {
    expect(isNeutralExpenseType('INVESTIMENTOS')).toBe(false);
  });
  it('PAGAMENTO_CASA NÃO é settlement (continua saindo do caixa/§10)', () => {
    expect(isNeutralExpenseType('PAGAMENTO_CASA')).toBe(false);
  });
  it('boundary: null/undefined/desconhecido → false', () => {
    expect(isNeutralExpenseType(null)).toBe(false);
    expect(isNeutralExpenseType(undefined)).toBe(false);
    expect(isNeutralExpenseType('MORADIA')).toBe(false);
  });
});

describe('neutro-de-consumo — superset com INVESTIMENTOS', () => {
  it('inclui os dois settlement E INVESTIMENTOS', () => {
    expect(isConsumptionNeutralExpenseType('PAGAMENTO_FATURA_CARTAO')).toBe(true);
    expect(isConsumptionNeutralExpenseType('MOVIMENTACAO_INTERNA')).toBe(true);
    expect(isConsumptionNeutralExpenseType('INVESTIMENTOS')).toBe(true);
  });
  it('PAGAMENTO_CASA é neutro-de-consumo (sai dos KPIs, mas fica no caixa)', () => {
    expect(isConsumptionNeutralExpenseType('PAGAMENTO_CASA')).toBe(true);
  });
  it('não inclui consumo real', () => {
    expect(isConsumptionNeutralExpenseType('MORADIA')).toBe(false);
    expect(isConsumptionNeutralExpenseType('ALIMENTACAO')).toBe(false);
  });
  it('boundary: null/undefined → false', () => {
    expect(isConsumptionNeutralExpenseType(null)).toBe(false);
    expect(isConsumptionNeutralExpenseType(undefined)).toBe(false);
  });
});

describe('neutro-de-receita (simetria resgate)', () => {
  it('RESGATE é receita-neutra; rendimentos e salário não', () => {
    expect(isNeutralReceiptType('RESGATE')).toBe(true);
    expect(isNeutralReceiptType('TRANSFERENCIA_PROPRIA')).toBe(true);
    expect(isNeutralReceiptType('JUROS_RENDA_FIXA')).toBe(false); // rendimento = renda real
    expect(isNeutralReceiptType('DIVIDENDOS')).toBe(false);
    expect(isNeutralReceiptType('SALARIO')).toBe(false);
  });
  it('boundary: null/undefined → false', () => {
    expect(isNeutralReceiptType(null)).toBe(false);
    expect(isNeutralReceiptType(undefined)).toBe(false);
  });
});
