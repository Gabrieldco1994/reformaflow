import { describe, it, expect } from 'vitest';
import { selectEligibleForBulkLink } from './bulkLinkEligibility';
import type { Expense } from '@/types';

function exp(patch: Partial<Expense>): Expense {
  return {
    id: 'e1',
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valor: 100,
    quantidade: 1,
    valorTotal: 10000,
    formaPagamento: 'A_VISTA',
    status: 'PAGO',
    ...patch,
  };
}

describe('selectEligibleForBulkLink', () => {
  it('does not offer credit or zero-value rows to the positive-payment flow', () => {
    expect(
      selectEligibleForBulkLink([
        exp({ id: 'credit', valorTotal: -40_000 }),
        exp({ id: 'zero', valorTotal: 0 }),
        exp({ id: 'positive', valorTotal: 40_000 }),
      ]).map((row) => row.id),
    ).toEqual(['positive']);
  });
  it('lista vazia → []', () => {
    expect(selectEligibleForBulkLink([])).toEqual([]);
  });

  it('exclui despesas com linkedExpenseId preenchido', () => {
    const list = [exp({ id: 'e1', linkedExpenseId: 'target-1' })];
    expect(selectEligibleForBulkLink(list)).toEqual([]);
  });

  it('exclui despesas de tipo neutro', () => {
    const list = [exp({ id: 'e1', tipoDespesa: 'MOVIMENTACAO_INTERNA' })];
    expect(selectEligibleForBulkLink(list)).toEqual([]);
  });

  it('inclui despesa normal (sem link, não-neutra)', () => {
    const list = [exp({ id: 'e1', linkedExpenseId: null, tipoDespesa: 'MATERIAL_CONSTRUCAO' })];
    expect(selectEligibleForBulkLink(list)).toHaveLength(1);
  });

  it('exclui quando ambas as razões se aplicam (linked + neutro)', () => {
    const list = [
      exp({ id: 'e1', linkedExpenseId: 'target-1', tipoDespesa: 'MOVIMENTACAO_INTERNA' }),
    ];
    expect(selectEligibleForBulkLink(list)).toEqual([]);
  });

  it('mistura: retorna só as elegíveis', () => {
    const list = [
      exp({ id: 'e1', linkedExpenseId: null, tipoDespesa: 'MATERIAL_CONSTRUCAO' }),
      exp({ id: 'e2', linkedExpenseId: 'x', tipoDespesa: 'MATERIAL_CONSTRUCAO' }),
      exp({ id: 'e3', linkedExpenseId: null, tipoDespesa: 'MOVIMENTACAO_INTERNA' }),
    ];
    const result = selectEligibleForBulkLink(list);
    expect(result.map((e) => e.id)).toEqual(['e1']);
  });
});
