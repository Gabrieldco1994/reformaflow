/**
 * Regressão: aporte em INVESTIMENTOS sumia da Conta ao ser recategorizado.
 * `isNeutralMovimentacao` é importada do componente (não copiada) para que uma
 * mudança na regra real quebre este teste.
 */
import { describe, expect, it } from 'vitest';
import type { AccountViewMovimentacao } from '../_types';
import { isNeutralMovimentacao } from './MovimentacoesSection';

function makeSaida(overrides: Partial<AccountViewMovimentacao> = {}): AccountViewMovimentacao {
  return {
    kind: 'saida',
    id: 'exp-1',
    descricao: 'Pagamento APTO',
    valor: 65_000,
    data: '2026-08-10',
    tipoDespesa: 'OUTROS',
    forma: 'pix',
    realizado: true,
    editavel: true,
    isInvoice: false,
    cardLast4: null,
    bankLast4: '1234',
    projetoOrigem: null,
    parcelaIndex: null,
    foreignExpenseId: null,
    ...overrides,
  } as AccountViewMovimentacao;
}

describe('isNeutralMovimentacao — aporte não some da Conta', () => {
  it('INVESTIMENTOS permanece visível (não é tratado como neutro)', () => {
    expect(isNeutralMovimentacao(makeSaida({ tipoDespesa: 'INVESTIMENTOS' }))).toBe(false);
  });

  it('despesa comum permanece visível', () => {
    expect(isNeutralMovimentacao(makeSaida({ tipoDespesa: 'ALIMENTACAO' }))).toBe(false);
  });

  it('MOVIMENTACAO_INTERNA continua oculta (settlement)', () => {
    expect(isNeutralMovimentacao(makeSaida({ tipoDespesa: 'MOVIMENTACAO_INTERNA' }))).toBe(true);
  });

  it('PAGAMENTO_CASA continua oculto', () => {
    expect(isNeutralMovimentacao(makeSaida({ tipoDespesa: 'PAGAMENTO_CASA' }))).toBe(true);
  });

  it('fatura de cartão continua visível — é na Conta que se paga', () => {
    expect(
      isNeutralMovimentacao(makeSaida({ tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', isInvoice: true })),
    ).toBe(false);
  });
});
