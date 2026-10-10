import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { receiptFixture, summaryFixture, viewFixture } from '../_lib/import-session-fixtures';

// Only the HTTP client is mocked: the real import-session-api guards, hooks and components run.
const apiGet = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (...a: unknown[]) => apiGet(...a), post: vi.fn() },
}));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'user-a' } }),
}));

import { ImportRecoveryPanel } from './ImportRecoveryPanel';

const appliedRow = summaryFixture({
  id: 'sess-9',
  state: 'APPLIED',
  actions: ['READ_RESULT'],
  appliedAt: '2026-09-20T02:30:00.000Z',
});
const draftRow = summaryFixture({
  id: 'sess-a',
  cardId: 'card-1',
  ownerProjectId: 'proj-1',
});

type Body = Record<string, unknown>;
let catalogCards: unknown = [];
let catalogProjects: unknown = [];
let receipt: unknown = receiptFixture();

beforeEach(() => {
  apiGet.mockReset();
  catalogCards = [];
  catalogProjects = [];
  receipt = receiptFixture();
  apiGet.mockImplementation(async (path: string) => {
    if (path.startsWith('/import-sessions?')) return { items: [appliedRow, draftRow], nextCursor: null };
    if (path === '/import-sessions/sess-9/result') return { state: 'APPLIED', receipt };
    if (path === '/import-sessions/sess-a') return viewFixture({ id: 'sess-a' });
    if (path === '/tenant/credit-cards') return catalogCards;
    if (path === '/projects') return catalogProjects;
    throw new Error(`unexpected ${path}`);
  });
});

describe('malformed public entry is not a malformed recovery page', () => {
  it.each([
    ['missing', {}],
    ['invalid', { entry: { kind: 'CARD_INVOICE', formats: [] } }],
  ])('keeps detail/cancel usable and exposes the %s entry error separately', async (_name, extension) => {
    const recovery = {
      items: [draftRow],
      nextCursor: null,
      ...extension,
    };
    const read = apiGet.getMockImplementation();
    if (!read) throw new Error('Missing recovery transport fixture');
    const active = viewFixture({ id: 'sess-a' });
    const cancelled = viewFixture({
      id: active.id,
      state: 'CANCELLED',
      revision: 4,
      expiresAt: null,
      attachments: [],
      actions: [],
    });
    const detailRead = vi.fn().mockResolvedValueOnce(active).mockResolvedValue(cancelled);
    const listRead = vi
      .fn()
      .mockResolvedValueOnce(recovery)
      .mockResolvedValue({ ...recovery, items: [] });
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/import-sessions?')) return listRead();
      if (path === '/import-sessions/sess-a') return detailRead();
      return read(path);
    });
    const { api } = await import('@/lib/api');
    const real = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    const post = vi.spyOn(api, 'post').mockImplementation(real.api.post);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(cancelled), { status: 200 }));
    const h = renderPanel();
    try {
      fireEvent.click(await screen.findByTestId('import-session-row'));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancelar importação' }));
      expect(fetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Sim, cancelar' }));
      await screen.findByText('Importação cancelada.');
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = fetch.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe('/import-sessions/sess-a/cancel');
      expect(options).toMatchObject({
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-rf-import-ui': '1',
        },
        body: JSON.stringify({ expectedRevision: active.revision }),
      });
      await waitFor(() => expect(detailRead).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole('heading', { name: /^Cancelada\b/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancelar importação' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
      await screen.findByText('Nenhuma importação para retomar');
      // Availability wording is proposed for GREEN, not a generic transport/cancel alert.
      expect(screen.getByRole('alert')).toHaveTextContent(
        /não foi possível verificar a disponibilidade de novas importações/i,
      );
      expect(screen.queryByRole('button', { name: 'Analisar e guardar rascunho' })).toBeNull();
    } finally {
      h.unmount();
      post.mockRestore();
      fetch.mockRestore();
    }
  });
});

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ImportRecoveryPanel />
    </QueryClientProvider>,
  );
}

async function openReceipt() {
  renderPanel();
  const rows = await screen.findAllByTestId('import-session-row');
  fireEvent.click(rows[0]);
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('malformed receipt bodies', () => {
  const cases: Array<[string, (r: Body) => void]> = [
    ['a line without targets', (r) => void delete ((r.snapshot as Body).lines as Body[])[0].targets],
    ['no invoiceDeltas', (r) => void delete (r.snapshot as Body).invoiceDeltas],
    ['a null snapshot line', (r) => void (((r.snapshot as Body).lines as unknown[])[0] = null)],
    ['a bank effect of +1', (r) => void ((r.snapshot as Body).bankCashDeltaCents = 1)],
    ['a bank effect of -1', (r) => void ((r.snapshot as Body).bankCashDeltaCents = -1)],
    ['a line without schedule', (r) => void delete ((r.snapshot as Body).lines as Body[])[0].schedule],
  ];
  for (const [name, mutate] of cases) {
    it(`shows a readable error with retry, not a crash or R$ 0, for ${name}`, async () => {
      const bad = clone(receiptFixture()) as unknown as Body;
      mutate(bad);
      receipt = bad;
      await openReceipt();

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
      expect(screen.queryByTestId('import-receipt')).toBeNull();
      expect(screen.queryByText('R$ 0,00')).toBeNull();
      // The panel stays mounted and navigable.
      expect(screen.getByRole('button', { name: 'Voltar' })).toBeInTheDocument();
    });
  }
});

describe('a broken decorative catalog never unmounts the panel', () => {
  it('keeps the list and uses Cartão/Projeto when the catalog has null members', async () => {
    catalogCards = [null, { id: 'card-9' }];
    catalogProjects = [null, 3];
    renderPanel();
    const rows = await screen.findAllByTestId('import-session-row');
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/tenant/credit-cards'));
    expect(rows).toHaveLength(2);
    expect(await screen.findAllByText(/Cartão/)).not.toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Importações da Maria' })).toBeInTheDocument();
  });

  it('keeps the receipt with generic names when the catalog is not an array', async () => {
    catalogCards = { unexpected: true };
    catalogProjects = null;
    await openReceipt();
    expect(await screen.findByTestId('import-receipt')).toBeInTheDocument();
    expect(screen.getAllByText(/Projeto/).length).toBeGreaterThan(0);
  });
});

describe('cancel copy', () => {
  it('says cancelling creates no entries and does not undo completed operations, without promising erasure', async () => {
    renderPanel();
    const rows = await screen.findAllByTestId('import-session-row');
    fireEvent.click(rows[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar importação' }));
    expect(screen.queryByText(/Nada será lançado/i)).toBeNull();
    expect(screen.getByText(/não cria lançamentos/i)).toBeInTheDocument();
    expect(screen.getByText(/não desfaz operações já concluídas/i)).toBeInTheDocument();
    expect(screen.queryByText(/descartados|apagad|exclu[ií]d/i)).toBeNull();
  });
});
