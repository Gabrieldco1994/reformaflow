import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MovimentacaoRow } from './MovimentacaoRow';
import type { AccountViewEntrada, AccountViewSaida } from '../_types';

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

function makeSaida(overrides: Partial<AccountViewSaida> = {}): AccountViewSaida {
  return {
    id: 'exp-1',
    kind: 'saida',
    descricao: 'Compra mercado',
    data: '2026-06-15T00:00:00.000Z',
    forma: 'pix',
    valor: 250_000,
    realizado: false,
    status: 'PLANEJADO',
    cardLast4: null,
    bankLast4: '1234',
    tipoDespesa: 'MERCADO',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
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

describe('MovimentacaoRow — saída', () => {
  it('mostra status "A pagar" quando a saída ainda não foi realizada e alterna para pago', () => {
    const props = renderRow({ item: makeSaida({ realizado: false }) });
    const status = screen.getByRole('button', { name: /a pagar/i });
    expect(status).toBeInTheDocument();

    fireEvent.click(status);
    expect(props.onToggleExpense).toHaveBeenCalledWith('exp-1', false);
  });

  it('mostra status "Paga" quando a saída já foi realizada e alterna para planejado', () => {
    const props = renderRow({ item: makeSaida({ realizado: true, status: 'PAGO' }) });
    const status = screen.getByRole('button', { name: /paga/i });
    expect(status).toBeInTheDocument();

    fireEvent.click(status);
    expect(props.onToggleExpense).toHaveBeenCalledWith('exp-1', true);
  });

  it('exibe chip de projeto quando a despesa vem de projeto não pessoal', () => {
    renderRow({
      item: makeSaida({
        projetoOrigem: { id: 'proj-casa', name: 'Casa Praia', type: 'CASA' },
      }),
    });
    expect(screen.getByText('Casa Praia')).toBeInTheDocument();
  });
});
