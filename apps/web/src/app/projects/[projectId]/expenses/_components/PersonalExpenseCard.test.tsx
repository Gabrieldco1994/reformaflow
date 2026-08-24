import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('garante piso de 44x44px de área tocável no botão de status (min-h-11 min-w-11)', () => {
    const onToggleStatus = vi.fn();

    const { container } = render(
      <PersonalExpenseCard
        expense={baseExpense}
        tipoLabel={(t) => t}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleStatus={onToggleStatus}
      />,
    );

    const statusButton = container.querySelector('button[title="Alternar status"]');
    expect(statusButton).not.toBeNull();

    const classList = Array.from(statusButton!.classList);
    // min-h-11 / min-w-11 = 2.75rem = 44px, independente do padding ou do
    // texto — jsdom não calcula layout real (getBoundingClientRect sempre
    // zero aqui), então a prova de dimensão real é o teste e2e; isto é o
    // guard-rail que impede alguém de reverter a classe sem que um teste
    // quebre (foi exatamente isso que aconteceu: uma reversão para
    // `px-2 py-0.5` passou despercebida por falta desse teste).
    expect(classList).toContain('min-h-11');
    expect(classList).toContain('min-w-11');
    expect(classList).toContain('inline-flex');
    expect(classList).toContain('items-center');
    expect(classList).toContain('justify-center');
    // Tamanho visual do selo continua compacto.
    expect(classList).toContain('text-[10px]');
  });

  it('toggle de status funciona em modo caixa e respeita stopPropagation', async () => {
    const onToggleStatus = vi.fn();
    const onEdit = vi.fn();
    const user = userEvent.setup();

    render(
      <PersonalExpenseCard
        expense={baseExpense}
        tipoLabel={(t) => t}
        cashMode="caixa"
        onEdit={onEdit}
        onDelete={vi.fn()}
        onToggleStatus={onToggleStatus}
      />,
    );

    const statusButton = screen.getByTitle('Alternar status');
    await user.click(statusButton);

    expect(onToggleStatus).toHaveBeenCalledWith('exp-1', 'PAGO');
    // stopPropagation: clicar no selo não deve abrir a edição do card.
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('em competência (não-caixa) com cartão, o toggle fica bloqueado', async () => {
    const onToggleStatus = vi.fn();
    const user = userEvent.setup();

    render(
      <PersonalExpenseCard
        expense={{ ...baseExpense, cardLast4: '4321' }}
        tipoLabel={(t) => t}
        cashMode="competencia"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleStatus={onToggleStatus}
      />,
    );

    const statusButton = screen.getByTitle('Alternar status');
    await user.click(statusButton);

    expect(onToggleStatus).not.toHaveBeenCalled();
  });
});
