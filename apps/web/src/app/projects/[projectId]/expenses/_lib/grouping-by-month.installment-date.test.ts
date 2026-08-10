import { describe, expect, it } from 'vitest';
import type { Expense } from '@/types';
import { groupExpensesByMes } from './grouping-by-month';

describe('groupExpensesByMes — override de parcela', () => {
  it('aplica a data efetiva sem trocar occKey, índice ou valor', () => {
    const expense = {
      id: 'expense-1',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 30_000,
      quantidade: 1,
      valorTotal: 90_001,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataInicioParcela: '2026-08-10',
      installmentDateOverrides: '{"1":"2026-10-20"}',
      status: 'PLANEJADO',
    } as Expense;

    const groups = groupExpensesByMes([expense]);
    const overridden = groups
      .flatMap((group) => group.items)
      .find((occurrence) => occurrence.occIndex === 2);

    expect(overridden).toMatchObject({
      occKey: 'expense-1#1',
      occIndex: 2,
      occDate: '2026-10-20',
      occValue: 30_000,
      valorTotal: 90_001,
    });
  });
});
