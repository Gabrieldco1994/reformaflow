/**
 * #704 follow-up — the sign of an OCCURRENCE is not the policy of its ROOT.
 *
 * `MonthlyEntry.valor` / `RunwayCandidato.valor` (a window SUM) / queue-item `valor`
 * (occurrence or `remainingCents`) are cash-flow amounts; the root policy follows
 * `Expense.valorTotal < 0`. Contract:
 *   1. `expenseIsCredit` (server root signal) is NOT a permission. `true` blocks
 *      credit-only surfaces; `false` only says "not a credit": documented schedule
 *      (#701), window <= 0 and every other P01 rule still apply.
 *   2. Signal absent (any sign): identity is resolved from the REAL detail read
 *      (`['expense', owner, id]`) ON DEMAND (user intent / opened sheet), never for a
 *      whole list. Missing / loading / error / empty body keep actions restricted with
 *      a neutral "Verificando ações" (never an invented "Crédito"), a visible error
 *      and a retry.
 *   3. Category is metadata (editable on a positive root even with a negative
 *      occurrence; credit root: never). Runway is financial (cut candidate: window > 0,
 *      root not credit, no documented schedule).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isNeutralExpenseType } from '@reformaflow/domain';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { RunwayCandidato } from '../../dre/_types';
import type { MonthlyEntry } from '../_types';
import CategoriaDespesasModal from './CategoriaDespesasModal';
import { PendenciasQueueCard } from './PendenciasQueueCard';
import { RunwayActionSheet } from './RunwayActionSheet';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../expenses/_components/BulkLinkModal', () => ({ BulkLinkModal: () => null }));
vi.mock('../../conta/_components/PagarFaturaDialog', () => ({ PagarFaturaDialog: () => null }));
vi.mock('../../conta/_components/QuitarParcelaModal', () => ({ QuitarParcelaModal: () => null }));
vi.mock('../../conta/_components/ReceitaModal', () => ({ ReceitaModal: () => null }));

function withQuery(ui: React.ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Root = { expenseIsCredit?: boolean };
/** Root signal is not in the web types yet (RED plan): attach it without widening them. */
const withRoot = <T,>(value: T, root: Root): T => ({ ...value, ...root });

/** Real expense detail as the existing GET returns it (root amounts, not occurrence). */
type Detail =
  | 'positive-root'
  | 'positive-root-plain'
  | 'positive-root-cannot-delete'
  | 'positive-root-can-delete'
  | 'credit-root'
  | 'error'
  | 'absent';
function detailRead(kind: Detail) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (/\/projects\/p1\/expenses\/x$/.test(url)) {
      if (kind === 'error') throw new Error('boom');
      if (kind === 'absent') return undefined;
      const valorTotal = kind === 'credit-root' ? -4_000 : 100_000;
      const canDelete = kind === 'positive-root-cannot-delete' ? false : kind === 'positive-root-can-delete' ? true : undefined;
      return { id: 'x', valorTotal, valor: valorTotal, canDelete, schedule: kind === 'positive-root' ? { version: 1 } : null };
    }
    return null;
  });
}
const detailReads = () =>
  vi.mocked(api.get).mock.calls.filter(([url]) => /\/projects\/[^/]+\/expenses\/[^/]+$/.test(String(url)));

beforeEach(() => vi.clearAllMocks());

/** A previously SUCCESSFUL detail read left in the cache (the next fetch fails: 503/403). */
function clientWithCachedRoot(root: object) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['expense', 'p1', 'x'], root);
  return client;
}
const CACHED_OK = { id: 'x', valorTotal: 100_000, valor: 100_000, schedule: null, canDelete: true };

