import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MariaInsightStep } from './MariaInsightStep';

const setPendingMock = vi.fn();
vi.mock('@/app/projects/[projectId]/maria/_lib/pending-prompt', () => ({
  setPendingMariaPrompt: (...args: unknown[]) => setPendingMock(...args),
}));

// MariaChatBody puxa useFinancialAgent/useMariaOpening/useSpeechRecognition — stub
// leve só pra provar que o passo abre o chat embutido (sem navegar pra fora do
// wizard), não para re-testar a conversa em si (já coberta nos specs da Maria).
vi.mock('@/app/projects/[projectId]/maria/_components/MariaChatBody', () => ({
  MariaChatBody: ({ projectId }: { projectId: string }) => (
    <div data-testid="maria-chat-body">{projectId}</div>
  ),
}));

beforeEach(() => {
  setPendingMock.mockClear();
});

describe('MariaInsightStep', () => {
  it('deriva o primeiro chip da categoria real da despesa', () => {
    render(
      <MariaInsightStep
        projectId="p1"
        createdExpense={{ tipoDespesa: 'SUPERMERCADO', categoriaLabel: 'Supermercado' }}
        onSkip={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('Quanto já gastei em Supermercado este mês?')).toBeInTheDocument();
    expect(screen.getByText('Como está meu caixa este mês?')).toBeInTheDocument();
  });

  it('tocar num chip grava o prompt na ponte e abre o chat embutido (sem navegar pra fora do wizard)', () => {
    render(
      <MariaInsightStep
        projectId="p1"
        createdExpense={{ tipoDespesa: 'SUPERMERCADO', categoriaLabel: 'Supermercado' }}
        onSkip={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Quanto já gastei em Supermercado este mês?'));
    expect(setPendingMock).toHaveBeenCalledWith('Quanto já gastei em Supermercado este mês?');
    expect(screen.getByTestId('maria-chat-body')).toHaveTextContent('p1');
    expect(screen.getByRole('button', { name: /concluir/i })).toBeInTheDocument();
  });

  it('"Concluir" no chat embutido chama onDone (finaliza a jornada → cockpit)', () => {
    const onDone = vi.fn();
    render(
      <MariaInsightStep
        projectId="p1"
        createdExpense={{ tipoDespesa: 'SUPERMERCADO', categoriaLabel: 'Supermercado' }}
        onSkip={vi.fn()}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByText('Quanto já gastei em Supermercado este mês?'));
    fireEvent.click(screen.getByRole('button', { name: /concluir/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('"Pular por agora" chama onSkip uma vez, sem abrir o chat', () => {
    const onSkip = vi.fn();
    render(
      <MariaInsightStep
        projectId="p1"
        createdExpense={{ tipoDespesa: 'OUTROS', categoriaLabel: '' }}
        onSkip={onSkip}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Pular por agora'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('maria-chat-body')).not.toBeInTheDocument();
  });
});
