import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryRulesSheet } from './CategoryRulesSheet';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CategoryRulesSheet />
    </QueryClientProvider>,
  );
}

describe('CategoryRulesSheet', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
  });

  it('lista regras manuais e exclui uma regra', async () => {
    apiGet.mockResolvedValue([]);
    apiGet.mockResolvedValueOnce([
      {
        merchantKey: 'mercado abc',
        merchantSample: 'Mercado ABC',
        category: 'alimentação',
        source: 'MANUAL',
      },
    ]);
    apiPost.mockResolvedValueOnce({ deleted: true });

    renderWithClient();

    fireEvent.click(screen.getByRole('button', { name: /regras/i }));

    expect(await screen.findByText('Mercado ABC')).toBeInTheDocument();
    expect(screen.getByText(/alimentação · origem manual/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /excluir/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/merchant-categories/remove-rule', {
        merchant: 'mercado abc',
      }),
    );
  });

  it('mostra vazio quando não há regra manual', async () => {
    apiGet.mockResolvedValue([]);

    renderWithClient();
    fireEvent.click(screen.getByRole('button', { name: /regras/i }));

    expect(
      await screen.findByText(/Nenhuma regra manual encontrada/i),
    ).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
