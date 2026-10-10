import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Expense } from '@/types';
import { groupExpensesByMes } from '../_lib/grouping-by-month';
import { BulkDateProvider } from './BulkDateSelection';
import { MonthlyExpenseView } from './MonthlyExpenseView';

const base = {
  tipoDespesa: 'OUTROS',
  valor: 1000,
  quantidade: 1,
  valorTotal: 1000,
  formaPagamento: 'A_VISTA',
  dataPagamento: '2026-08-10',
  status: 'PLANEJADO',
} as const;

const normal: Expense = { ...base, id: 'normal', titulo: 'Normal' };
const documented: Expense = {
  ...base,
  id: 'documented',
  titulo: 'Documentada',
  schedule: {
    version: 1,
    occurrences: [{ index: 0, parcela: null, valor: 1000, data: '2026-08-10', invoiceDueMonth: null }],
  },
};

function renderView(selectMode = false) {
  const handlers = {
    openEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggleStatus: vi.fn(),
    onToggleParcela: vi.fn(),
    onChangeTipo: vi.fn(),
    onQuickUpdate: vi.fn(),
  };
  const toggle = vi.fn();
  render(
    <BulkDateProvider value={{ selectMode, selectedIds: new Set(), toggle }}>
      <MonthlyExpenseView
        grouped={groupExpensesByMes([normal, documented])}
        collapsedMonths={new Set()}
        toggleMonth={vi.fn()}
        tipoLabel={(v) => v}
        tipoOptions={[{ value: 'OUTROS', label: 'Outros' }]}
        onQuickCreate={vi.fn()}
        emptyMsg="vazio"
        {...handlers}
      />
    </BulkDateProvider>,
  );
  const rowOf = (title: string) => within(screen.getByText(title).closest('.group') as HTMLElement);
  return { ...handlers, toggle, rowOf };
}

describe('MonthlyExpenseView — CTAs financeiras de cronograma documentado (#701)', () => {
  it('não oferece status nem exclusão para documentado; despesa normal segue interativa', () => {
    const { rowOf, onDelete, onToggleStatus, onToggleParcela } = renderView();
    const doc = rowOf('Documentada');
    const normalRow = rowOf('Normal');

    const docPill = doc.getByRole('button', { name: /Planejado/ });
    expect(docPill).toBeDisabled();
    expect(doc.getByRole('button', { name: 'Excluir' })).toBeDisabled();
    fireEvent.click(docPill);
    fireEvent.click(doc.getByRole('button', { name: 'Excluir' }));
    expect(onToggleStatus).not.toHaveBeenCalled();
    expect(onToggleParcela).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    expect(normalRow.getByTitle('Clique para alternar entre Planejado e Pago')).toBeEnabled();
    expect(normalRow.getByRole('button', { name: 'Excluir' })).toBeEnabled();
    fireEvent.click(normalRow.getByTitle('Clique para alternar entre Planejado e Pago'));
    fireEvent.click(normalRow.getByRole('button', { name: 'Excluir' }));
    expect(onToggleStatus).toHaveBeenCalledWith('normal', 'PAGO');
    expect(onDelete).toHaveBeenCalledWith('normal');
  });

  it('edição descritiva do documentado continua disponível (modal completo)', () => {
    const { rowOf, openEdit, onQuickUpdate } = renderView();
    const doc = rowOf('Documentada');
    expect(doc.getByRole('button', { name: 'Editar completo' })).toBeEnabled();
    fireEvent.click(doc.getByRole('button', { name: 'Editar completo' }));
    fireEvent.click(doc.getByRole('button', { name: 'Editar rápido' }));
    expect(openEdit).toHaveBeenCalledTimes(2);
    expect(openEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'documented' }));
    expect(onQuickUpdate).not.toHaveBeenCalled();
  });

  it('modo seleção: checkbox só para despesas normais', () => {
    const { rowOf, toggle } = renderView(true);
    expect(rowOf('Documentada').queryByRole('button', { name: /Marcar|Desmarcar/ })).not.toBeInTheDocument();
    fireEvent.click(rowOf('Normal').getByRole('button', { name: 'Marcar' }));
    expect(toggle).toHaveBeenCalledWith('normal');
  });
});
