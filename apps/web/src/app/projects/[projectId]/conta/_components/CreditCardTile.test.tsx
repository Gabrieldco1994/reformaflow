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

/**
 * Capabilities do servidor (#448 B1a/B1b). `actions` é VETO: ausente (API
 * antiga) mantém a derivação local; presente, a CTA precisa estar na lista.
 * Uma fatura de último4 AMBÍGUO chega com `actions: []` e `cardId: null`
 * porque `pay-invoice`/`undo-invoice-payment` só saberiam responder 409 —
 * desenhar o botão ali seria fabricar uma CTA morta.
 */
describe('CreditCardTile — capabilities do servidor vetam a CTA', () => {
  const render_ = (card: AccountViewCardSummary) =>
    render(
      <CreditCardTile
        card={card}
        active={false}
        onSelect={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

  it('último4 ambíguo (actions: []) não desenha "Pagar fatura" nem "Desfazer pagamento"', () => {
    render_(makeCard({ status: 'parcial', faturaPaga: 50_00, faturaPendente: 50_00, actions: [], cardId: null }));
    expect(screen.queryByRole('button', { name: 'Pagar fatura' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Desfazer pagamento' })).not.toBeInTheDocument();
  });

  it('"Ajustar…" continua vivo no final ambíguo — /invoice-adjustments não tem 409', () => {
    render_(makeCard({ status: 'parcial', actions: [] }));
    expect(screen.getByRole('button', { name: /Ajustar/ })).toBeInTheDocument();
  });

  it('actions: ["pay"] mantém Pagar e derruba só o Desfazer', () => {
    render_(makeCard({ status: 'parcial', faturaPaga: 50_00, faturaPendente: 50_00, actions: ['pay'] }));
    expect(screen.getByRole('button', { name: 'Pagar fatura' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Desfazer pagamento' })).not.toBeInTheDocument();
  });

  it('actions nunca CONCEDE: fatura paga não ganha "Pagar fatura" só porque a lista traz "pay"', () => {
    render_(makeCard({ status: 'paga', faturaPaga: 100_00, faturaPendente: 0, actions: ['pay', 'undo'] }));
    expect(screen.queryByRole('button', { name: 'Pagar fatura' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desfazer pagamento' })).toBeInTheDocument();
  });

  it('API antiga (sem actions) preserva a derivação local intacta', () => {
    render_(makeCard({ status: 'parcial', faturaPaga: 50_00, faturaPendente: 50_00 }));
    expect(screen.getByRole('button', { name: 'Pagar fatura' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desfazer pagamento' })).toBeInTheDocument();
  });
});
