import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { useRateioDetalhe, useRateioTargetsBySource, type RateioDetalhe } from './useRateioDetalhe';

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

  // #448 W1 — contrato mixed-version: B1b REMOVE `hiddenTargetsCount`,
  // `hiddenAllocationCents` e `removedTargetsCount` do payload. O fixture
  // canônico acima já é o payload novo (sem eles); este caso prova que o
  // payload da API ANTIGA continua atravessando o hook sem perda, porque o
  // bundle novo pode estar falando com um servidor velho.
  it('payload da API pré-B1b (com metadata de ocultos) atravessa sem perda', async () => {
    const legado = {
      ...DETALHE,
      removedTargetsCount: 1,
      hiddenTargetsCount: 2,
      hiddenAllocationCents: 4000,
    };
    apiGet.mockResolvedValueOnce(legado);
    const { result } = renderHook(() => useRateioDetalhe('p1', 'src-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(legado);
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

// Issue #428 follow-up: a aba Despesas (PESSOAL) precisa de TODOS os alvos de
// rateio de VÁRIAS fontes candidatas — não só a de `linkedExpenseId`.
describe('useRateioTargetsBySource', () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  const DETALHE_3_ALVOS: RateioDetalhe = {
    sourceExpenseId: 'src-telha-norte',
    rateado: true,
    totalSourceCents: 100_000,
    rateadoCents: 100_000,
    sobraCents: 0,
    items: [
      { targetExpenseId: 'tgt-telha', titulo: 'Telhas', fornecedor: null, projectId: 'p2', projectName: 'Reforma', projectType: 'REFORMA', allocationCents: 40_000, plannedValorTotalCents: null, status: 'PAGO' },
      { targetExpenseId: 'tgt-piso', titulo: 'Piso', fornecedor: null, projectId: 'p2', projectName: 'Reforma', projectType: 'REFORMA', allocationCents: 35_000, plannedValorTotalCents: null, status: 'PAGO' },
      { targetExpenseId: 'tgt-argamassa', titulo: 'Argamassa', fornecedor: null, projectId: 'p2', projectName: 'Reforma', projectType: 'REFORMA', allocationCents: 25_000, plannedValorTotalCents: null, status: 'PAGO' },
    ],
  };

  const DETALHE_NAO_RATEADO: RateioDetalhe = {
    sourceExpenseId: 'src-quitacao-simples',
    rateado: false,
    totalSourceCents: 5_000,
    rateadoCents: 0,
    sobraCents: 0,
    items: [],
  };

  it('busca o rateio de CADA fonte candidata e retorna o mapa com TODOS os alvos (não só o 1º)', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.includes('src-telha-norte')) return Promise.resolve(DETALHE_3_ALVOS);
      return Promise.resolve(DETALHE_NAO_RATEADO);
    });

    const { result } = renderHook(
      () => useRateioTargetsBySource('p1', ['src-telha-norte', 'src-quitacao-simples']),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(apiGet).toHaveBeenCalledWith('/projects/p1/expenses/src-telha-norte/rateio');
    expect(apiGet).toHaveBeenCalledWith('/projects/p1/expenses/src-quitacao-simples/rateio');
    expect(Array.from(result.current.rateioTargetsBySource.get('src-telha-norte') ?? [])).toEqual([
      'tgt-telha',
      'tgt-piso',
      'tgt-argamassa',
    ]);
    // Fonte sem rateio ativo NÃO entra no mapa (dedup legado cuida dela).
    expect(result.current.rateioTargetsBySource.has('src-quitacao-simples')).toBe(false);
  });

  it('lista vazia de candidatas: não dispara nenhuma busca e retorna mapa vazio', () => {
    const { result } = renderHook(() => useRateioTargetsBySource('p1', []), { wrapper });
    expect(apiGet).not.toHaveBeenCalled();
    expect(result.current.rateioTargetsBySource.size).toBe(0);
  });

  it('enabled=false: não dispara nenhuma busca', () => {
    renderHook(() => useRateioTargetsBySource('p1', ['src-1'], { enabled: false }), { wrapper });
    expect(apiGet).not.toHaveBeenCalled();
  });
});
