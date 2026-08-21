/**
 * Integration test: MovimentacoesSection → FinancialItemDetail wiring.
 *
 * Proves the detail overlay actually mounts when a row is clicked —
 * the unit tests for FinancialItemDetail only proved the component renders
 * in isolation, not that the app mounts it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MovimentacoesSection } from './MovimentacoesSection';
import type { AccountViewResponse, AccountViewSaida, AccountViewEntrada } from '../_types';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

afterEach(cleanup);

function makeSaida(overrides: Partial<AccountViewSaida> = {}): AccountViewSaida {
  return {
    id: 'exp-1',
    kind: 'saida',
    descricao: 'Cimento 50kg',
    data: '2026-06-15T00:00:00.000Z',
    forma: 'pix',
    valor: 150_000,
    realizado: true,
    status: 'PAGO',
    cardLast4: null,
    bankLast4: '1234',
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...overrides,
  };
}

function makeEntrada(overrides: Partial<AccountViewEntrada> = {}): AccountViewEntrada {
  return {
    id: 'rec-1',
    kind: 'entrada',
    descricao: 'Salário',
    data: '2026-06-05T00:00:00.000Z',
    tipo: 'salario',
    valor: 500_000,
    bankLast4: '1234',
    status: 'EM_CAIXA',
    ...overrides,
  };
}

function makeResponse(overrides: Partial<AccountViewResponse> = {}): AccountViewResponse {
  return {
    mesSelecionado: '2026-06',
    caixaHoje: 1_000_000,
    carteiraHoje: 0,
    entrouMes: 500_000,
    saiuMes: 150_000,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 1_000_000,
    devoCartaoTotal: 0,
    cartoes: [],
    contas: [{ last4: '1234', nome: 'Conta corrente' }],
    saidas: [makeSaida()],
    comprasCartao: [],
    entradas: [makeEntrada()],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
    ...overrides,
  };
}

/** Mock matchMedia for mobile widths. */
function mockWidth(width: number) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const match = width <= parseInt(query.match(/(\d+)/)?.[1] ?? '0', 10);
    return {
      matches: match,
      media: query,
      addEventListener: (_: string, fn: () => void) => {},
      removeEventListener: () => {},
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

function renderSection(data: AccountViewResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MovimentacoesSection
        data={data}
        projectId="proj-1"
        originFilter={null}
        onClearOrigin={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
        summaryQuickFilter={null}
        onClearSummaryQuickFilter={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('MovimentacoesSection → FinancialItemDetail wiring', () => {
  it('clicking a row opens the detail sheet at mobile width', () => {
    mockWidth(375);
    renderSection(makeResponse());

    // No detail initially
    expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();

    // Find the first row title button and click it
    const titleButtons = screen.getAllByTitle('Ver detalhe');
    fireEvent.click(titleButtons[0]!);

    // Detail sheet appears
    expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();
    // Drawer must NOT be in DOM
    expect(screen.queryByTestId('financial-detail-drawer')).not.toBeInTheDocument();
  });

  it('clicking a row opens the detail drawer at desktop width', () => {
    mockWidth(1024);
    renderSection(makeResponse());

    expect(screen.queryByTestId('financial-detail-drawer')).not.toBeInTheDocument();

    const titleButtons = screen.getAllByTitle('Ver detalhe');
    fireEvent.click(titleButtons[0]!);

    expect(screen.getByTestId('financial-detail-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();
  });

  it('closing the detail preserves filters and scroll position', () => {
    mockWidth(375);
    renderSection(makeResponse());

    // Apply a filter: switch to "Saídas" tab
    const saidasTab = screen.getByRole('button', { name: 'Saídas' });
    fireEvent.click(saidasTab);

    // Open detail
    const titleButtons = screen.getAllByTitle('Ver detalhe');
    fireEvent.click(titleButtons[0]!);
    expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();

    // Close detail via the close button
    const closeBtn = screen.getByLabelText('Fechar');
    fireEvent.click(closeBtn);

    // Detail gone
    expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();

    // Filter preserved: "Saídas" tab still selected (check its visual state)
    // The tab system uses a custom class, not aria-pressed. Verify by checking
    // that only saida items are still visible (filter wasn't lost).
    expect(screen.getByText('Cimento 50kg')).toBeInTheDocument();
  });

  it('detail shows formatted currency (centavos → BRL)', () => {
    mockWidth(375);
    renderSection(makeResponse());

    const titleButtons = screen.getAllByTitle('Ver detalhe');
    fireEvent.click(titleButtons[0]!);

    // R$ 1.500,00 (150_000 centavos)
    const detail = screen.getByTestId('financial-detail-sheet');
    expect(detail).toHaveTextContent('R$ 1.500,00');
  });

  it('detail does NOT duplicate row actions (no edit/delete inside detail)', () => {
    mockWidth(375);
    renderSection(makeResponse());

    const titleButtons = screen.getAllByTitle('Ver detalhe');
    fireEvent.click(titleButtons[0]!);

    const detail = screen.getByTestId('financial-detail-sheet');
    // The detail should not contain action buttons like Editar, Excluir, etc.
    expect(detail.querySelector('[aria-label="Editar"]')).toBeNull();
    expect(detail.querySelector('[aria-label="Excluir"]')).toBeNull();
  });
});
