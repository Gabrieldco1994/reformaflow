/**
 * The three Runway verbs (adiar / reduzir / remover) must consume a server rejection through
 * React Query's own error path (`onError` toast + refetch): a rejected `mutateAsync` that nobody
 * awaits surfaces as an Unhandled Rejection and turns the whole vitest process red (exit 1) while
 * every assertion still passes. On error the editor keeps its inputs and nothing reports success;
 * only success calls `onDone` (close) and closes the inline editor.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { RunwayCandidato } from '../../dre/_types';
import { RunwayActionSheet } from './RunwayActionSheet';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const candidato: RunwayCandidato = {
  expenseId: 'x',
  descricao: 'Contrato x',
  valor: 150_000,
  data: '2026-10-05T00:00:00.000Z',
  projetoOrigem: null,
};

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

let client: QueryClient;
let onClose: ReturnType<typeof vi.fn>;
let invalidate: MockInstance<QueryClient['invalidateQueries']>;

async function openSheet() {
  render(
    <QueryClientProvider client={client}>
      <RunwayActionSheet candidatos={[candidato]} piorSaldo={-1} piorMes="2026-10" projectId="p1" onClose={onClose} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Remover despesa' });
}

beforeEach(() => {
  vi.clearAllMocks();
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(client, 'invalidateQueries');
  onClose = vi.fn();
  vi.mocked(api.get).mockResolvedValue({ id: 'x', valorTotal: 150_000, valor: 150_000, canDelete: true, schedule: null });
});
afterEach(() => process.off('unhandledRejection', onUnhandled));

const dateInput = () => document.querySelector<HTMLInputElement>('input[type="date"]');
const cutInvalidations = () =>
  invalidate.mock.calls.filter(([filters]) => JSON.stringify(filters).includes('dre-overview'));

const VERBS = [
  {
    name: 'adiar',
    start: async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adiar' }));
      fireEvent.change(dateInput()!, { target: { value: '2026-11-20' } });
    },
    submit: () => fireEvent.click(screen.getByRole('button', { name: 'OK' })),
    api: () => vi.mocked(api.patch),
    editorKept: () => expect(dateInput()!.value).toBe('2026-11-20'),
    editorGone: () => expect(dateInput()).toBeNull(),
    errorToast: 'Erro ao adiar: 409 conflito',
    successToast: 'Data adiada',
  },
  {
    name: 'reduzir',
    start: async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reduzir' }));
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '12.34' } });
    },
    submit: () => fireEvent.click(screen.getByRole('button', { name: 'OK' })),
    api: () => vi.mocked(api.patch),
    editorKept: () => expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('12.34'),
    editorGone: () => expect(screen.queryByRole('spinbutton')).toBeNull(),
    errorToast: 'Erro ao reduzir: 409 conflito',
    successToast: 'Valor reduzido',
  },
  {
    name: 'remover',
    start: async () => {},
    submit: () => fireEvent.click(screen.getByRole('button', { name: 'Remover despesa' })),
    api: () => vi.mocked(api.delete),
    editorKept: () => expect(screen.getByRole('button', { name: 'Remover despesa' })).toBeInTheDocument(),
    editorGone: () => {},
    errorToast: 'Erro ao remover: 409 conflito',
    successToast: 'Despesa removida',
  },
] as const;

describe.each(VERBS)('RunwayActionSheet — $name', (verb) => {
  it('a server rejection is consumed by the mutation error path: toast, no success, no close, inputs kept, no unhandled rejection', async () => {
    await openSheet();
    await verb.start();
    verb.api().mockRejectedValueOnce(new Error('409 conflito'));
    verb.submit();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(verb.errorToast));
    await flush();
    expect(unhandled).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    verb.editorKept();
    // The row is usable again (not stuck pending): the same verb can be retried.
    await waitFor(() => expect(screen.getByRole('button', { name: /OK|Remover despesa/ })).toBeEnabled());
  });

  it('success toasts, refetches, closes the sheet once and closes the inline editor', async () => {
    await openSheet();
    await verb.start();
    verb.api().mockResolvedValueOnce({});
    verb.submit();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(verb.successToast));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
    expect(cutInvalidations().length).toBeGreaterThan(0);
    verb.editorGone();
    await flush();
    expect(unhandled).toEqual([]);
  });
});

describe('a failed retry after an error still closes only on the eventual success', () => {
  it('adiar: error, then success closes exactly once', async () => {
    await openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Adiar' }));
    fireEvent.change(dateInput()!, { target: { value: '2026-11-20' } });
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce({});

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledTimes(2);
    await flush();
    expect(unhandled).toEqual([]);
  });
});
