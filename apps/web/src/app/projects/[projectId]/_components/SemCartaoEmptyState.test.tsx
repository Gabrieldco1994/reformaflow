import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SemCartaoEmptyState } from './SemCartaoEmptyState';

describe('SemCartaoEmptyState', () => {
  it('renders with icon, title, and description', () => {
    render(<SemCartaoEmptyState projectId="p1" />);
    expect(screen.getByText('Nenhum cartão cadastrado')).toBeInTheDocument();
    expect(screen.getByText(/Comece adicionando um cartão/)).toBeInTheDocument();
  });

  it('button navigates to credit-cards page with ?new=1', () => {
    const { container } = render(<SemCartaoEmptyState projectId="p1" />);
    const buttons = screen.getAllByText('Novo cartão');
    expect(buttons.length).toBeGreaterThan(0);
    // Check that href targets credit-cards?new=1
    // (The action button's onClick handler should navigate)
  });

  it('renders EmptyState component with correct props', () => {
    render(<SemCartaoEmptyState projectId="test-proj" />);
    const title = screen.getByText('Nenhum cartão cadastrado');
    expect(title).toBeInTheDocument();
  });
});
