import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { PendenciasQueueCard } from './PendenciasQueueCard';
import { api } from '@/lib/api';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
}));

vi.mock('../../expenses/_components/BulkLinkModal', () => ({
  BulkLinkModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div>
        <span>BulkLinkModal aberto</span>
        <button type="button" onClick={onClose}>
          Fechar BulkLinkModal
        </button>
      </div>
    ) : null,
}));
vi.mock('../../conta/_components/PagarFaturaDialog', () => ({ PagarFaturaDialog: () => null }));
vi.mock('../../conta/_components/QuitarParcelaModal', () => ({
  QuitarParcelaModal: ({
    foreignExpenseId,
    onClose,
  }: {
    foreignExpenseId: string;
    onClose: () => void;
  }) => (
    <div>
      <span>QuitarParcelaModal aberto: {foreignExpenseId}</span>
      <button type="button" onClick={onClose}>
        Fechar QuitarParcelaModal
      </button>
    </div>
  ),
}));
vi.mock('../../conta/_components/ReceitaModal', () => ({ ReceitaModal: () => null }));

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('PendenciasQueueCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.patch).mockResolvedValue({});
    vi.mocked(api.post).mockResolvedValue({});
  });

  it('does not render when queue is empty', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) return { total: 0, grupos: [] };
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" projectType="PESSOAL" />);

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

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" projectType="PESSOAL" />);

    expect(await screen.findByText(/1 pendência financeira/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Resolver/i }));
    expect(await screen.findByText('Sem conta')).toBeInTheDocument();
    expect(screen.getByText('Compra sem conta')).toBeInTheDocument();
  });

  it('routes sem conta: foreign abre quitar; local abre vincular', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) {
        return {
          total: 2,
          grupos: [
            {
              tipo: 'SEM_CONTA',
              label: 'Sem conta',
              count: 2,
              valorTotal: 33000,
              itens: [
                {
                  id: 'i-foreign',
                  tipo: 'SEM_CONTA',
                  label: 'Quitar parcela',
                  descricao: 'Parcela sem conta',
                  valor: 21000,
                  data: '2026-07-01T00:00:00.000Z',
                  expenseId: 'e-foreign-row',
                  foreignExpenseId: 'e-foreign',
                  parcelaIndex: 3,
                },
                {
                  id: 'i-local',
                  tipo: 'SEM_CONTA',
                  label: 'Vincular origem',
                  descricao: 'Compra local sem conta',
                  valor: 12000,
                  data: '2026-07-02T00:00:00.000Z',
                  expenseId: 'e-local',
                },
              ],
            },
          ],
        };
      }
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      if (url.includes('/expenses/e-local')) return { id: 'e-local' };
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" projectType="PESSOAL" />);

    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Quitar parcela/i }));
    expect(await screen.findByText('QuitarParcelaModal aberto: e-foreign')).toBeInTheDocument();
    expect(
      vi.mocked(api.get).mock.calls.some(([url]) => String(url).includes('/expenses/e-foreign-row')),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Fechar QuitarParcelaModal/i }));
    expect(await screen.findByRole('heading', { name: /Precisa de você/i })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Vincular origem/i }));
    expect(
      vi.mocked(api.get).mock.calls.some(([url]) => String(url).includes('/expenses/e-local')),
    ).toBe(true);
    expect(await screen.findByText('BulkLinkModal aberto')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Fechar BulkLinkModal/i }));
    expect(await screen.findByRole('heading', { name: /Precisa de você/i })).toBeInTheDocument();
  });

  it('shows suggested category and lets user change before confirming', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) {
        return {
          total: 1,
          grupos: [
            {
              tipo: 'SEM_CATEGORIA',
              label: 'Sem categoria',
              count: 1,
              valorTotal: 12000,
              itens: [
                {
                  id: 'i-sem-cat',
                  tipo: 'SEM_CATEGORIA',
                  label: 'Confirmar categoria',
                  descricao: 'Padaria do João',
                  valor: 12000,
                  data: '2026-07-02T00:00:00.000Z',
                  expenseId: 'e-sem-cat',
                  suggestionTipoDespesa: 'ALIMENTACAO',
                },
              ],
            },
          ],
        };
      }
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      if (url.includes('/expenses/e-sem-cat')) {
        return {
          id: 'e-sem-cat',
          tipoDespesa: 'OUTROS',
          fornecedor: 'Padaria do João',
        };
      }
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" projectType="PESSOAL" />);

    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar categoria$/i }));
    expect(await screen.findByText(/Sugestão:/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'TRANSPORTE' } });
    fireEvent.click(screen.getByRole('button', { name: /^Confirmar categoria$/i }));

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/projects/p1/expenses/e-sem-cat', {
        tipoDespesa: 'TRANSPORTE',
      });
      expect(api.post).toHaveBeenCalledWith('/merchant-categories/confirm-rule', {
        merchant: 'Padaria do João',
        tipoDespesa: 'TRANSPORTE',
      });
    });
  });

  // Bug real: a categoria mudava e o usuário via "Não foi possível confirmar
  // categoria" porque a criação da regra (passo secundário) falhava depois.
  it('mantém a troca de categoria mesmo quando a regra de merchant falha', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) {
        return {
          total: 1,
          grupos: [
            {
              tipo: 'SEM_CATEGORIA',
              label: 'Sem categoria',
              count: 1,
              valorTotal: 65000,
              itens: [
                {
                  id: 'i-apto',
                  tipo: 'SEM_CATEGORIA',
                  label: 'Confirmar categoria',
                  descricao: 'Pagamento APTO',
                  valor: 65000,
                  data: '2026-08-10T00:00:00.000Z',
                  expenseId: 'e-apto',
                  suggestionTipoDespesa: 'MORADIA',
                },
              ],
            },
          ],
        };
      }
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      if (url.includes('/expenses/e-apto')) {
        return { id: 'e-apto', tipoDespesa: 'MORADIA', fornecedor: 'Pagamento APTO' };
      }
      return null;
    });
    vi.mocked(api.post).mockRejectedValue(new Error('Bad Request'));

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-08" projectType="PESSOAL" />);

    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Confirmar categoria$/i }));
    fireEvent.change(await screen.findByRole('combobox'), {
      target: { value: 'INVESTIMENTOS' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Confirmar categoria$/i }));

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/projects/p1/expenses/e-apto', {
        tipoDespesa: 'INVESTIMENTOS',
      });
      expect(toast.success).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('without suggestion still shows category selector list and confirms chosen type', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) {
        return {
          total: 1,
          grupos: [
            {
              tipo: 'SEM_CATEGORIA',
              label: 'Sem categoria',
              count: 1,
              valorTotal: 9000,
              itens: [
                {
                  id: 'i-sem-cat-2',
                  tipo: 'SEM_CATEGORIA',
                  label: 'Escolher categoria',
                  descricao: 'Farmácia Bairro',
                  valor: 9000,
                  data: '2026-07-10T00:00:00.000Z',
                  expenseId: 'e-sem-cat-2',
                },
              ],
            },
          ],
        };
      }
      if (url.includes('/monthly-overview/account-view')) return { cartoes: [], contas: [] };
      if (url.includes('/expenses/e-sem-cat-2')) {
        return {
          id: 'e-sem-cat-2',
          tipoDespesa: 'OUTROS',
          fornecedor: 'Farmácia Bairro',
        };
      }
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-07" projectType="PESSOAL" />);

    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Escolher categoria/i }));
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'SAUDE' } });
    fireEvent.click(screen.getByRole('button', { name: /^Confirmar categoria$/i }));

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/projects/p1/expenses/e-sem-cat-2', {
        tipoDespesa: 'SAUDE',
      });
      expect(api.post).toHaveBeenCalledWith('/merchant-categories/confirm-rule', {
        merchant: 'Farmácia Bairro',
        tipoDespesa: 'SAUDE',
      });
    });
  });

  // --- B1b (#448): capabilities da Visão Conta vetando a CTA da fila ---
  //
  // A fila (`/pendencias/financeiras`) não conhece capabilities de fatura; quem
  // conhece é `account-view`. Sem o veto, um cartão de último4 ambíguo mostraria
  // "Pagar fatura" cuja única resposta possível é 409.
  function faturaQueue() {
    return {
      total: 1,
      grupos: [
        {
          tipo: 'FATURA_NAO_PAGA',
          label: 'Fatura não paga',
          count: 1,
          valorTotal: 45000,
          itens: [
            {
              id: 'i-fatura',
              tipo: 'FATURA_NAO_PAGA',
              label: 'Pagar fatura',
              descricao: 'Fatura Nubank',
              valor: 45000,
              data: '2026-08-20T00:00:00.000Z',
              cardLast4: '4488',
            },
          ],
        },
      ],
    };
  }

  function cardSummary(over: Record<string, unknown> = {}) {
    return {
      cardId: 'card-1',
      nickname: 'Nubank',
      last4: '4488',
      faturaAtual: 45000,
      faturaPendente: 45000,
      faturaPaga: 0,
      residualDeclarado: 0,
      possuiIntervencaoManual: false,
      ajusteManualTotal: 0,
      dueMonth: '2026-08',
      vencimento: '2026-08-20',
      status: 'a pagar',
      limiteUsadoPct: null,
      limiteUsado: null,
      limiteTotal: null,
      ...over,
    };
  }

  it('final ambíguo (actions: []) troca o botão por aviso de duplicidade, sem POST', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) return faturaQueue();
      if (url.includes('/monthly-overview/account-view')) {
        return { cartoes: [cardSummary({ actions: [], cardId: null })], contas: [] };
      }
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-08" projectType="PESSOAL" />);
    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));

    expect(await screen.findByText(/Mais de um cartão com esse final/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pagar fatura$/ })).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sem pendente (fila velha, fatura já paga) NÃO acusa duplicidade — diz que a fatura já consta paga', async () => {
    // `actions` sem 'pay' tem DOIS motivos possíveis no servidor: final ambíguo
    // OU fatura sem saldo pendente. Publicar "mais de um cartão com esse final"
    // no segundo caso seria mentir para o usuário.
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) return faturaQueue();
      if (url.includes('/monthly-overview/account-view')) {
        return {
          cartoes: [
            cardSummary({
              actions: [],
              faturaPendente: 0,
              faturaPaga: 45000,
              status: 'paga',
            }),
          ],
          contas: [],
        };
      }
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-08" projectType="PESSOAL" />);
    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));

    const aviso = await screen.findByText(/já consta paga/i);
    expect(aviso).toBeInTheDocument();
    expect(screen.queryByText(/Mais de um cartão/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pagar fatura$/ })).not.toBeInTheDocument();
  });

  it('API antiga (sem `actions`) mantém o botão — veto só com informação positiva', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/pendencias/financeiras')) return faturaQueue();
      if (url.includes('/monthly-overview/account-view')) {
        return { cartoes: [cardSummary()], contas: [] };
      }
      return null;
    });

    renderWithQuery(<PendenciasQueueCard projectId="p1" monthKey="2026-08" projectType="PESSOAL" />);
    fireEvent.click(await screen.findByRole('button', { name: /Resolver/i }));

    expect(await screen.findByRole('button', { name: /^Pagar fatura$/ })).toBeInTheDocument();
    expect(screen.queryByText(/Mais de um cartão/i)).not.toBeInTheDocument();
  });
});
