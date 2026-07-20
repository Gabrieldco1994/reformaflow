import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { PendenciasQueueCard } from './PendenciasQueueCard';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}));

vi.mock('../../expenses/_components/BulkLinkModal', () => ({
  BulkLinkModal: ({ open }: { open: boolean }) => (open ? <div>BulkLinkModal aberto</div> : null),
}));
vi.mock('../../conta/_components/DespesaModal', () => ({ DespesaModal: () => null }));
vi.mock('../../conta/_components/PagarFaturaDialog', () => ({ PagarFaturaDialog: () => null }));
vi.mock('../../conta/_components/QuitarParcelaModal', () => ({ QuitarParcelaModal: () => null }));
vi.mock('../../conta/_components/ReceitaModal', () => ({ ReceitaModal: () => null }));

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('PendenciasQueueCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not render when queue is empty', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) return { total: 0, grupos: [] };
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" />);

    expect(await screen.queryByText(/Precisa de você/i)).not.toBeInTheDocument();
  });

  it('renders card and group details', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) {
        return {
          total: 1,
          grupos: [
            {
              tipo: 'SEM_CONTA',
              label: 'Sem conta',
              count: 1,
              valorTotal: 12000,
              itens: [
                {
                  id: 'i1',
                  tipo: 'SEM_CONTA',
                  label: 'Vincular origem',
                  descricao: 'Compra sem conta',
                  valor: 12000,
                  data: '2026-07-01T00:00:00.000Z',
                  expenseId: 'e1',
                },
              ],
            },
          ],
        };
      }
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" />);

    expect(await screen.findByText(/1 pendência financeira/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Resolver/i }));
    expect(await screen.findByText('Sem conta')).toBeInTheDocument();
    expect(screen.getByText('Compra sem conta')).toBeInTheDocument();
  });

  it('closes queue sheet before opening bulk-link action modal', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) {
        return {
          total: 1,
          grupos: [
            {
              tipo: 'SEM_CONTA',
              label: 'Sem conta',
              count: 1,
              valorTotal: 12000,
              itens: [
                {
                  id: 'i1',
                  tipo: 'SEM_CONTA',
                  label: 'Vincular origem',
                  descricao: 'Compra sem conta',
                  valor: 12000,
                  data: '2026-07-01T00:00:00.000Z',
                  expenseId: 'e1',
                },
              ],
            },
          ],
        };
      }
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      if (url.includes('/expenses/e1')) return { id: 'e1' };
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" />);

    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Vincular origem/i }));

    expect(screen.queryByRole('heading', { name: /Precisa de você/i })).not.toBeInTheDocument();
    expect(await screen.findByText('BulkLinkModal aberto')).toBeInTheDocument();
  });
});
