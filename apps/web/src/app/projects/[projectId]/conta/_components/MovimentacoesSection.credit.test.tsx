/**
 * #704: Conta rows are not Expense DTOs. The deletion capability of a credit ROOT
 * comes from the ordinary expense read (`canDelete`) — `expenseIsCredit: true` on the
 * row identifies the root but is NOT that capability (AccountSaida does not emit it).
 * The read is on demand (row intent), never for the whole list. Loading, error and
 * absence all fail closed (no parallel permission derived from the amount), and a
 * failed or successful delete refreshes that capability instead of trusting it for 60 s.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { MovimentacoesSection } from './MovimentacoesSection';
import type { AccountViewResponse, AccountViewSaida } from '../_types';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function credit(overrides: Partial<AccountViewSaida> = {}): AccountViewSaida {
  return {
    id: 'credit',
    kind: 'saida',
    descricao: 'Crédito importado',
    data: '2026-06-15T00:00:00.000Z',
    forma: 'cartao',
    valor: -12_345_678,
    expenseIsCredit: true,
    realizado: true,
    status: 'PAGO',
    cardLast4: '1234',
    bankLast4: null,
    tipoDespesa: 'OUTROS',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...overrides,
  };
}

function response(saidas: AccountViewSaida[]): AccountViewResponse {
  return {
    mesSelecionado: '2026-06',
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
    saidas,
    comprasCartao: [],
    entradas: [],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
  };
}

function mount(data: AccountViewResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
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
  return client;
}

let detail: () => Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/projects/proj-1/expenses/credit') return detail();
    return [];
  });
  vi.mocked(api.delete).mockResolvedValue({});
});
afterEach(cleanup);

/** Row intent (hover/focus/menu) is what requests the capability read. */
const intent = () => fireEvent.pointerEnter(screen.getByTestId('movimentacao-row'));
const remove = () => screen.queryByRole('button', { name: 'Excluir' });
const dto = (canDelete?: boolean) => ({ id: 'credit', valorTotal: -12_345_678, valor: -12_345_678, canDelete });

describe('Conta credit deletion capability', () => {
  it('reads nothing on mount; Excluir appears only after the on-demand detail read grants it (flag true alone does not)', async () => {
    detail = async () => dto(true);
    mount(response([credit()]));
    await screen.findByText('Crédito importado');
    expect(api.get).not.toHaveBeenCalledWith('/projects/proj-1/expenses/credit');
    expect(remove()).toBeNull();
    intent();
    expect(await screen.findByRole('button', { name: 'Excluir' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/projects/proj-1/expenses/credit');
    expect(screen.queryByRole('button', { name: /Ratear|Vincular|Paga|Quitar/ })).toBeNull();
    expect(screen.getAllByText('-R$ 123.456,78', { exact: false }).length).toBeGreaterThan(0);
  });

  it.each([
    ['false', async () => dto(false)],
    ['absent', async () => dto(undefined)],
    ['a failed read (no fallback permission from the amount)', async () => Promise.reject(new Error('boom'))],
  ])('fails closed for %s', async (_label, read) => {
    detail = read as () => Promise<unknown>;
    mount(response([credit()]));
    await screen.findByText('Crédito importado');
    intent();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/proj-1/expenses/credit'));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(remove()).toBeNull();
  });

  it('a 409 refetches the capability and the stale Excluir disappears', async () => {
    let granted = true;
    detail = async () => dto(granted);
    mount(response([credit()]));
    await screen.findByText('Crédito importado');
    intent();
    const excluir = await screen.findByRole('button', { name: 'Excluir' });
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('Exclusão não autorizada agora.'));
    granted = false; // server state moved: the next read no longer grants deletion
    fireEvent.click(excluir);
    await waitFor(() => expect(remove()).toBeNull());
    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith('/projects/proj-1/expenses/credit');
  });
});
