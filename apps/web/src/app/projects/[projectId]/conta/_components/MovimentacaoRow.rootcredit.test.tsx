/**
 * #704 follow-up — Conta rows: the money sign of an OCCURRENCE (`saida.valor`, a
 * parcela/CFE amount) is a display fact; the row's credit policy follows the ROOT
 * (`Expense.valorTotal < 0`).
 *
 *  - `expenseIsCredit?: boolean` (server root signal) is NOT a permission: `true`
 *    restricts to the credit policy (Excluir only with the real `canDelete`),
 *    `false` only means "not a credit" — P01 flags (editavel, capability, schedule)
 *    still gate every action;
 *  - field absent (any sign): restricted; identity is resolved from the real detail
 *    read ON DEMAND (row intent), never for the whole list. Loading/error/empty body
 *    show a neutral "Verificando ações" / error + retry — never an invented "Crédito";
 *  - the sign prefix follows the occurrence: a negative amount never renders "− -R$".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { MovimentacaoRow } from './MovimentacaoRow';
import { MovimentacoesSection } from './MovimentacoesSection';
import type { AccountViewResponse, AccountViewSaida } from '../_types';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Root = { expenseIsCredit?: boolean };
function saida(valor: number, root: Root = {}, overrides: Partial<AccountViewSaida> = {}): AccountViewSaida {
  return {
    id: 'x',
    kind: 'saida',
    descricao: 'Contrato parcelado',
    data: '2026-06-15T00:00:00.000Z',
    forma: 'pix',
    valor,
    realizado: true,
    status: 'PAGO',
    cardLast4: null,
    bankLast4: '1234',
    tipoDespesa: 'MERCADO',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...root,
    ...overrides,
  } as AccountViewSaida;
}

const handlers = () => ({
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
  onRatear: vi.fn(),
  onVincular: vi.fn(),
});
function row(item: AccountViewSaida, expenseDeleteAllowed?: boolean) {
  render(<MovimentacaoRow item={item} originLabel={() => null} expenseDeleteAllowed={expenseDeleteAllowed} {...handlers()} />);
}
/** The status chip is always rendered; it is an ACTION only when enabled (restricted rows render it disabled). */
const pay = () => {
  const chip = screen.queryByTestId('movimentacao-status') as HTMLButtonElement | null;
  return chip && !chip.disabled ? chip : null;
};

afterEach(cleanup);

