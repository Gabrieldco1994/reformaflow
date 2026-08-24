import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MetaCategoriaCard, type MetaProgress } from './MetaCategoriaCard';

describe('MetaCategoriaCard', () => {
  const mockItem: MetaProgress = {
    tipoDespesa: 'ALIMENTACAO',
    limiteCents: 100_000,
    gastoCents: 50_000,
    comprometidoCents: 50_000,
    pct: 50,
  };

  it('mostra gasto e limite', () => {
    render(
      <MetaCategoriaCard
        item={mockItem}
        label="Alimentação"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText(/R\$ 500,00/)).toBeInTheDocument(); // gasto
    expect(screen.getByText(/R\$ 1.000,00/)).toBeInTheDocument(); // limite
  });

  it('mostra percentual e tom quando igual ao limite', () => {
    render(
      <MetaCategoriaCard
        item={mockItem}
        label="Alimentação"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText(/50%/)).toBeInTheDocument();
    expect(screen.getByText(/No limite/)).toBeInTheDocument();
  });

  it('NÃO mostra comprometido quando igual ao gasto', () => {
    render(
      <MetaCategoriaCard
        item={mockItem}
        label="Alimentação"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.queryByText(/comprometido/)).not.toBeInTheDocument();
  });

  it('mostra comprometido quando maior que gasto', () => {
    const itemWithPending: MetaProgress = {
      ...mockItem,
      gastoCents: 50_000,
      comprometidoCents: 80_000, // parcelas pendentes
    };

    render(
      <MetaCategoriaCard
        item={itemWithPending}
        label="Alimentação"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText(/comprometido/)).toBeInTheDocument();
    expect(screen.getByText(/R\$ 800,00 comprometido/)).toBeInTheDocument();
  });

  it('mostra rótulo da categoria', () => {
    render(
      <MetaCategoriaCard
        item={mockItem}
        label="Alimentação"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText('Alimentação')).toBeInTheDocument();
  });

  it('chama onEdit ao clicar no card', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      <MetaCategoriaCard
        item={mockItem}
        label="Alimentação"
        onEdit={onEdit}
        onDelete={() => {}}
      />,
    );

    const label = screen.getByText('Alimentação');
    await user.click(label);
    expect(onEdit).toHaveBeenCalled();
  });

  it('mostra botão de delete com título', () => {
    render(
      <MetaCategoriaCard
        item={mockItem}
        label="Alimentação"
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );

    const deleteButton = screen.getByTitle('Remover meta');
    expect(deleteButton).toBeInTheDocument();
  });
});
