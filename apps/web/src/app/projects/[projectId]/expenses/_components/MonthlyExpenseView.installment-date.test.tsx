import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GrupoDespesaPorMes } from '../_lib/grouping-by-month';
import { MonthlyExpenseView } from './MonthlyExpenseView';

describe('MonthlyExpenseView — edição de ocorrência parcelada', () => {
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
});
