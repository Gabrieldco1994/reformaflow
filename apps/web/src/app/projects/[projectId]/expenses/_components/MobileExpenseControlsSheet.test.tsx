import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileExpenseControlsSheet } from './MobileExpenseControlsSheet';

const draft = {
  q: '',
  tipoDespesa: '',
  room: '',
  titulo: '',
  fornecedor: '',
  formaPagamento: '',
  status: '',
  view: 'category' as const,
  period: '',
  rangeStart: '',
  rangeEnd: '',
  origin: '',
};
const tipoOptions = [{ value: 'MATERIAL_CONSTRUCAO', label: 'Material' }];

function renderSheet(
  overrides: Partial<React.ComponentProps<typeof MobileExpenseControlsSheet>> = {},
) {
  const props: React.ComponentProps<typeof MobileExpenseControlsSheet> = {
    open: true,
    draft,
    projectType: 'REFORMA',
    hasRooms: true,
    tipoOptions,
    onDraftChange: vi.fn(),
    onApply: vi.fn(),
    onOpenChange: vi.fn(),
    ...overrides,
  };
  render(<MobileExpenseControlsSheet {...props} />);
  return props;
}

describe('MobileExpenseControlsSheet', () => {
  it('shows REFORMA room controls without leaking the PESSOAL-only project view', () => {
    renderSheet();
    expect(screen.getByRole('textbox', { name: 'Ambiente' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Por projeto' })).not.toBeInTheDocument();
  });

  it('offers project view for PESSOAL without fabricating a room control', () => {
    renderSheet({ projectType: 'PESSOAL', hasRooms: false });
    expect(
      screen.getAllByRole('radio').map((radio) => radio.parentElement?.textContent),
    ).toEqual(['Categoria', 'Mês', 'Geral', 'Por projeto']);
    expect(screen.queryByRole('textbox', { name: 'Ambiente' })).not.toBeInTheDocument();
  });

  it.each(['COMPRA', 'CASA', 'CARRO'] as const)(
    'does not leak PESSOAL or REFORMA capabilities to %s',
    (projectType) => {
      renderSheet({ projectType, hasRooms: false });
      expect(screen.queryByRole('radio', { name: 'Por projeto' })).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Ambiente' })).not.toBeInTheDocument();
    },
  );

  it('keeps edits transactional: closing neither applies nor mutates the committed draft', () => {
    const props = renderSheet();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar despesas' }), {
      target: { value: 'cimento' },
    });
    expect(props.onDraftChange).toHaveBeenCalledOnce();
    expect(props.onDraftChange).toHaveBeenCalledWith({ ...draft, q: 'cimento' });
    expect(draft.q).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('emits one complete draft on Apply', () => {
    const onApply = vi.fn();
    renderSheet({ onApply });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith(draft);
  });
});
