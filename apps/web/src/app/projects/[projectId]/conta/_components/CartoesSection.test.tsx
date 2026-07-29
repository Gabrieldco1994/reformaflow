import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CartoesSection } from './CartoesSection';

vi.mock('./CreditCardTile', () => ({
  CreditCardTile: ({
    card,
    active,
    onSelect,
  }: {
    card: { nickname: string; last4: string };
    active: boolean;
    onSelect: (last4: string | null) => void;
  }) => (
    <button type="button" onClick={() => onSelect(active ? null : card.last4)}>
      {card.nickname} · {card.last4}
    </button>
  ),
}));

describe('CartoesSection', () => {
  it('renders "Ver todos" pointing to credit-cards for the same project', () => {
    render(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[
          {
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
          },
        ]}
        contas={[]}
        selected={null}
        onSelect={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: 'Ver todos' })).toHaveAttribute(
      'href',
      '/projects/pessoal-1/credit-cards',
    );
  });

  it('toggles account filter and allows clearing with "Limpar filtro"', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[]}
        contas={[{ nome: 'Itaú', last4: '4247' }]}
        selected={null}
        onSelect={onSelect}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText('Itaú · 4247')[0]);
    expect(onSelect).toHaveBeenCalledWith('4247');

    rerender(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[]}
        contas={[{ nome: 'Itaú', last4: '4247' }]}
        selected="4247"
        onSelect={onSelect}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro' }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('compact mobile tap on "a pagar" pays directly (única ação, sem ambiguidade)', () => {
    const onSelect = vi.fn();
    const onPayInvoice = vi.fn();

    render(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[
          {
            nickname: 'Nubank',
            last4: '1111',
            faturaAtual: 120_00,
            faturaPendente: 120_00,
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
          },
        ]}
        contas={[]}
        selected={null}
        onSelect={onSelect}
        onPayInvoice={onPayInvoice}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /Nubank · 1111/ })[0]);
    expect(onSelect).toHaveBeenCalledWith('1111');
    expect(onPayInvoice).toHaveBeenCalledWith('1111');

    expect(screen.queryByRole('button', { name: 'Pagar fatura' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ajustar…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quitar c/ resíduo…' })).not.toBeInTheDocument();
  });

  it('compact mobile tap on "paga" opens an actions sheet with Desfazer pagamento e Ajustar fatura', () => {
    const onAdjustInvoice = vi.fn();
    const onUndoPayment = vi.fn();

    render(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[
          {
            nickname: 'XP',
            last4: '3333',
            faturaAtual: 70_00,
            faturaPendente: 0,
            faturaPaga: 70_00,
            residualDeclarado: 0,
            possuiIntervencaoManual: false,
            ajusteManualTotal: 0,
            dueMonth: '2026-07',
            vencimento: '2026-07-22',
            status: 'paga',
            limiteUsadoPct: null,
            limiteUsado: null,
            limiteTotal: null,
          },
        ]}
        contas={[]}
        selected={null}
        onSelect={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={onAdjustInvoice}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={onUndoPayment}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /XP · 3333/ })[0]);

    // Sem "Quitar c/ resíduo…" porque não há pendente (faturaPendente=0).
    expect(screen.queryByRole('button', { name: 'Quitar c/ resíduo…' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Desfazer pagamento' }));
    expect(onUndoPayment).toHaveBeenCalledWith('3333');
    expect(onAdjustInvoice).not.toHaveBeenCalled();
  });

  it('compact mobile tap on "parcial" com pendente oferece Quitar c/ resíduo no sheet', () => {
    const onSettleWithResidual = vi.fn();

    render(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[
          {
            nickname: 'Inter',
            last4: '2222',
            faturaAtual: 90_00,
            faturaPendente: 20_00,
            faturaPaga: 70_00,
            residualDeclarado: 0,
            possuiIntervencaoManual: false,
            ajusteManualTotal: 0,
            dueMonth: '2026-07',
            vencimento: '2026-07-21',
            status: 'parcial',
            limiteUsadoPct: null,
            limiteUsado: null,
            limiteTotal: null,
          },
        ]}
        contas={[]}
        selected={null}
        onSelect={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={onSettleWithResidual}
        onUndoPayment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /Inter · 2222/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar c/ resíduo…' }));
    expect(onSettleWithResidual).toHaveBeenCalledWith('2222');
  });
});
