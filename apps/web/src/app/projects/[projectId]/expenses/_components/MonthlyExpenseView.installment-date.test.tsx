import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { groupExpensesByMes, type GrupoDespesaPorMes } from '../_lib/grouping-by-month';
import type { Expense } from '@/types';
import { MonthlyExpenseView } from './MonthlyExpenseView';

describe('MonthlyExpenseView — edição de ocorrência parcelada', () => {
  it('#701 renders documented labels but toggles local indices and opens metadata-only editing', () => {
    const expense: Expense = {
      id: 'documented',
      tipoDespesa: 'OUTROS',
      valor: 9753,
      quantidade: 1,
      valorTotal: 9753,
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 2,
      dataInicioParcela: '2026-08-10',
      status: 'PLANEJADO',
      schedule: {
        version: 1,
        occurrences: [
          { index: 0, parcela: '2/3', valor: 10001, data: '2026-08-10', invoiceDueMonth: '2026-10' },
          { index: 1, parcela: '3/3', valor: -248, data: '2026-08-28', invoiceDueMonth: '2026-09' },
        ],
      },
    };
    const onToggleParcela = vi.fn();
    const onQuickUpdate = vi.fn();
    const openEdit = vi.fn();
    render(
      <MonthlyExpenseView
        grouped={groupExpensesByMes([expense])}
        collapsedMonths={new Set()}
        toggleMonth={vi.fn()}
        tipoLabel={(value) => value}
        tipoOptions={[]}
        openEdit={openEdit}
        onDelete={vi.fn()}
        onToggleStatus={vi.fn()}
        onToggleParcela={onToggleParcela}
        onQuickUpdate={onQuickUpdate}
        onQuickCreate={vi.fn()}
        emptyMsg="vazio"
      />,
    );
    expect(screen.getByText('parcela 2/3')).toBeInTheDocument();
    expect(screen.getByText('parcela 3/3')).toBeInTheDocument();
    expect(screen.getByText(/-.*2,48/)).toBeInTheDocument();
    const toggles = screen.getAllByTitle('Clique para alternar entre Planejado e Pago');
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    expect(onToggleParcela.mock.calls).toEqual([
      ['documented', 0, true], ['documented', 1, true],
    ]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Editar rápido' })[1]);
    expect(openEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'documented', schedule: expense.schedule }));
    expect(onQuickUpdate).not.toHaveBeenCalled();
  });

  it('abre na occDate e envia índice 0-based sem permitir/enviar valor', () => {
    const onQuickUpdate = vi.fn();
    const grouped: GrupoDespesaPorMes[] = [
      {
        mesKey: '2026-10',
        mesLabel: 'Outubro 2026',
        total: 30_000,
        totalPago: 0,
        totalPlanejado: 30_000,
        isCurrentMonth: false,
        isFuture: true,
        items: [
          {
            id: 'expense-1',
            tipoDespesa: 'MATERIAL_CONSTRUCAO',
            valor: 30_000,
            quantidade: 1,
            valorTotal: 90_000,
            formaPagamento: 'PARCELADO',
            quantidadeParcela: 3,
            dataInicioParcela: '2026-08-10',
            status: 'PLANEJADO',
            occKey: 'expense-1#1',
            occDate: '2026-10-20',
            occValue: 30_000,
            occIndex: 2,
            occTotalParcelas: 3,
          },
        ],
      },
    ];

    render(
      <MonthlyExpenseView
        grouped={grouped}
        collapsedMonths={new Set()}
        toggleMonth={vi.fn()}
        tipoLabel={(value) => value}
        tipoOptions={[]}
        openEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleStatus={vi.fn()}
        onQuickUpdate={onQuickUpdate}
        onQuickCreate={vi.fn()}
        emptyMsg="vazio"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Editar rápido' }));

    const dateInput = screen.getByLabelText('Nova data da parcela 2');
    expect(dateInput).toHaveValue('2026-10-20');
    expect(screen.queryByPlaceholderText('Valor')).not.toBeInTheDocument();

    fireEvent.change(dateInput, { target: { value: '2026-09-05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar data da parcela' }));

    expect(onQuickUpdate).toHaveBeenCalledWith({
      id: 'expense-1',
      data: '2026-09-05',
      parcela: 1,
    });
  });

  it.each(['PARCELADO', 'QUINZENAL'] as const)(
    '%s 1x usa a mutation dedicada da parcela 0 e mantém o valor somente leitura',
    (formaPagamento) => {
      const onQuickUpdate = vi.fn();
      const grouped: GrupoDespesaPorMes[] = [
        {
          mesKey: '2026-08',
          mesLabel: 'Agosto 2026',
          total: 30_000,
          totalPago: 0,
          totalPlanejado: 30_000,
          isCurrentMonth: false,
          isFuture: true,
          items: [
            {
              id: `expense-${formaPagamento}`,
              tipoDespesa: 'MATERIAL_CONSTRUCAO',
              valor: 30_000,
              quantidade: 1,
              valorTotal: 30_000,
              formaPagamento,
              quantidadeParcela: 1,
              dataInicioParcela: '2026-08-10',
              status: 'PLANEJADO',
              occKey: `expense-${formaPagamento}#0`,
              occDate: '2026-08-10',
              occValue: 30_000,
              occIndex: 1,
              occTotalParcelas: 1,
            },
          ],
        },
      ];

      render(
        <MonthlyExpenseView
          grouped={grouped}
          collapsedMonths={new Set()}
          toggleMonth={vi.fn()}
          tipoLabel={(value) => value}
          tipoOptions={[]}
          openEdit={vi.fn()}
          onDelete={vi.fn()}
          onToggleStatus={vi.fn()}
          onQuickUpdate={onQuickUpdate}
          onQuickCreate={vi.fn()}
          emptyMsg="vazio"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Editar rápido' }));

      const dateInput = screen.getByLabelText('Nova data da parcela 1');
      expect(screen.queryByPlaceholderText('Valor')).not.toBeInTheDocument();
      fireEvent.change(dateInput, { target: { value: '2026-08-20' } });
      fireEvent.click(
        screen.getByRole('button', { name: 'Salvar data da parcela' }),
      );

      expect(onQuickUpdate).toHaveBeenCalledWith({
        id: `expense-${formaPagamento}`,
        data: '2026-08-20',
        parcela: 0,
      });
    },
  );
});
