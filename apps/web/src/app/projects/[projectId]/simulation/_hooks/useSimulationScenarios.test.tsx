import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSimulationScenarios } from './useSimulationScenarios';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useSimulationScenarios — regressão do bug de troca de cenário', () => {
  it('flushes the pending debounced save under the OLD scenarioId before switching', async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(
      () => useSimulationScenarios({ projectId: 'p1', api: { get, put } as any }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.scheduleSave('scenario-A');
    });
    await act(async () => {
      await result.current.switchScenario('scenario-B');
    });

    expect(put).toHaveBeenCalledWith(expect.stringContaining('scenario-A/values'), expect.anything());
    expect(put).not.toHaveBeenCalledWith(expect.stringContaining('scenario-B/values'), expect.anything());
  });

  it('does not flush anything when switching scenarios with no pending save', async () => {
    const put = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(
      () => useSimulationScenarios({ projectId: 'p1', api: { get, put } as any }),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await result.current.switchScenario('scenario-B');
    });

    expect(put).not.toHaveBeenCalled();
  });
});
