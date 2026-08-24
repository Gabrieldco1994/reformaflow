import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PersonalExpenseCard from './PersonalExpenseCard';
import type { Expense } from '@/types';

describe('PersonalExpenseCard', () => {
  const baseExpense: Expense = {
    id: 'exp-1',
    projectId: 'proj-1',
    titulo: 'Mercado',
    tipoDespesa: 'MERCADO',
    valorTotal: 10000,
    valor: 10000,
    quantidade: 1,
    status: 'PLANEJADO',
    formaPagamento: 'A_VISTA',
    cardLast4: null,
    bankLast4: '1234',
    recorrente: false,
  };

  it('should toggle status when caixa mode allows', async () => {
    const onToggleStatus = vi.fn();
    const user = userEvent.setup();

    const { container } = render(
      <PersonalExpenseCard
        expense={baseExpense}
        tipoLabel={(t) => t}
        cashMode="caixa"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleStatus={onToggleStatus}
      />,
    );

    // Find status button
    const statusButtons = container.querySelectorAll('button[title="Alternar status"]');
    const statusButton = statusButtons[0] as HTMLButtonElement;
    expect(statusButton).toBeDefined();

    await user.click(statusButton);

    // Should call onToggleStatus with PAGO (opposite of current PLANEJADO status)
    expect(onToggleStatus).toHaveBeenCalledWith('exp-1', 'PAGO');
  });

  it('should NOT toggle status for card expenses in competencia mode', async () => {
    const onToggleStatus = vi.fn();
    const user = userEvent.setup();

    const cardExpense: Expense = {
      ...baseExpense,
      cardLast4: '4242',
    };

    const { container } = render(
      <PersonalExpenseCard
        expense={cardExpense}
        tipoLabel={(t) => t}
        cashMode="competencia"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleStatus={onToggleStatus}
      />,
    );

    const statusButtons = container.querySelectorAll('button[title="Alternar status"]');
    const statusButton = statusButtons[0] as HTMLButtonElement;

    await user.click(statusButton);

    // Should NOT call onToggleStatus for card expenses in competencia mode
    expect(onToggleStatus).not.toHaveBeenCalled();
  });
});
