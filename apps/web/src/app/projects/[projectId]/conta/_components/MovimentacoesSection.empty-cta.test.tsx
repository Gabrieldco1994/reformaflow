/**
 * #218 (W5) — CTA "Novo lançamento" no VAZIO GENUÍNO da MovimentacoesSection,
 * restaurado da #655 (os 5 casos originais + guards de mutação).
 *
 * Vazio genuíno = sem NENHUM dado bruto + aba "Tudo" + sem filtro + `onOpenLaunch`
 * fornecido:
 *   !hasAnyRawData && !anyFilterActive && tab === 'tudo' && !!onOpenLaunch
 * onde `hasAnyRawData = data.saidas.length>0 || data.entradas.length>0 ||
 * data.comprasCartao.length>0` (dados BRUTOS — nunca `filtered`).
 *
 * Vazio por filtro/aba preserva "Nenhuma movimentação com esses filtros."
 * `conta` é PESSOAL-only; `conta/page.tsx` passa `onOpenLaunch` = o MESMO callback
 * que `ContaQuickActions` usa (`openNovaDespesaRef.current`). Sem dependência de
 * `bankAccounts`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MovimentacoesSection } from './MovimentacoesSection';
import type { AccountViewResponse, AccountViewSaida } from '../_types';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

function makeSaida(overrides: Partial<AccountViewSaida> = {}): AccountViewSaida {
  return {
    id: 'saida-1',
    kind: 'saida',
    descricao: 'Mercado',
    data: '2026-07-10T00:00:00.000Z',
    forma: 'debito',
    valor: 10_000,
    realizado: true,
    status: 'PAGO',
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

function makeResponse(overrides: Partial<AccountViewResponse> = {}): AccountViewResponse {
  return {
    mesSelecionado: '2026-07',
    caixaHoje: 0,
    carteiraHoje: 0,
    entrouMes: 0,
    saiuMes: 0,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: 0,
    cartoes: [],
    contas: [],
    saidas: [],
    comprasCartao: [],
    entradas: [],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
    ...overrides,
  };
}

type ExtraProps = Partial<React.ComponentProps<typeof MovimentacoesSection>> & {
  onOpenLaunch?: () => void;
};

function renderSection(data: AccountViewResponse, overrides: ExtraProps = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MovimentacoesSection
        data={data}
        projectId="p1"
        projectType="PESSOAL"
        originFilter={null}
        onClearOrigin={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
        summaryQuickFilter={null}
        onClearSummaryQuickFilter={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

const ctaQuery = () => screen.queryByRole('button', { name: /Novo lançamento/i });

describe('MovimentacoesSection — CTA do vazio genuíno (#218)', () => {
  it('1) raw vazio + aba Tudo + sem filtro + onOpenLaunch → CTA presente e clique dispara o callback', () => {
    const onOpenLaunch = vi.fn();
    renderSection(makeResponse(), { onOpenLaunch });

    const cta = screen.getByRole('button', { name: /Novo lançamento/i });
    fireEvent.click(cta);
    expect(onOpenLaunch).toHaveBeenCalledTimes(1);
  });

  it('2a) raw vazio + aba Saídas → SEM CTA (guard: tab === "tudo")', () => {
    renderSection(makeResponse(), { onOpenLaunch: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Saídas' }));
    expect(ctaQuery()).not.toBeInTheDocument();
  });

  it('2b) raw vazio + aba Entradas → SEM CTA', () => {
    renderSection(makeResponse(), { onOpenLaunch: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Entradas' }));
    expect(ctaQuery()).not.toBeInTheDocument();
  });

  it('3) raw TEM dado mas aba Entradas esvazia a lista → mensagem de filtro, SEM CTA (guard: raw vs filtered + tab)', () => {
    renderSection(makeResponse({ saidas: [makeSaida()] }), { onOpenLaunch: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Entradas' }));

    expect(screen.getByText('Nenhuma movimentação com esses filtros.')).toBeInTheDocument();
    expect(ctaQuery()).not.toBeInTheDocument();
  });

  it('4) raw vazio + aba Tudo mas com filtro rápido ativo → SEM CTA (guard: !anyFilterActive)', () => {
    renderSection(makeResponse(), { onOpenLaunch: vi.fn(), summaryQuickFilter: 'faltaPagarMes' });
    expect(ctaQuery()).not.toBeInTheDocument();
  });

  it('5) raw com saída + aba Saídas → lista renderiza, sem estado vazio nem CTA', () => {
    renderSection(makeResponse({ saidas: [makeSaida({ descricao: 'Padaria' })] }), { onOpenLaunch: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Saídas' }));

    expect(screen.getByText('Padaria')).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma movimentação com esses filtros.')).not.toBeInTheDocument();
    expect(ctaQuery()).not.toBeInTheDocument();
  });

  it('6) raw só com comprasCartao (nada em saidas/entradas) + aba Tudo → SEM CTA (mutation-guard: termo comprasCartao)', () => {
    // `merged` não injeta comprasCartao sem filtro de cartão/categoria/projeto,
    // então a lista fica vazia — mas o dado BRUTO existe. Tirar `comprasCartao`
    // do gate faria o CTA aparecer indevidamente aqui.
    const compra = makeSaida({ id: 'cc-1', descricao: 'Cartão', cardLast4: '9999', bankLast4: null });
    renderSection(makeResponse({ comprasCartao: [compra] }), { onOpenLaunch: vi.fn() });
    expect(ctaQuery()).not.toBeInTheDocument();
  });

  it('7) raw vazio + aba Tudo + sem filtro mas SEM onOpenLaunch → SEM CTA (guard: !!onOpenLaunch)', () => {
    renderSection(makeResponse());
    expect(ctaQuery()).not.toBeInTheDocument();
  });
});
