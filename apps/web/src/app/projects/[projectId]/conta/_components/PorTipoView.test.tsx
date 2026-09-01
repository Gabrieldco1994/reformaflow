import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PorTipoView } from './PorTipoView';

const groups = [
  { type: 'PESSOAL', total: 5_000, count: 1, hasFinance: true },
  { type: 'REFORMA', total: 3_000, count: 1, hasFinance: true },
  { type: 'PLANTAS', total: 0, count: 0, hasFinance: false },
];

describe('PorTipoView', () => {
  it('oferece recuperação imediata para tipo desconhecido', () => {
    const onSelectType = vi.fn();
    render(<PorTipoView groups={groups} selectedType="DESCONHECIDO" onSelectType={onSelectType} />);

    fireEvent.click(screen.getByRole('button', { name: 'Ver todos os tipos' }));

    expect(onSelectType).toHaveBeenCalledWith(null);
  });

  it('expõe seleção programática e mantém PLANTAS desabilitado', () => {
    const view = render(<PorTipoView groups={groups} selectedType={null} onSelectType={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Reforma/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Reforma/ })).toHaveAttribute(
      'title',
      'Filtrar por este tipo',
    );
    expect(screen.getByRole('button', { name: /Plantas/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Plantas/ })).not.toHaveAttribute('aria-pressed');

    view.rerender(<PorTipoView groups={groups} selectedType="REFORMA" onSelectType={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Reforma/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
