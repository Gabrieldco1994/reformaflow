import { describe, expect, it } from 'vitest';
import type { Expense } from '@/types';
import { sliceExpensesByPeriod } from './slice-by-period';

describe('sliceExpensesByPeriod — ocorrência PESSOAL', () => {
  it('mantém a identidade sintética da parcela ao fatiar o mês efetivo', () => {
    const expense = {
      id: 'foreign-expense',
      projectId: 'owner-project',
      project: { id: 'owner-project', name: 'Obra', type: 'REFORMA' },
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 30_000,
      quantidade: 1,
      valorTotal: 90_000,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: '2026-08-10',
      installmentDateOverrides: '{"1":"2026-11-20"}',
      status: 'PLANEJADO',
    } as Expense;

    const sliced = sliceExpensesByPeriod(
      [expense],
      '2026-11',
      2026,
      '',
      '',
    );

    expect(sliced).toHaveLength(1);
    expect(sliced[0]).toMatchObject({
      id: 'foreign-expense',
      projectId: 'owner-project',
      occKey: 'foreign-expense#1',
      occIndex: 2,
      occDate: '2026-11-20',
      occValue: 30_000,
    });
  });
});
