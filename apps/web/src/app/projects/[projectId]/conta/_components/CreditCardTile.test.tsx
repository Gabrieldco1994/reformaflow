import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreditCardTile } from './CreditCardTile';
import type { AccountViewCardSummary } from '../_types';

function makeCard(overrides: Partial<AccountViewCardSummary> = {}): AccountViewCardSummary {
  return {
    nickname: 'Nubank',
    last4: '1234',
    faturaAtual: 100_00,
    faturaPendente: 100_00,
    faturaPaga: 0,
    residualDeclarado: 0,
    possuiIntervencaoManual: false,
    ajusteManualTotal: 0,
    dueMonth: '2026-07',
    vencimento: '2026-07-20',
    status: 'a pagar',
    limiteUsadoPct: null,
    limiteUsado: null,
    limiteTotal: null,
    ...overrides,
  };
}

describe('CreditCardTile — Desfazer pagamento', () => {
  it('does not render "Desfazer pagamento" when status is "a pagar"', () => {
    render(
      <CreditCardTile
        card={makeCard({ status: 'a pagar' })}
        active={false}
        onSelect={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Desfazer pagamento' })).not.toBeInTheDocument();
  });

  it('renders "Desfazer pagamento" and calls onUndoPayment when status is "paga"', () => {
    const onUndoPayment = vi.fn();
    render(
      <CreditCardTile
        card={makeCard({ status: 'paga', faturaPaga: 100_00, faturaPendente: 0 })}
        active={false}
        onSelect={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={onUndoPayment}
      />,
    );

    const btn = screen.getByRole('button', { name: 'Desfazer pagamento' });
    fireEvent.click(btn);
    expect(onUndoPayment).toHaveBeenCalledWith('1234');
  });

  it('renders "Desfazer pagamento" when status is "parcial"', () => {
    render(
      <CreditCardTile
        card={makeCard({ status: 'parcial', faturaPaga: 50_00, faturaPendente: 50_00 })}
        active={false}
        onSelect={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Desfazer pagamento' })).toBeInTheDocument();
  });
});
