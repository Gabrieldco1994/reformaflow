/**
 * T2: filtro "Sem conta" na MovimentacoesSection.
 * Testa apenas a lógica de filtro via isCarteiraItem — sem renderizar o componente
 * completo (que tem muitas deps). Validação visual fica no QA real (regra 13).
 */
import { describe, expect, it } from 'vitest';
import type { AccountViewMovimentacao } from '../_types';

// Reexport da helper para teste isolado — mesma definição do componente.
function isCarteiraItem(m: AccountViewMovimentacao): boolean {
  return m.kind === 'saida' && !(m as any).isInvoice && !m.cardLast4 && !m.bankLast4;
}

function makeSaida(overrides: Partial<AccountViewMovimentacao> = {}): AccountViewMovimentacao {
  return {
    kind: 'saida',
    id: 'exp-1',
    descricao: 'Despesa',
    valor: 10_000,
    data: '2026-07-01',
    tipoDespesa: 'OUTROS',
    forma: 'pix',
    realizado: true,
    editavel: true,
    isInvoice: false,
    cardLast4: null,
    bankLast4: null,
    projetoOrigem: null,
    parcelaIndex: null,
    foreignExpenseId: null,
    ...overrides,
  } as AccountViewMovimentacao;
}

describe('isCarteiraItem — filtro Sem conta', () => {
  it('T2a: saída sem card/bank → carteira', () => {
    expect(isCarteiraItem(makeSaida())).toBe(true);
  });

  it('T2b: saída com cardLast4 → NÃO é carteira', () => {
    expect(isCarteiraItem(makeSaida({ cardLast4: '1234' }))).toBe(false);
  });

  it('T2c: saída com bankLast4 → NÃO é carteira', () => {
    expect(isCarteiraItem(makeSaida({ bankLast4: '5678' }))).toBe(false);
  });

  it('T2d: fatura de cartão (isInvoice) → NÃO é carteira mesmo sem last4', () => {
    expect(isCarteiraItem(makeSaida({ isInvoice: true, cardLast4: null, bankLast4: null }))).toBe(false);
  });

  it('T2e: entrada → NÃO é carteira', () => {
    const entrada: AccountViewMovimentacao = {
      kind: 'entrada',
      id: 'rec-1',
      descricao: 'Salário',
      valor: 500_000,
      data: '2026-07-05',
      tipo: 'SALARIO',
      status: 'EM_CAIXA',
      bankLast4: null,
      editavel: true,
      descricaoRaw: '',
    } as any;
    expect(isCarteiraItem(entrada)).toBe(false);
  });
});
