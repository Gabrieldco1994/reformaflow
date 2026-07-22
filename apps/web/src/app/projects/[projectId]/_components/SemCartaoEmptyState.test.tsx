import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SemCartaoEmptyState } from './SemCartaoEmptyState';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

describe('SemCartaoEmptyState', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders with icon, title, and description', () => {
    render(<SemCartaoEmptyState projectId="p1" />);
    expect(screen.getByText('Nenhum cartão cadastrado')).toBeInTheDocument();
    expect(screen.getByText(/Comece adicionando um cartão/)).toBeInTheDocument();
  });

  it('button navigates to credit-cards page with ?new=1', () => {
    render(<SemCartaoEmptyState projectId="p1" />);
    const button = screen.getByRole('button', { name: 'Novo cartão' });
    fireEvent.click(button);
    expect(mockPush).toHaveBeenCalledWith('/projects/p1/credit-cards?new=1');
  });

  it('renders EmptyState component with correct props', () => {
    render(<SemCartaoEmptyState projectId="test-proj" />);
    const title = screen.getByText('Nenhum cartão cadastrado');
    expect(title).toBeInTheDocument();
  });
});