/* ------------------------------ CategoriaDespesasModal ------------------------------ */
describe('CategoriaDespesasModal — root policy, not occurrence sign', () => {
  const entry = (valor: number, root: Root = {}): MonthlyEntry =>
    withRoot(
      {
        id: 'x',
        expenseId: 'x',
        data: '2026-08-10',
        tipo: 'DESPESA',
        status: 'PAGO',
        valor,
        categoria: 'Outros',
        categoriaCodigo: 'OUTROS',
        tipoDespesaCodigo: 'OUTROS',
        titulo: 'x',
        subcategoria: null,
        formaPagamento: 'A_VISTA',
        projectId: 'p1',
        projectName: 'P',
        projectType: 'PESSOAL',
      } as MonthlyEntry,
      root,
    );
  const open = (e: MonthlyEntry) =>
    withQuery(
      <CategoriaDespesasModal categoria="Outros" entries={[e]} year={2026} statusMode="realPlus" onClose={vi.fn()} />,
    );
  const pencil = () => screen.queryByRole('button', { name: 'Editar tipo de despesa' });
  const creditNote = () => screen.queryByText(/Crédito: a categoria não é alterada aqui/);

  it('signal=false + negative occurrence (+1200/-200): category editable, PATCH sends tipoDespesa only, no read', async () => {
    open(entry(-200, { expenseIsCredit: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Editar tipo de despesa' }));
    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    const other = [...select.options].find((o) => o.value && o.value !== 'OUTROS')!.value;
    fireEvent.change(select, { target: { value: other } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/projects/p1/expenses/x', { tipoDespesa: other }));
    expect(detailReads()).toHaveLength(0);
  });

  it.each([500, -4_000])('signal=true (occurrence %i, legacy or ordinary credit): blocked, no read', (valor) => {
    open(entry(valor, { expenseIsCredit: true }));
    expect(pencil()).toBeNull();
    expect(detailReads()).toHaveLength(0);
  });

  it.each([10_000, -200])('signal absent, occurrence %i: no read on mount; the click reads once and a positive root opens the editor', async (valor) => {
    detailRead('positive-root');
    open(entry(valor));
    expect(detailReads()).toHaveLength(0);
    fireEvent.click(pencil()!);
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(detailReads()).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/projects/p1/expenses/x');
  });

  it.each([500, -4_000])('signal absent, occurrence %i, CREDIT root by detail: blocked with the plain note (even when the occurrence is positive)', async (valor) => {
    detailRead('credit-root');
    open(entry(valor));
    fireEvent.click(pencil()!);
    await waitFor(() => expect(creditNote()).not.toBeNull());
    expect(pencil()).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it.each<Detail>(['error', 'absent'])('signal absent, detail=%s: restricted, visible error + retry, never "Crédito"; retry recovers', async (kind) => {
    detailRead(kind);
    open(entry(-4_000));
    fireEvent.click(pencil()!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(creditNote()).toBeNull();
    detailRead('positive-root');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });

  // Server contract (expense.service update): on a DOCUMENTED root the category is metadata and is
  // accepted, EXCEPT a change to a neutral type (protected change -> 409). The mock mirrors that,
  // so these are not "PATCH always 200" green tests. The modal does not know the schedule; the server decides.
  describe('positive DOCUMENTED root, negative occurrence (server-shaped PATCH)', () => {
    const serverPatch = () =>
      vi.mocked(api.patch).mockImplementation(async (_url: string, body?: unknown) => {
        if (isNeutralExpenseType((body as { tipoDespesa?: string })?.tipoDespesa))
          throw new Error('Cronograma documentado exige correção assistida');
        return {};
      });
    const editWith = async (pick: (values: string[]) => string) => {
      detailRead('positive-root'); // documented schedule on a positive root
      open(entry(-200));
      fireEvent.click(pencil()!);
      const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
      const values = [...select.options].map((o) => o.value);
      const chosen = pick(values);
      fireEvent.change(select, { target: { value: chosen } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      return chosen;
    };

    it('a non-neutral category is sent as metadata only and the success is reported', async () => {
      serverPatch();
      const chosen = await editWith((v) => v.find((x) => x !== 'OUTROS' && !isNeutralExpenseType(x))!);
      await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/projects/p1/expenses/x', { tipoDespesa: chosen }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
    });

    it('a NEUTRAL category (server 409) surfaces the error and never claims success', async () => {
      serverPatch();
      const neutral = (v: string[]) => v.find((x) => isNeutralExpenseType(x));
      detailRead('positive-root');
      open(entry(-200));
      fireEvent.click(pencil()!);
      const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
      const target = neutral([...select.options].map((o) => o.value));
      if (!target) return; // no neutral option offered for this project type: nothing to guard
      fireEvent.change(select, { target: { value: target } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('correção assistida')));
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  it('cached SUCCESS + failing refetch (503/403): the error wins — restricted, visible error, no editor from the stale body; retry recovers', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('503'));
    withQuery(
      <CategoriaDespesasModal categoria="Outros" entries={[entry(-4_000)]} year={2026} statusMode="realPlus" onClose={vi.fn()} />,
      clientWithCachedRoot(CACHED_OK),
    );
    fireEvent.click(pencil()!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(creditNote()).toBeNull();
    detailRead('positive-root-plain');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });

  it('while the read is pending: neutral "Verificando ações", no editor, no credit label', async () => {
    let release: (v: unknown) => void = () => undefined;
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    open(entry(-4_000));
    fireEvent.click(pencil()!);
    expect(await screen.findByRole('status')).toHaveTextContent('Verificando ações');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(creditNote()).toBeNull();
    release({ id: 'x', valorTotal: 100_000 });
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });
});

/* ---------------------------------- RunwayActionSheet ---------------------------------- */
describe('RunwayActionSheet — financial policy from the real root, not the summed window value', () => {
  const cand = (valor: number, root: Root = {}, expenseId = 'x'): RunwayCandidato =>
    withRoot(
      { expenseId, descricao: `Contrato ${expenseId}`, valor, data: '2026-10-05T00:00:00.000Z', projetoOrigem: null },
      root,
    );
  const open = (...c: RunwayCandidato[]) =>
    withQuery(
      <RunwayActionSheet candidatos={c} piorSaldo={-1} piorMes="2026-10" projectId="p1" onClose={vi.fn()} />,
    );
  const actions = () => screen.getAllByRole('listitem').flatMap((li) => [...li.querySelectorAll('button')]).filter((b) => !/Tentar novamente/.test(b.textContent ?? ''));

  it('NORMAL positive control: window > 0, plain positive root (no schedule) -> adiar/reduzir/remover after the read', async () => {
    detailRead('positive-root-plain');
    open(cand(150_000));
    await waitFor(() => expect(actions()).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'Adiar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remover despesa' })).toBeInTheDocument();
    expect(detailReads()).toHaveLength(1);
  });

  it('canDelete=false on a NORMAL positive root: Remover is not offered, Adiar/Reduzir stay (signal false grants no verb)', async () => {
    detailRead('positive-root-cannot-delete');
    open(cand(150_000, { expenseIsCredit: false }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adiar' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Reduzir' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remover despesa' })).toBeNull();
    expect(actions()).toHaveLength(2);
  });

  it.each<Detail>(['positive-root-can-delete', 'positive-root-plain'])('canDelete true/absent on a normal positive root (%s): all three verbs', async (kind) => {
    detailRead(kind);
    open(cand(150_000));
    await waitFor(() => expect(actions()).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'Remover despesa' })).toBeInTheDocument();
  });

  it('a failed Remover (409) rereads the detail: the stale Remover disappears when canDelete turned false', async () => {
    detailRead('positive-root-can-delete');
    open(cand(150_000));
    const remover = await screen.findByRole('button', { name: 'Remover despesa' });
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('Exclusão não autorizada agora.'));
    detailRead('positive-root-cannot-delete');
    fireEvent.click(remover);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remover despesa' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Adiar' })).toBeInTheDocument();
    expect(api.delete).toHaveBeenCalledWith('/projects/p1/expenses/x');
  });

  it('cached SUCCESS + failing refetch (503/403): the error wins — no verb from the stale body; retry recovers', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('403'));
    withQuery(
      <RunwayActionSheet candidatos={[cand(150_000)]} piorSaldo={-1} piorMes="2026-10" projectId="p1" onClose={vi.fn()} />,
      clientWithCachedRoot(CACHED_OK),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    expect(actions()).toHaveLength(0);
    detailRead('positive-root-plain');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(actions()).toHaveLength(3));
  });

  it('documented schedule blocks every action even on a positive root (signal=false does not override)', async () => {
    detailRead('positive-root');
    open(cand(150_000, { expenseIsCredit: false }));
    await waitFor(() => expect(screen.getByText(/Cronograma documentado/)).toBeInTheDocument());
    expect(actions()).toHaveLength(0);
  });

  it.each([-200, 0])('window sum %i is not a cut candidate: no action even for a non-credit root, and no read', (valor) => {
    open(cand(valor, { expenseIsCredit: false }));
    expect(actions()).toHaveLength(0);
    expect(detailReads()).toHaveLength(0);
  });

  it('a negative window sum keeps its plain money display (no double sign)', () => {
    open(cand(-40_000, { expenseIsCredit: false }));
    expect(screen.getByRole('listitem')).toHaveTextContent('-R$ 400');
    expect(screen.getByRole('listitem').textContent).not.toMatch(/-\s*-R\$/);
  });

  it('signal=true: no action and no read (even with a positive window sum, legacy root<0)', () => {
    open(cand(50_000, { expenseIsCredit: true }));
    expect(actions()).toHaveLength(0);
    expect(detailReads()).toHaveLength(0);
  });

  it('credit root proven by detail with a positive window sum: no action', async () => {
    detailRead('credit-root');
    open(cand(50_000));
    await waitFor(() => expect(detailReads()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(actions()).toHaveLength(0);
  });

  it('opening reads at most one detail per cut candidate (the sheet lists a handful), none for non-candidates', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => ({ id: url, valorTotal: 100_000, valor: 100_000 }));
    open(cand(90_000, {}, 'a'), cand(80_000, {}, 'b'), cand(-100, {}, 'c'));
    await waitFor(() => expect(actions()).toHaveLength(6));
    expect(detailReads()).toHaveLength(2);
  });

  it('while the read is pending: neutral "Verificando ações", no action, no "Crédito"', () => {
    vi.mocked(api.get).mockImplementation(() => new Promise(() => undefined));
    open(cand(90_000));
    expect(screen.getByRole('status')).toHaveTextContent('Verificando ações');
    expect(actions()).toHaveLength(0);
    expect(screen.queryByText(/Crédito/)).toBeNull();
  });

  it.each<Detail>(['error', 'absent'])('detail=%s: restricted, visible error + retry, retry recovers', async (kind) => {
    detailRead(kind);
    open(cand(90_000));
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    expect(actions()).toHaveLength(0);
    detailRead('positive-root-plain');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(actions()).toHaveLength(3));
  });
});

/* ------------------------------ PendenciasQueueCard ------------------------------ */
describe('PendenciasQueueCard SEM_CATEGORIA — root policy, not item.valor', () => {
  let currentDetail: () => unknown = () => undefined;
  async function queue(valor: number, root: Root = {}) {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras'))
        return {
          total: 1,
          grupos: [
            {
              tipo: 'SEM_CATEGORIA',
              label: 'Sem categoria',
              count: 1,
              valorTotal: valor,
              itens: [
                withRoot(
                  {
                    id: 'sem-categoria-x',
                    tipo: 'SEM_CATEGORIA',
                    label: 'Confirmar categoria',
                    descricao: 'Estorno loja',
                    valor,
                    data: '2026-07-10T00:00:00.000Z',
                    expenseId: 'x',
                    suggestionTipoDespesa: 'MERCADO',
                  },
                  root,
                ),
              ],
            },
          ],
        };
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      if (/\/projects\/p1\/expenses\/x$/.test(url)) return currentDetail();
      return null;
    });
    withQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" projectType="PESSOAL" />);
    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));
  }
  const cta = () => screen.queryByRole('button', { name: 'Confirmar categoria' });
  const reason = () => screen.queryByText(/Crédito: a categoria não é alterada aqui/);
  const opened = () => screen.queryByRole('combobox');

  it('signal=false + negative valor (remaining/occurrence of a non-credit root): CTA, click proceeds with no read', async () => {
    await queue(-20_000, { expenseIsCredit: false });
    expect(reason()).toBeNull();
    fireEvent.click(cta()!);
    await waitFor(() => expect(opened()).not.toBeNull());
    expect(detailReads().filter(([url]) => /expenses\/x$/.test(String(url))).length).toBeLessThanOrEqual(1); // only the confirm flow's own read, later
  });

  it('signal=true + positive valor (legacy root<0): blocked with the plain reason', async () => {
    await queue(25_000, { expenseIsCredit: true });
    expect(cta()).toBeNull();
    expect(reason()).not.toBeNull();
    expect(detailReads()).toHaveLength(0);
  });

  it.each([25_000, -20_000])('signal absent, valor %i: CTA visible, no read on mount; the click verifies once and a non-credit root proceeds', async (valor) => {
    currentDetail = () => ({ id: 'x', valorTotal: 100_000, valor: 100_000 });
    await queue(valor);
    expect(cta()).not.toBeNull();
    expect(detailReads()).toHaveLength(0);
    fireEvent.click(cta()!);
    await waitFor(() => expect(opened()).not.toBeNull());
    expect(detailReads()).toHaveLength(1);
  });

  it.each([25_000, -20_000])('signal absent, valor %i, CREDIT root by detail: plain reason after the click, no editor, no write', async (valor) => {
    currentDetail = () => ({ id: 'x', valorTotal: -20_000, valor: -20_000 });
    await queue(valor);
    fireEvent.click(cta()!);
    await waitFor(() => expect(reason()).not.toBeNull());
    expect(opened()).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it.each([
    ['read error', () => Promise.reject(new Error('boom'))],
    ['empty body', () => undefined],
  ])('signal absent + %s: visible error, restricted, retry recovers; never "Crédito"', async (_l, read) => {
    currentDetail = read as () => unknown;
    await queue(-20_000);
    fireEvent.click(cta()!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível verificar as ações');
    expect(opened()).toBeNull();
    expect(reason()).toBeNull();
    currentDetail = () => ({ id: 'x', valorTotal: 100_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(opened()).not.toBeNull());
  });
});
