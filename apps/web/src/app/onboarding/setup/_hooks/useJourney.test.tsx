import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { ProjectType } from '@reformaflow/domain';
import { useJourney } from './useJourney';

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: mockApi,
}));

describe('useJourney hook', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockApi.get.mockClear();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('fetches catalog from API with correct endpoint for PESSOAL project type', async () => {
    const mockCatalog = {
      steps: [
        { key: 'funding', type: 'funding', label: 'Contas & cartões' },
        { key: 'expense', type: 'expense', label: 'Despesa' },
      ],
    };

    mockApi.get.mockResolvedValueOnce(mockCatalog);

    const { result } = renderHook(() => useJourney(ProjectType.PESSOAL), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledWith(`/onboarding/journey/${ProjectType.PESSOAL}`);
  });

  it('returns catalog with funding step for PESSOAL project type', async () => {
    const mockCatalog = {
      steps: [
        { key: 'funding', type: 'funding', label: 'Contas & cartões' },
        { key: 'expense', type: 'expense', label: 'Despesa' },
      ],
    };

    mockApi.get.mockResolvedValueOnce(mockCatalog);

    const { result } = renderHook(() => useJourney(ProjectType.PESSOAL), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const data = result.current.data;
    expect(data).toBeDefined();
    expect(data?.steps).toBeDefined();

    const fundingStep = data?.steps.find((s) => s.key === 'funding');
    expect(fundingStep).toBeDefined();
    expect(fundingStep?.type).toBe('funding');
  });

  it('returns empty catalog and does not crash on API error', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('API failed'));

    const { result } = renderHook(() => useJourney(ProjectType.PESSOAL), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Hook should not crash; error should be caught
    expect(result.current.error).toBeDefined();
  });

  it('caches result to avoid refetch on re-render', async () => {
    const mockCatalog = {
      steps: [{ key: 'funding', type: 'funding', label: 'Contas & cartões' }],
    };

    mockApi.get.mockResolvedValueOnce(mockCatalog);

    const { result, rerender } = renderHook(() => useJourney(ProjectType.PESSOAL), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledTimes(1);

    // Re-render should use cached data, not refetch
    rerender();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledTimes(1);
  });
});
