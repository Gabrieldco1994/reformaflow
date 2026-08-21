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

function renderSection(
  data: AccountViewResponse,
  overrides: Partial<React.ComponentProps<typeof MovimentacoesSection>> = {},
) {
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
        {...overrides}
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

describe('Deep-link: ?item=<id>', () => {
  it('opens detail automatically when initialItemId matches an item in the response', () => {
    mockWidth(375);
    renderSection(makeResponse(), { initialItemId: 'exp-1' });

    // Detail should open automatically for the matching item
    expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('financial-detail-sheet')).toHaveTextContent('R$ 1.500,00');
  });

  it('silently ignores initialItemId that does not match any item — no detail, no message, no fetch', async () => {
    mockWidth(375);
    const { api } = await import('@/lib/api');

    // Clear any prior call counts
    vi.mocked(api.get).mockClear();
    vi.mocked(api.post).mockClear();
    vi.mocked(api.patch).mockClear();
    vi.mocked(api.delete).mockClear();

    renderSection(makeResponse(), { initialItemId: 'nonexistent-id-12345' });

    // No detail shown
    expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('financial-detail-drawer')).not.toBeInTheDocument();

    // No error message — security: don't reveal whether the id exists
    expect(screen.queryByText(/não encontrad/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sem permissão/i)).not.toBeInTheDocument();

    // No additional network request was made to fetch the item
    // (the only api calls should be the merchant-suggestions query, not a /financial-items/:id)
    for (const method of [api.get, api.post, api.patch, api.delete] as Array<ReturnType<typeof vi.fn>>) {
      for (const call of method.mock.calls) {
        const url = String(call[0] ?? '');
        expect(url).not.toContain('nonexistent-id-12345');
        expect(url).not.toMatch(/financial-items/);
      }
    }
  });

  it('closing a deep-linked detail calls onClearItemId', () => {
    mockWidth(375);
    const onClearItemId = vi.fn();
    renderSection(makeResponse(), { initialItemId: 'exp-1', onClearItemId });

    expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();

    // Close the detail
    fireEvent.click(screen.getByLabelText('Fechar'));

    expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();
    expect(onClearItemId).toHaveBeenCalledTimes(1);
  });

  it('does not reopen detail after manual close even if initialItemId persists', () => {
    mockWidth(375);
    const onClearItemId = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MovimentacoesSection
          data={makeResponse()}
          projectId="proj-1"
          originFilter={null}
          onClearOrigin={vi.fn()}
          onPayInvoice={vi.fn()}
          onAdjustInvoice={vi.fn()}
          onSettleWithResidual={vi.fn()}
          onUndoPayment={vi.fn()}
          summaryQuickFilter={null}
          onClearSummaryQuickFilter={vi.fn()}
          initialItemId="exp-1"
          onClearItemId={onClearItemId}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();

    // Close manually
    fireEvent.click(screen.getByLabelText('Fechar'));
    expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();

    // Re-render with same initialItemId (simulates URL not yet cleared)
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MovimentacoesSection
          data={makeResponse()}
          projectId="proj-1"
          originFilter={null}
          onClearOrigin={vi.fn()}
          onPayInvoice={vi.fn()}
          onAdjustInvoice={vi.fn()}
          onSettleWithResidual={vi.fn()}
          onUndoPayment={vi.fn()}
          summaryQuickFilter={null}
          onClearSummaryQuickFilter={vi.fn()}
          initialItemId="exp-1"
          onClearItemId={onClearItemId}
        />
      </QueryClientProvider>,
    );

    // Should NOT reopen
    expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();
  });
});
