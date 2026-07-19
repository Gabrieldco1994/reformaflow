import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MovimentacaoRow } from './MovimentacaoRow';
import type { AccountViewEntrada } from '../_types';

function makeEntrada(overrides: Partial<AccountViewEntrada> = {}): AccountViewEntrada {
  return {
    id: 'rec-1',
    kind: 'entrada',
    descricao: 'Salário',
    data: '2026-06-15T00:00:00.000Z',
    tipo: 'salario',
    valor: 500_000,
    bankLast4: '1234',
    status: 'PREVISTO',
    ...overrides,
  };
}

function renderRow(
  overrides: Partial<React.ComponentProps<typeof MovimentacaoRow>> = {},
) {
  const props: React.ComponentProps<typeof MovimentacaoRow> = {
    item: makeEntrada(),
    originLabel: () => null,
    onEditExpense: vi.fn(),
    onEditReceita: vi.fn(),
    onToggleExpense: vi.fn(),
    onToggleReceita: vi.fn(),
    onPayInvoice: vi.fn(),
    onAdjustInvoice: vi.fn(),
    onSettleWithResidual: vi.fn(),
    onQuitar: vi.fn(),
    onRemoveExpense: vi.fn(),
    onRemoveReceita: vi.fn(),
    ...overrides,
  };
  render(<MovimentacaoRow {...props} />);
  return props;
}

describe('MovimentacaoRow — entrada', () => {
  it('mostra badge "Previsto" e ao clicar marca como EM_CAIXA', () => {
    const props = renderRow({ item: makeEntrada({ status: 'PREVISTO' }) });

    const badge = screen.getByRole('button', { name: /previsto/i });
    expect(badge).toBeInTheDocument();

    fireEvent.click(badge);
    expect(props.onToggleReceita).toHaveBeenCalledWith('rec-1', 'EM_CAIXA');
  });

  it('mostra badge "Recebido" para EM_CAIXA e ao clicar volta para PREVISTO', () => {
    const props = renderRow({ item: makeEntrada({ status: 'EM_CAIXA' }) });

    const badge = screen.getByRole('button', { name: /recebido/i });
    expect(badge).toBeInTheDocument();

    fireEvent.click(badge);
    expect(props.onToggleReceita).toHaveBeenCalledWith('rec-1', 'PREVISTO');
  });
});
