import { describe, expect, it } from 'vitest';
import type { Expense } from '@/types';
import { sliceExpensesByPeriod } from './slice-by-period';

describe('sliceExpensesByPeriod — ocorrência PESSOAL', () => {
  it('mantém PARCELADO com dataCompra bruto no mês de competência', () => {
    const expense = {
      id: 'foreign-competencia',
      projectId: 'owner-project',
      project: { id: 'owner-project', name: 'Obra', type: 'REFORMA' },
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 30_000,
      quantidade: 1,
      valorTotal: 90_000,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 3,
      dataCompra: '2026-08-05',
      dataInicioParcela: '2026-09-10',
      installmentDateOverrides: '{"0":"2026-11-20"}',
      status: 'PLANEJADO',
    } as Expense;

    const sliced = sliceExpensesByPeriod([expense], '2026-08', 2026, '', '');

    expect(sliced).toEqual([expense]);
    expect(sliced[0]).not.toHaveProperty('occKey');
  });

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

  it.each(['PARCELADO', 'QUINZENAL'] as const)(
    '%s 1x preserva a ocorrência somente no mês da data efetiva',
    (formaPagamento) => {
      const expense = {
        id: `foreign-${formaPagamento}`,
        projectId: 'owner-project',
        project: { id: 'owner-project', name: 'Obra', type: 'REFORMA' },
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        valor: 30_001,
        quantidade: 1,
        valorTotal: 30_001,
        formaPagamento,
        quantidadeParcela: 1,
        dataInicioParcela: '2026-08-10',
        installmentDateOverrides: '{"0":"2026-11-20"}',
        status: 'PLANEJADO',
      } as Expense;

      const oldMonth = sliceExpensesByPeriod(
        [expense],
        '2026-08',
        2026,
        '',
        '',
      );
      const effectiveMonth = sliceExpensesByPeriod(
        [expense],
        '2026-11',
        2026,
        '',
        '',
      );

      expect(oldMonth).toEqual([]);
      expect(effectiveMonth).toHaveLength(1);
      expect(effectiveMonth[0]).toMatchObject({
        id: `foreign-${formaPagamento}`,
        occKey: `foreign-${formaPagamento}#0`,
        occDate: '2026-11-20',
        occIndex: 1,
        occTotalParcelas: 1,
        occValue: 30_001,
        valor: 30_001,
        valorTotal: 30_001,
        status: 'PLANEJADO',
      });
    },
  );

  it('mantém A_VISTA bruto, sem identidade sintética de parcela', () => {
    const expense = {
      id: 'foreign-avista',
      projectId: 'owner-project',
      project: { id: 'owner-project', name: 'Obra', type: 'REFORMA' },
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 30_001,
      quantidade: 1,
      valorTotal: 30_001,
      formaPagamento: 'A_VISTA',
      dataPagamento: '2026-08-10',
      installmentDateOverrides: '{"0":"2026-11-20"}',
      status: 'PAGO',
    } as Expense;

    const originalMonth = sliceExpensesByPeriod(
      [expense],
      '2026-08',
      2026,
      '',
      '',
    );
    const overrideMonth = sliceExpensesByPeriod(
      [expense],
      '2026-11',
      2026,
      '',
      '',
    );

    expect(originalMonth).toEqual([expense]);
    expect(originalMonth[0]).not.toHaveProperty('occKey');
    expect(overrideMonth).toEqual([]);
  });
});
