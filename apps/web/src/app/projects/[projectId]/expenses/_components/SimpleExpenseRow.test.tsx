import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SimpleExpenseRow } from './SimpleExpenseRow';
import type { Expense } from '@/types';

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1',
    tipoDespesa: 'GASOLINA',
    valor: 15_000,
    quantidade: 1,
    valorTotal: 15_000,
    titulo: 'Posto Shell',
    formaPagamento: 'A_VISTA',
    dataPagamento: '2026-07-10T00:00:00.000Z',
    status: 'PLANEJADO',
    ...overrides,
  } as Expense;
}

describe('SimpleExpenseRow', () => {
  it('mostra título, valor nowrap e status "A pagar" por padrão', () => {
    render(
      <SimpleExpenseRow
        expense={makeExpense()}
        onEdit={vi.fn()}
        onToggleStatus={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('Posto Shell')).toBeInTheDocument();
    expect(screen.getByText(/150,00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /a pagar/i })).toBeInTheDocument();
  });

  it('clique no status chama onToggleStatus com o id', () => {
    const onToggleStatus = vi.fn();
    render(
      <SimpleExpenseRow
        expense={makeExpense()}
        onEdit={vi.fn()}
        onToggleStatus={onToggleStatus}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /a pagar/i }));
    expect(onToggleStatus).toHaveBeenCalledWith('exp-1', 'PLANEJADO');
  });

  it('clique no título ou no botão editar chama onEdit', () => {
    const onEdit = vi.fn();
    render(
      <SimpleExpenseRow
        expense={makeExpense()}
        onEdit={onEdit}
        onToggleStatus={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /editar/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('excluir pede confirmação e só chama onDelete se confirmado', () => {
    const onDelete = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <SimpleExpenseRow
        expense={makeExpense()}
        onEdit={vi.fn()}
        onToggleStatus={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /excluir/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith('exp-1');
    confirmSpy.mockRestore();
  });

  it('status "Paga" quando expense.status é PAGO', () => {
    render(
      <SimpleExpenseRow
        expense={makeExpense({ status: 'PAGO' })}
        onEdit={vi.fn()}
        onToggleStatus={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^paga$/i })).toBeInTheDocument();
  });

  it('sem data de pagamento, mostra só o tipo (sem traço solto)', () => {
    render(
      <SimpleExpenseRow
        expense={makeExpense({ dataPagamento: undefined })}
        onEdit={vi.fn()}
        onToggleStatus={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('Combustível')).toBeInTheDocument();
    expect(screen.queryByText(/^- ·/)).not.toBeInTheDocument();
  });
});
