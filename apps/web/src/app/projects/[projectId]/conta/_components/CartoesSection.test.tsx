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

  // --- B1b (#448): o tap direto do carrossel também precisa do veto ---
  //
  // No mobile, "a pagar" abre o PagarFaturaDialog SEM passar pelos botões do
  // tile (que só existem no grid desktop). Sem gate aqui, o veto de
  // capabilities protegeria só o desktop e o mobile continuaria com a CTA cuja
  // única resposta possível é 409 — a CTA morta que este issue existe pra não
  // produzir.
  function cardAPagar(over: Record<string, unknown> = {}) {
    return {
      cardId: 'card-9',
      nickname: 'Ambíguo',
      last4: '4488',
      faturaAtual: 150_00,
      faturaPendente: 150_00,
      faturaPaga: 0,
      residualDeclarado: 0,
      possuiIntervencaoManual: false,
      ajusteManualTotal: 0,
      dueMonth: '2026-07',
      vencimento: '2026-07-20',
      status: 'a pagar' as const,
      limiteUsadoPct: null,
      limiteUsado: null,
      limiteTotal: null,
      ...over,
    };
  }

  it('tap mobile em "a pagar" com `actions: []` NÃO abre pagamento: abre o sheet com a alternativa viva', () => {
    const onPayInvoice = vi.fn();
    const onAdjustInvoice = vi.fn();

    render(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[cardAPagar({ actions: [], cardId: null })]}
        contas={[]}
        selected={null}
        onSelect={vi.fn()}
        onPayInvoice={onPayInvoice}
        onAdjustInvoice={onAdjustInvoice}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /Ambíguo · 4488/ })[0]);

    expect(onPayInvoice).not.toHaveBeenCalled();
    // Sem beco sem saída: o sheet abre, explica e mantém "Ajustar fatura…",
    // que vai para /invoice-adjustments (endpoint deliberadamente sem 409).
    expect(screen.getByText(/Mais de um cartão com esse final/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Desfazer pagamento' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar fatura…' }));
    expect(onAdjustInvoice).toHaveBeenCalledWith('4488');
  });

  it('tap mobile em "a pagar" com `actions: ["pay"]` continua pagando direto', () => {
    const onPayInvoice = vi.fn();

    render(
      <CartoesSection
        projectId="pessoal-1"
        cartoes={[cardAPagar({ actions: ['pay'] })]}
        contas={[]}
        selected={null}
        onSelect={vi.fn()}
        onPayInvoice={onPayInvoice}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /Ambíguo · 4488/ })[0]);
    expect(onPayInvoice).toHaveBeenCalledWith('4488');
  });

  // --- #216 (W3): foco por teclado (Tab) no carrossel compacto mobile ---
  //
  // Bug reproduzido em runtime a 375/390px: Tab no 2º tile de 3 deixava
  // scrollLeft ~6, só 30–36% do tile visível (status/valor/vencimento
  // cortados). jsdom não implementa `scrollIntoView`, então mockamos o
  // mínimo pra provar que o tile pede pra si mesmo ficar visível ao
  // receber foco real — sem gerenciar Tab/setas/índice manualmente.
  it('brings the focused compact tile fully into view on keyboard focus', () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      render(
        <CartoesSection
          projectId="pessoal-1"
          cartoes={[
            cardAPagar({ last4: '1111', nickname: 'Um' }),
            cardAPagar({ last4: '2222', nickname: 'Dois' }),
            cardAPagar({ last4: '3333', nickname: 'Três' }),
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

      const secondTile = screen.getAllByRole('button', { name: /Dois · 2222/ })[0];
      fireEvent.focus(secondTile);

      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ block: 'nearest', inline: 'nearest' }),
      );
    } finally {
      window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });
});
