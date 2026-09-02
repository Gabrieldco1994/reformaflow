import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SemContaEmptyState } from './SemContaEmptyState';

/**
 * #218 (W5) — espelho do `SemCartaoEmptyState`, restaurado da #655.
 *
 * O CTA "Nova conta" navega para `/projects/:id/bank-accounts?focus=openingBalance`.
 * Caminho PESSOAL verificado: `bank-accounts/page.tsx` redireciona ao hub
 * (`/conta?focus=openingBalance`, query preservada) e `BankAccountsSection`
 * consome `focus=openingBalance` abrindo o form. A rota TEM de ser escopada pelo
 * `projectId` recebido — um CTA para outro projeto reabre o dead-end do #656.
 */

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('SemContaEmptyState', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renderiza título e descrição', () => {
    render(<SemContaEmptyState projectId="p1" />);
    expect(screen.getByText('Nenhuma conta cadastrada')).toBeInTheDocument();
    expect(screen.getByText(/Comece adicionando uma conta/)).toBeInTheDocument();
  });

  it('CTA "Nova conta" navega para bank-accounts?focus=openingBalance escopado pelo projectId', () => {
    render(<SemContaEmptyState projectId="p1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Nova conta' }));
    expect(mockPush).toHaveBeenCalledWith('/projects/p1/bank-accounts?focus=openingBalance');
  });

  it('escopa a rota pelo projectId recebido (não hard-coded)', () => {
    render(<SemContaEmptyState projectId="outro-projeto" />);
    fireEvent.click(screen.getByRole('button', { name: 'Nova conta' }));
    expect(mockPush).toHaveBeenCalledWith(
      '/projects/outro-projeto/bank-accounts?focus=openingBalance',
    );
  });
});
