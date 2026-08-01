import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ImportWithoutAccountModal from './ImportWithoutAccountModal';

const apiGetMock = vi.fn();
const apiUploadMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
    upload: (...args: unknown[]) => apiUploadMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function selectSingleFile(name = 'extrato.ofx') {
  const input = screen.getByLabelText('Arquivos');
  fireEvent.change(input, {
    target: {
      files: [new File(['conteudo'], name, { type: 'application/octet-stream' })],
    },
  });
}

describe('ImportWithoutAccountModal', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiUploadMock.mockReset();
    apiPostMock.mockReset();
  });

  it('após importar extrato para a Carteira, permite vincular imediatamente despesas e recebimentos à conta', async () => {
    const onCommitted = vi.fn();
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/projects/p1/bank-accounts') {
        return Promise.resolve([{ id: 'acc-1', nickname: 'Conta principal', institution: 'Itaú', last4: '4242' }]);
      }
      return Promise.resolve([]);
    });
    apiUploadMock
      .mockResolvedValueOnce({
        total: 1,
        totalAmountCents: 5000,
        duplicated: 0,
        preview: [
          {
            externalId: 'tx-1',
            date: '2026-08-01T00:00:00.000Z',
            description: 'Mercado',
            amountCents: 5000,
            type: 'expense',
            status: 'PAGO',
          },
        ],
      })
      .mockResolvedValueOnce({
        count: 2,
        expensesInserted: 1,
        receiptsInserted: 1,
        duplicated: 0,
        skipped: 0,
        failed: 0,
        expenseIds: ['exp-1'],
        receiptIds: ['rec-1'],
      });
    apiPostMock.mockResolvedValue({});

    wrap(
      <ImportWithoutAccountModal
        projectId="p1"
        fixedDocumentType="bank"
        onClose={vi.fn()}
        onCommitted={onCommitted}
      />,
    );

    selectSingleFile();
    fireEvent.click(screen.getByText('Conferir arquivos'));
    await waitFor(() => expect(screen.getByText(/Confirmar importação/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('Confirmar importação'));
    await waitFor(() => expect(screen.getByText(/Vincular agora a uma conta/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Conta principal •••• 4242/i }));
    fireEvent.click(screen.getByRole('button', { name: /Vincular agora a uma conta/i }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/projects/p1/expenses/exp-1/link-account', {
        accountId: 'acc-1',
      });
      expect(apiPostMock).toHaveBeenCalledWith('/projects/p1/receipts/rec-1/link-account', {
        accountId: 'acc-1',
      });
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('após importar fatura para a Carteira, permite vincular imediatamente as despesas ao cartão', async () => {
    const onCommitted = vi.fn();
    apiGetMock.mockImplementation((path: string) => {
      if (path === '/projects/p1/credit-cards') {
        return Promise.resolve([{ id: 'card-1', nickname: 'Visa', brand: 'Visa', last4: '1111' }]);
      }
      return Promise.resolve([]);
    });
    apiUploadMock
      .mockResolvedValueOnce({
        total: 1,
        totalAmountCents: 7000,
        duplicated: 0,
        preview: [
          {
            externalId: 'tx-card-1',
            date: '2026-08-01T00:00:00.000Z',
            description: 'Restaurante',
            amountCents: 7000,
            type: 'expense',
            status: 'PLANEJADO',
          },
        ],
      })
      .mockResolvedValueOnce({
        count: 1,
        expensesInserted: 1,
        receiptsInserted: 0,
        duplicated: 0,
        skipped: 0,
        failed: 0,
        expenseIds: ['exp-card-1'],
        receiptIds: [],
      });
    apiPostMock.mockResolvedValue({});

    wrap(
      <ImportWithoutAccountModal
        projectId="p1"
        fixedDocumentType="card"
        onClose={vi.fn()}
        onCommitted={onCommitted}
      />,
    );

    selectSingleFile('fatura.pdf');
    fireEvent.click(screen.getByText('Conferir arquivos'));
    await waitFor(() => expect(screen.getByText(/Confirmar importação/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('Confirmar importação'));
    await waitFor(() => expect(screen.getByText(/Vincular agora a um cartão/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Visa •••• 1111/i }));
    fireEvent.click(screen.getByRole('button', { name: /Vincular agora a um cartão/i }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/projects/p1/expenses/exp-card-1/link-card', {
        cardId: 'card-1',
      });
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });
});