describe('MovimentacaoRow — root signal', () => {
  it('root>=0 with a negative occurrence (+1200/-200): ordinary status chip and actions, no "Crédito", no "− -R$"', () => {
    row(saida(-20_000, { expenseIsCredit: false }), undefined);
    expect(screen.queryByText('Crédito')).toBeNull();
    expect(pay()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Excluir' })).toBeInTheDocument(); // P01 ordinary row
    expect(document.body.textContent).not.toMatch(/[−-]\s*-R\$/);
    expect(document.body.textContent).toMatch(/-R\$\s*200,00/);
  });

  it('signal=false is not a permission: a P01-blocked row (editavel=false) stays without pay/delete', () => {
    row(saida(-20_000, { expenseIsCredit: false }, { editavel: false }), undefined);
    expect(pay()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull();
  });

  it('root credit with a POSITIVE occurrence (legacy): credit policy, delete only with explicit capability', () => {
    row(saida(30_000, { expenseIsCredit: true }), false);
    expect(screen.getByText('Crédito')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ratear|Vincular|Paga|Quitar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull();
  });

  it('root credit with a negative occurrence (ordinary credit): Excluir only with the real capability', () => {
    row(saida(-40_000, { expenseIsCredit: true }), true);
    expect(screen.getByText('Crédito')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ratear|Vincular|Paga|Quitar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Excluir' })).toBeInTheDocument();
  });

  it.each([-40_000, 40_000])('field absent, occurrence %i, no read yet: restricted, no invented "Crédito", no Excluir', (valor) => {
    row(saida(valor), undefined);
    expect(screen.queryByText('Crédito')).toBeNull();
    expect(pay()).toBeNull();
    expect(screen.queryByRole('button', { name: /Ratear|Vincular|Quitar|Excluir/ })).toBeNull();
  });

  it('intent (hover/focus) requests the root only when the identity is not already known false', () => {
    const onRequestRoot = vi.fn();
    render(<MovimentacaoRow item={saida(-40_000)} originLabel={() => null} onRequestRoot={onRequestRoot} {...handlers()} />);
    fireEvent.pointerEnter(screen.getByTestId('movimentacao-row'));
    expect(onRequestRoot).toHaveBeenCalledTimes(1);
    cleanup();
    const known = vi.fn();
    render(<MovimentacaoRow item={saida(-40_000, { expenseIsCredit: false })} originLabel={() => null} onRequestRoot={known} {...handlers()} />);
    fireEvent.pointerEnter(screen.getByTestId('movimentacao-row'));
    expect(known).not.toHaveBeenCalled();
  });

  it('loading: neutral "Verificando ações", still restricted', () => {
    render(
      <MovimentacaoRow item={saida(-40_000)} originLabel={() => null} rootState={{ status: 'loading', retry: vi.fn() }} {...handlers()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Verificando ações');
    expect(screen.queryByText('Crédito')).toBeNull();
    expect(pay()).toBeNull();
  });

  it('error: visible message + retry; never "Crédito" nor a permission', () => {
    const retry = vi.fn();
    render(
      <MovimentacaoRow item={saida(-40_000)} originLabel={() => null} rootState={{ status: 'error', retry }} {...handlers()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Crédito')).toBeNull();
    expect(pay()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull();
  });

  it('detail proves a positive root: the ordinary P01 actions are restored; a credit detail keeps the credit policy', () => {
    const positive = { id: 'x', valorTotal: 100_000 } as never;
    const { unmount } = render(
      <MovimentacaoRow item={saida(-40_000)} originLabel={() => null} rootState={{ status: 'ready', expense: positive, retry: vi.fn() }} {...handlers()} />,
    );
    expect(screen.queryByText('Crédito')).toBeNull();
    expect(pay()).not.toBeNull();
    unmount();
    const credit = { id: 'x', valorTotal: -40_000, canDelete: true } as never;
    render(
      <MovimentacaoRow item={saida(40_000)} originLabel={() => null} expenseDeleteAllowed rootState={{ status: 'ready', expense: credit, retry: vi.fn() }} {...handlers()} />,
    );
    expect(screen.getByText('Crédito')).toBeInTheDocument();
    expect(pay()).toBeNull();
  });
});

/* -------------------- Section: detail-read fallback when the field is absent -------------------- */
function response(saidas: AccountViewSaida[]): AccountViewResponse {
  return {
    mesSelecionado: '2026-06', caixaHoje: 0, carteiraHoje: 0, entrouMes: 0, saiuMes: 0, faltaPagarMes: 0,
    recebimentosPrevistosMes: 0, sobraPrevista: 0, devoCartaoTotal: 0, cartoes: [], contas: [], saidas,
    comprasCartao: [], entradas: [],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
  };
}
function mount(data: AccountViewResponse, client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <MovimentacoesSection
        data={data} projectId="proj-1" originFilter={null} onClearOrigin={vi.fn()} onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()} onSettleWithResidual={vi.fn()} onUndoPayment={vi.fn()}
        summaryQuickFilter={null} onClearSummaryQuickFilter={vi.fn()}
      />
    </QueryClientProvider>,
  );
}
const detailReads = () =>
  vi.mocked(api.get).mock.calls.filter(([url]) => /\/projects\/[^/]+\/expenses\/[^/]+$/.test(String(url)));

describe('MovimentacoesSection — root resolution without the field (on demand)', () => {
  let detail: () => Promise<unknown>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockImplementation(async (path: string) => (path === '/projects/proj-1/expenses/x' ? detail() : []));
  });
  const intent = () => fireEvent.pointerEnter(screen.getByTestId('movimentacao-row'));

  it('no read on mount (any sign); intent reads once; a positive-root detail restores the ordinary row', async () => {
    detail = async () => ({ id: 'x', valorTotal: 100_000, valor: 100_000 });
    mount(response([saida(-20_000)]));
    await screen.findByTestId('movimentacao-row');
    expect(detailReads()).toHaveLength(0);
    expect(pay()).toBeNull();
    intent();
    await waitFor(() => expect(pay()).not.toBeNull());
    expect(screen.queryByText('Crédito')).toBeNull();
    expect(detailReads()).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/projects/proj-1/expenses/x');
  });

  it('a credit root by detail: credit policy without pay; Excluir only from the detail canDelete', async () => {
    detail = async () => ({ id: 'x', valorTotal: -20_000, valor: -20_000, canDelete: false });
    mount(response([saida(-20_000)]));
    intent();
    await waitFor(() => expect(within(screen.getByTestId('movimentacao-row')).getByText('Crédito')).toBeInTheDocument());
    const rowEl = screen.getByTestId('movimentacao-row');
    expect(within(rowEl).queryByRole('button', { name: /Paga|A pagar|Excluir/ })).toBeNull();
  });

  it.each([
    ['read error', async () => Promise.reject(new Error('boom'))],
    ['empty body', async () => undefined],
  ])('%s: visible error + retry, restricted, never "Crédito"; retry recovers', async (_l, read) => {
    detail = read as () => Promise<unknown>;
    mount(response([saida(20_000)]));
    intent();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    expect(within(screen.getByTestId('movimentacao-row')).queryByText('Crédito')).toBeNull();
    expect(pay()).toBeNull();
    detail = async () => ({ id: 'x', valorTotal: 100_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(pay()).not.toBeNull());
  });

  it('cached SUCCESS (canDelete=true) + failing refetch: the error wins — no Excluir/actions from the stale body, visible error + retry', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(['expense', 'proj-1', 'x'], { id: 'x', valorTotal: -20_000, valor: -20_000, canDelete: true });
    detail = async () => Promise.reject(new Error('503'));
    mount(response([saida(-20_000, { expenseIsCredit: true })]), client);
    intent();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    expect(within(screen.getByTestId('movimentacao-row')).queryByRole('button', { name: /Excluir|Paga|A pagar/ })).toBeNull();
    detail = async () => ({ id: 'x', valorTotal: -20_000, valor: -20_000, canDelete: true });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Excluir' })).toBeInTheDocument();
  });

  it('flag false: no read even after intent; non-flag rows read nothing until intent', async () => {
    detail = async () => ({ id: 'x', valorTotal: 100_000 });
    mount(response([saida(-20_000, { expenseIsCredit: false })]));
    intent();
    expect(detailReads()).toHaveLength(0);
    expect(pay()).not.toBeNull();
  });
});
