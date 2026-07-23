import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MariaInsightStep } from './MariaInsightStep';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const setPendingMock = vi.fn();
vi.mock('@/app/projects/[projectId]/maria/_lib/pending-prompt', () => ({
  setPendingMariaPrompt: (...args: unknown[]) => setPendingMock(...args),
}));

beforeEach(() => {
  pushMock.mockClear();
  setPendingMock.mockClear();
});

describe('MariaInsightStep', () => {
  it('deriva o primeiro chip da categoria real da despesa', () => {
    render(
      <MariaInsightStep
        projectId="p1"
        createdExpense={{ tipoDespesa: 'SUPERMERCADO', categoriaLabel: 'Supermercado' }}
        onSkip={vi.fn()}
      />,
    );
    expect(screen.getByText('Quanto já gastei em Supermercado este mês?')).toBeInTheDocument();
    expect(screen.getByText('Como está meu caixa este mês?')).toBeInTheDocument();
  });

  it('tocar num chip grava o prompt na ponte e navega para a Maria', () => {
    render(
      <MariaInsightStep
        projectId="p1"
        createdExpense={{ tipoDespesa: 'SUPERMERCADO', categoriaLabel: 'Supermercado' }}
        onSkip={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Quanto já gastei em Supermercado este mês?'));
    expect(setPendingMock).toHaveBeenCalledWith('Quanto já gastei em Supermercado este mês?');
    expect(pushMock).toHaveBeenCalledWith('/projects/p1/maria');
  });

  it('"Pular por agora" chama onSkip uma vez, sem navegar', () => {
    const onSkip = vi.fn();
    render(
      <MariaInsightStep
        projectId="p1"
        createdExpense={{ tipoDespesa: 'OUTROS', categoriaLabel: '' }}
        onSkip={onSkip}
      />,
    );
    fireEvent.click(screen.getByText('Pular por agora'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
