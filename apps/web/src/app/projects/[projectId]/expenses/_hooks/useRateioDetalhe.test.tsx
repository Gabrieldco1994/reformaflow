import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { useRateioDetalhe, type RateioDetalhe } from './useRateioDetalhe';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGet(path),
  },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const DETALHE: RateioDetalhe = {
  sourceExpenseId: 'src-1',
  rateado: true,
  totalSourceCents: 10000,
  rateadoCents: 10000,
  sobraCents: 0,
  removedTargetsCount: 0,
  items: [
    {
      targetExpenseId: 'tgt-1',
      titulo: 'Piso',
      fornecedor: null,
      projectId: 'p2',
      projectName: 'Reforma A',
      projectType: 'REFORMA',
      allocationCents: 10000,
      plannedValorTotalCents: 15000,
      status: 'PLANEJADO',
    },
  ],
};

describe('useRateioDetalhe', () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it('busca GET /projects/:projectId/expenses/:id/rateio e retorna o contrato', async () => {
    apiGet.mockResolvedValueOnce(DETALHE);
    const { result } = renderHook(() => useRateioDetalhe('p1', 'src-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiGet).toHaveBeenCalledWith('/projects/p1/expenses/src-1/rateio');
    expect(result.current.data).toEqual(DETALHE);
  });

  it('não dispara a query quando expenseId é ausente', () => {
    renderHook(() => useRateioDetalhe('p1', undefined), { wrapper });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('não dispara a query quando enabled=false', () => {
    renderHook(() => useRateioDetalhe('p1', 'src-1', { enabled: false }), { wrapper });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('expõe isError quando a busca falha', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useRateioDetalhe('p1', 'src-1'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
