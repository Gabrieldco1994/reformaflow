import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Expense } from '@/types';
import type { ExpenseCategoryGroup } from '../_hooks/useExpenseFilters';
import { BulkDateProvider } from './BulkDateSelection';
import { CategoryExpenseView } from './CategoryExpenseView';

const base = {
  tipoDespesa: 'MATERIAL_CONSTRUCAO',
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
  const categorias: ExpenseCategoryGroup[] = [
    {
      tipo: 'MATERIAL_CONSTRUCAO',
      label: 'Material',
      total: 2000,
      totalPago: 0,
      totalPlanejado: 2000,
      expenses: [normal, documented],
    } as ExpenseCategoryGroup,
  ];
  const handlers = {
    openEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggleStatus: vi.fn(),
    onQuickUpdate: vi.fn(),
  };
  const toggle = vi.fn();
  render(
    <BulkDateProvider value={{ selectMode, selectedIds: new Set(), toggle }}>
      <CategoryExpenseView
        categorias={categorias}
        collapsedCategories={new Set()}
        toggleCategory={vi.fn()}
        tipoLabel={(v) => v}
        onQuickCreate={vi.fn()}
        emptyMsg="vazio"
        {...handlers}
      />
    </BulkDateProvider>,
  );
  const rowOf = (title: string) => within(screen.getByText(title).closest('.group') as HTMLElement);
  return { ...handlers, toggle, rowOf };
}

describe('CategoryExpenseView — CTAs financeiras de cronograma documentado (#701)', () => {
  it('não oferece status, edição rápida financeira nem exclusão para documentado', () => {
    const { rowOf, onDelete, onToggleStatus, onQuickUpdate, openEdit } = renderView();
    const doc = rowOf('Documentada');
    const docPill = doc.getByRole('button', { name: /Planejado/ });
    expect(docPill).toBeDisabled();
    expect(doc.getByRole('button', { name: 'Excluir' })).toBeDisabled();
    fireEvent.click(docPill);
    fireEvent.click(doc.getByRole('button', { name: 'Excluir' }));
    // "Editar rápido" leva ao modal descritivo — nunca ao editor inline de valor/data.
    fireEvent.click(doc.getByRole('button', { name: 'Editar rápido' }));
    expect(screen.queryByLabelText('Novo valor')).not.toBeInTheDocument();
    expect(onToggleStatus).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onQuickUpdate).not.toHaveBeenCalled();
    expect(openEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'documented' }));
  });

  it('despesa normal preserva status/exclusão e edição descritiva do documentado segue ativa', () => {
    const { rowOf, onDelete, onToggleStatus, openEdit } = renderView();
    const normalRow = rowOf('Normal');
    fireEvent.click(normalRow.getByTitle('Clique para alternar entre Planejado e Pago'));
    fireEvent.click(normalRow.getByRole('button', { name: 'Excluir' }));
    expect(onToggleStatus).toHaveBeenCalledWith('normal', 'PAGO');
    expect(onDelete).toHaveBeenCalledWith('normal');
    fireEvent.click(rowOf('Documentada').getByRole('button', { name: 'Editar completo' }));
    expect(openEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'documented' }));
  });

  it('modo seleção: checkbox só para despesas normais', () => {
    const { rowOf, toggle } = renderView(true);
    expect(rowOf('Documentada').queryByRole('button', { name: /Marcar|Desmarcar/ })).not.toBeInTheDocument();
    fireEvent.click(rowOf('Normal').getByRole('button', { name: 'Marcar' }));
    expect(toggle).toHaveBeenCalledWith('normal');
  });
});
