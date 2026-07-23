import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PriceHistoryChart } from './PriceHistoryChart';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
  },
}));

function renderChart() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PriceHistoryChart projectId="project-1" itemId="item-1" />
    </QueryClientProvider>,
  );
}

describe('PriceHistoryChart', () => {
  it('shows a friendly message when there are fewer than 2 points (no fabricated data)', async () => {
    const { api } = await import('@/lib/api');
    vi.mocked(api.get).mockResolvedValue([
      { id: 'p1', priceCents: 4500, store: 'Loja A', link: null, checkedAt: '2026-07-01T00:00:00Z' },
    ]);

    renderChart();

    await waitFor(() => {
      expect(
        screen.getByText(/histórico aparece após a 2ª checagem/i),
      ).toBeInTheDocument();
    });
  });

  it('renders the chart when there are 2+ points', async () => {
    const { api } = await import('@/lib/api');
    vi.mocked(api.get).mockResolvedValue([
      { id: 'p1', priceCents: 4800, store: 'Loja A', link: null, checkedAt: '2026-07-01T00:00:00Z' },
      { id: 'p2', priceCents: 4500, store: 'Loja B', link: null, checkedAt: '2026-07-02T00:00:00Z' },
    ]);

    renderChart();

    await waitFor(() => {
      expect(screen.getByText(/histórico de preço \(2 checagens\)/i)).toBeInTheDocument();
    });
  });
});
