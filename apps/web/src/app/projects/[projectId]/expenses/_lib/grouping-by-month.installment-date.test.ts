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

  it.each(['PARCELADO', 'QUINZENAL'] as const)(
    '%s 1x aparece somente na data efetiva como parcela 1/1',
    (formaPagamento) => {
      const expense = {
        id: `expense-${formaPagamento}`,
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 30_001,
        quantidade: 1,
        valorTotal: 30_001,
        formaPagamento,
        quantidadeParcela: 1,
        dataInicioParcela: '2026-08-10',
        installmentDateOverrides: '{"0":"2026-10-20"}',
        status: 'PLANEJADO',
      } as Expense;

      const groups = groupExpensesByMes([expense]);

      expect(groups.map((group) => group.mesKey)).toEqual(['2026-10']);
      expect(groups[0].items).toHaveLength(1);
      expect(groups[0].items[0]).toMatchObject({
        occKey: `expense-${formaPagamento}#0`,
        occDate: '2026-10-20',
        occIndex: 1,
        occTotalParcelas: 1,
        occValue: 30_001,
        status: 'PLANEJADO',
      });
    },
  );

  it('mantém A_VISTA como pagamento único e ignora override de parcela', () => {
    const expense = {
      id: 'expense-avista',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 30_001,
      quantidade: 1,
      valorTotal: 30_001,
      formaPagamento: 'A_VISTA',
      dataPagamento: '2026-08-10',
      installmentDateOverrides: '{"0":"2026-10-20"}',
      status: 'PAGO',
    } as Expense;

    const groups = groupExpensesByMes([expense]);

    expect(groups.map((group) => group.mesKey)).toEqual(['2026-08']);
    expect(groups[0].items[0]).toMatchObject({
      occKey: 'expense-avista',
      occDate: '2026-08-10',
      occValue: 30_001,
      status: 'PAGO',
    });
    expect(groups[0].items[0].occKey).not.toContain('#');
  });
});
