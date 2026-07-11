import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBulkLinkExecution } from './useBulkLinkExecution';

const postMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => postMock(...args) },
}));

function makeRows() {
  return [
    { sourceId: 's1', projectId: 'p1', payload: { newTargets: [], existing: [] } },
    { sourceId: 's2', projectId: 'p1', payload: { newTargets: [], existing: [] } },
    { sourceId: 's3', projectId: 'p1', payload: { newTargets: [], existing: [] } },
  ];
}

describe('useBulkLinkExecution', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('3 linhas, 2ª falha → 1ª e 3ª success, 2ª error, sem rollback', async () => {
    postMock.mockImplementation((url: string) => {
      if (url.includes('s2')) return Promise.reject(new Error('fail'));
      return Promise.resolve({ id: 'ok' });
    });
    const { result } = renderHook(() => useBulkLinkExecution(makeRows()));
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.rows.map((r) => r.status)).toEqual(['success', 'error', 'success']);
    // sem rollback: nenhuma chamada de delete/cancel foi feita
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  it('chamadas sequenciais — 2ª só inicia após 1ª terminar', async () => {
    const order: string[] = [];
    postMock.mockImplementation((url: string) => {
      const id = url.includes('s1') ? 's1' : url.includes('s2') ? 's2' : 's3';
      order.push(`start-${id}`);
      return new Promise((resolve) =>
        setTimeout(() => {
          order.push(`end-${id}`);
          resolve({ id: 'ok' });
        }, 10),
      );
    });
    const { result } = renderHook(() => useBulkLinkExecution(makeRows()));
    await act(async () => {
      await result.current.execute();
    });
    expect(order).toEqual([
      'start-s1',
      'end-s1',
      'start-s2',
      'end-s2',
      'start-s3',
      'end-s3',
    ]);
  });

  it('linha já success não é reenviada numa 2ª chamada de execute()', async () => {
    postMock.mockImplementation((url: string) => {
      if (url.includes('s2')) return Promise.reject(new Error('fail'));
      return Promise.resolve({ id: 'ok' });
    });
    const { result } = renderHook(() => useBulkLinkExecution(makeRows()));
    await act(async () => {
      await result.current.execute();
    });
    expect(postMock).toHaveBeenCalledTimes(3);
    postMock.mockClear();
    postMock.mockImplementation(() => Promise.resolve({ id: 'ok' }));
    await act(async () => {
      await result.current.execute();
    });
    // só a linha 's2' (error) foi reenviada — s1 e s3 (success) não
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(result.current.rows.map((r) => r.status)).toEqual(['success', 'success', 'success']);
  });
});
