import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExpenseQueryState } from '../_lib/expense-query-state';
import { ActiveExpenseFilterChips } from './ActiveExpenseFilterChips';

const state: ExpenseQueryState = {
  q: 'cimento',
  tipoDespesa: '',
  room: '',
  titulo: '',
  fornecedor: 'Loja A',
  formaPagamento: '',
  status: 'PLANEJADO',
  view: 'general',
  period: '',
  rangeStart: '',
  rangeEnd: '',
  origin: '',
};

describe('ActiveExpenseFilterChips', () => {
  it('removes only the selected active filter and keeps clear as a distinct action', () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    render(<ActiveExpenseFilterChips state={state} onRemove={onRemove} onClear={onClear} />);

    expect(screen.getAllByRole('button')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: /Fornecedor: Loja A/ }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith('fornecedor');
    expect(onClear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('renders nothing when no filter or non-default view is active', () => {
    const { container } = render(
      <ActiveExpenseFilterChips
        state={{ ...state, q: '', fornecedor: '', status: '', view: 'category' }}
        onRemove={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
