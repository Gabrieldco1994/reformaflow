import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiResponseError } from '@/lib/api';
import { importRoot } from '../_lib/import-session-keys';

const get = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get: (...a: unknown[]) => get(...a) },
}));

import { useImportCatalog } from './useImportCatalog';

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient();
  get.mockReset();
});

describe('useImportCatalog', () => {
  it('names cards and projects from the authorized catalog under a per-user namespace', async () => {
    get.mockImplementation(async (path: string) =>
      path === '/tenant/credit-cards'
        ? [{ id: 'card-1', nickname: 'Nubank', last4: '1234', project: { id: 'p1', name: 'Pessoal' } }]
        : [{ id: 'p2', name: 'Reforma', type: 'REFORMA' }],
    );
    const { result } = renderHook(() => useImportCatalog('user-a', true), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.names.card('card-1')).toBe('Nubank');
    expect(result.current.names.project('p1')).toBe('Pessoal');
    expect(result.current.names.project('p2')).toBe('Reforma');
    const keys = client.getQueryCache().findAll({ queryKey: importRoot('user-a') });
    expect(keys.length).toBe(2);
  });

  it('falls back to generic names on 403 or an unexpected body, without failing the screen', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/tenant/credit-cards') throw new ApiResponseError('Forbidden', 403, { statusCode: 403 });
      return { not: 'a list' };
    });
    const { result } = renderHook(() => useImportCatalog('user-a', true), { wrapper });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.names.card('card-1')).toBe('Cartão');
    expect(result.current.names.project('p1')).toBe('Projeto');
  });

  it('does not fetch while disabled or without a user', () => {
    renderHook(() => useImportCatalog(null, true), { wrapper });
    renderHook(() => useImportCatalog('user-a', false), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });
});
