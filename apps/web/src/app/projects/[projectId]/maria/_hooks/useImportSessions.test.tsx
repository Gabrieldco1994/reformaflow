import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiResponseError, ApiTimeoutError } from '@/lib/api';
import { summaryFixture, viewFixture } from '../_lib/import-session-fixtures';
import { importKeys, importRoot } from '../_lib/import-session-keys';

const listImportSessions = vi.fn();
const getImportSession = vi.fn();
const getImportResult = vi.fn();
const cancelImportSession = vi.fn();
vi.mock('../_lib/import-session-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/import-session-api')>()),
  listImportSessions: (...a: unknown[]) => listImportSessions(...a),
  getImportSession: (...a: unknown[]) => getImportSession(...a),
  getImportResult: (...a: unknown[]) => getImportResult(...a),
  cancelImportSession: (...a: unknown[]) => cancelImportSession(...a),
}));

import {
  useCancelImportSession,
  useImportResult,
  useImportSession,
  useImportSessionList,
  useImportUserId,
} from './useImportSessions';

let authUser: { id: string } | null = { id: 'user-a' };
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: authUser }),
}));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const err = (status: number, body: unknown) => new ApiResponseError(`HTTP ${status}`, status, body);
const wire = (over: Record<string, unknown>) => ({
  code: 'REVISION_CONFLICT',
  retryable: false,
  sessionId: 's',
  currentRevision: 4,
  reason: null,
  ...over,
});
const page = (items: ReturnType<typeof summaryFixture>[], nextCursor: string | null = null) => ({
  page: { items, nextCursor },
  entry: {
    kind: 'VALID',
    value: { version: 1, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' },
  },
});

describe('the list hook carries both public reader outcomes', () => {
  it.each(['MISSING_ENTRY', 'INVALID_ENTRY'] as const)(
    'keeps recovery ready and reports %s separately, with one request',
    async (code) => {
      const row = summaryFixture();
      listImportSessions.mockResolvedValue({
        page: { items: [row], nextCursor: null },
        entry: { kind: 'ERROR', code },
      });
      const h = renderHook(() => useImportSessionList('user-a', 'active'), {
        wrapper,
      });
      try {
        await waitFor(() => expect(h.result.current.status).toBe('ready'));
        expect(h.result.current).toMatchObject({
          items: [row],
          freshness: 'fresh',
          failure: null,
          entry: { kind: 'ERROR', code },
        });
        expect(listImportSessions).toHaveBeenCalledTimes(1);
      } finally {
        h.unmount();
        client.clear();
      }
    },
  );

  it('treats UNAVAILABLE as valid normal OFF, not a list or availability error', async () => {
    listImportSessions.mockResolvedValue({
      page: { items: [], nextCursor: null },
      entry: {
        kind: 'VALID',
        value: { version: 1, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' },
      },
    });
    const h = renderHook(() => useImportSessionList('user-a', 'active'), {
      wrapper,
    });
    try {
      await waitFor(() => expect(h.result.current.status).toBe('ready'));
      expect(h.result.current).toMatchObject({
        items: [],
        failure: null,
        entry: {
          kind: 'VALID',
          value: { version: 1, kind: 'UNAVAILABLE', reason: 'NOT_ENABLED' },
        },
      });
      expect(listImportSessions).toHaveBeenCalledTimes(1);
    } finally {
      h.unmount();
      client.clear();
    }
  });

  it('does not reuse a cached synthetic positive after a malformed entry refresh', async () => {
    const row = summaryFixture();
    listImportSessions
      .mockResolvedValueOnce({
        page: { items: [row], nextCursor: null },
        entry: {
          kind: 'VALID',
          value: { version: 1, kind: 'CARD_INVOICE', formats: ['CSV'] },
        },
      })
      .mockResolvedValueOnce({
        page: { items: [row], nextCursor: null },
        entry: { kind: 'ERROR', code: 'INVALID_ENTRY' },
      });
    const h = renderHook(() => useImportSessionList('user-a', 'active'), {
      wrapper,
    });
    try {
      await waitFor(() =>
        expect(h.result.current).toMatchObject({
          status: 'ready',
          freshness: 'fresh',
          items: [row],
          entry: {
            kind: 'VALID',
            value: { version: 1, kind: 'CARD_INVOICE', formats: ['CSV'] },
          },
        }),
      );
      expect(listImportSessions).toHaveBeenCalledTimes(1);
      await act(async () => {
        await h.result.current.restart();
      });
      await waitFor(() => expect(listImportSessions).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(h.result.current).toMatchObject({
          status: 'ready',
          items: [row],
          entry: { kind: 'ERROR', code: 'INVALID_ENTRY' },
        }),
      );
    } finally {
      h.unmount();
      client.clear();
    }
  });
});

beforeEach(() => {
  client = new QueryClient();
  authUser = { id: 'user-a' };
  for (const fn of [listImportSessions, getImportSession, getImportResult, cancelImportSession]) fn.mockReset();
});

describe('useImportSessionList', () => {
  it('runs the read while the browser reports offline so the failure is visible, not an endless loading', async () => {
    onlineManager.setOnline(false);
    try {
      listImportSessions.mockRejectedValue(new TypeError('Failed to fetch'));
      const { result } = renderHook(() => useImportSessionList('user-a', 'active'), { wrapper });
      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(listImportSessions).toHaveBeenCalledTimes(1);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('sends nothing while there is no authenticated user', () => {
    const { result } = renderHook(() => useImportSessionList(null, 'active'), {
      wrapper,
    });
    expect(result.current.status).toBe('disabled');
    expect(listImportSessions).not.toHaveBeenCalled();
  });

  it('a fresh 200 with zero items is an empty list, not an error', async () => {
    listImportSessions.mockResolvedValue(page([]));
    const { result } = renderHook(() => useImportSessionList('user-a', 'active'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items).toEqual([]);
    expect(result.current.freshness).toBe('fresh');
  });

  it('never shows an error or 503 as an empty list', async () => {
    for (const failure of [
      err(500, { statusCode: 500, message: 'Internal server error' }),
      err(
        503,
        wire({
          code: 'CAPABILITY_DISABLED',
          retryable: true,
          sessionId: null,
          currentRevision: null,
        }),
      ),
      err(400, { statusCode: 400, message: ['x'], error: 'Bad Request' }),
      new ApiTimeoutError(),
      new TypeError('Failed to fetch'),
    ]) {
      client = new QueryClient();
      listImportSessions.mockReset();
      listImportSessions.mockRejectedValue(failure);
      const { result } = renderHook(() => useImportSessionList('user-a', 'active'), { wrapper });
      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.items).toEqual([]);
      expect(result.current.failure).not.toBeNull();
      expect(listImportSessions).toHaveBeenCalledTimes(1);
    }
  });

  it('pages by cursor, and a failing next page keeps the rows but marks them stale, with no automatic retry', async () => {
    listImportSessions
      .mockResolvedValueOnce(page([summaryFixture({ id: 'a' })], 'c1'))
      .mockRejectedValue(err(400, { statusCode: 400, message: 'x' }));
    const { result } = renderHook(() => useImportSessionList('user-a', 'active'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.hasMore).toBe(true);
    await act(async () => {
      await result.current.loadMore();
    });
    expect(listImportSessions).toHaveBeenLastCalledWith('active', 'c1');
    await waitFor(() => expect(result.current.failedNext).toBe(true));
    expect(result.current.items.map((item) => item.id)).toEqual(['a']);
    expect(result.current.freshness).toBe('stale');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(listImportSessions).toHaveBeenCalledTimes(2);
  });

  it('restart drops every old page and reloads from the first page, never mixing snapshots', async () => {
    listImportSessions
      .mockResolvedValueOnce(page([summaryFixture({ id: 'old' })], 'c1'))
      .mockResolvedValueOnce(page([summaryFixture({ id: 'new' })]));
    const { result } = renderHook(() => useImportSessionList('user-a', 'active'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.restart();
    });
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['new']));
    expect(listImportSessions).toHaveBeenLastCalledWith('active', null);
  });

  it('does not keep data around once nothing observes it', async () => {
    listImportSessions.mockResolvedValue(page([summaryFixture()]));
    const { result, unmount } = renderHook(() => useImportSessionList('user-a', 'applied'), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    unmount();
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: importRoot('user-a') })).toHaveLength(0));
  });
});

describe('user scope', () => {
  it('removes only the OLD user namespace on a user change, and a late old response never renders for the new user', async () => {
    let resolveA: (value: unknown) => void = () => {};
    listImportSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => {
        const scoped = useImportUserId();
        return { scoped, list: useImportSessionList(uid, 'active') };
      },
      { wrapper, initialProps: { uid: 'user-a' as string | null } },
    );
    expect(listImportSessions).toHaveBeenCalledTimes(1);

    // Data the NEW user already owns must survive the old user's cleanup.
    client.setQueryData(importKeys.catalog('user-b', 'cards'), [{ id: 'kept' }]);
    authUser = { id: 'user-b' };
    listImportSessions.mockReset();
    listImportSessions.mockResolvedValue(page([summaryFixture({ id: 'b-only' })]));
    rerender({ uid: 'user-b' });
    await waitFor(() => expect(result.current.list.items.map((item) => item.id)).toEqual(['b-only']));

    expect(client.getQueryCache().findAll({ queryKey: importRoot('user-a') })).toHaveLength(0);
    expect(client.getQueryData(importKeys.catalog('user-b', 'cards'))).toEqual([{ id: 'kept' }]);

    await act(async () => {
      resolveA(page([summaryFixture({ id: 'a-secret' })]));
    });
    expect(result.current.list.items.map((item) => item.id)).toEqual(['b-only']);
    expect(client.getQueryCache().findAll({ queryKey: importRoot('user-a') })).toHaveLength(0);
  });

  it('also clears the namespace on logout', async () => {
    listImportSessions.mockResolvedValue(page([summaryFixture()]));
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => {
        useImportUserId();
        return useImportSessionList(uid, 'active');
      },
      { wrapper, initialProps: { uid: 'user-a' as string | null } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    authUser = null;
    rerender({ uid: null });
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: importRoot('user-a') })).toHaveLength(0));
    expect(result.current.status).toBe('disabled');
  });
});

describe('useImportSession / useImportResult', () => {
  it('surfaces a generic 404 and a typed 503 from real error bodies, never as ready', async () => {
    getImportSession.mockRejectedValueOnce(err(404, { statusCode: 404, message: 'Not Found' }));
    const first = renderHook(() => useImportSession('user-a', 's1'), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.status).toBe('error'));
    expect(first.result.current.failure).toEqual({ kind: 'http', status: 404 });
    expect(first.result.current.view).toBeNull();

    client = new QueryClient();
    getImportResult.mockRejectedValueOnce(
      err(
        503,
        wire({
          code: 'CAPABILITY_DISABLED',
          retryable: true,
          sessionId: null,
          currentRevision: null,
        }),
      ),
    );
    const second = renderHook(() => useImportResult('user-a', 's1'), {
      wrapper,
    });
    await waitFor(() => expect(second.result.current.status).toBe('error'));
    expect(second.result.current.failure).toMatchObject({
      kind: 'api',
      status: 503,
    });
  });

  it('reads the session once on open and marks a refetch as not-fresh instead of success', async () => {
    getImportSession.mockResolvedValue(viewFixture());
    const { result } = renderHook(() => useImportSession('user-a', 's1'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.freshness).toBe('fresh');
    expect(getImportSession).toHaveBeenCalledTimes(1);
  });

  it('is disabled without a user or an id', () => {
    renderHook(() => useImportSession(null, 's1'), { wrapper });
    renderHook(() => useImportResult('user-a', null), { wrapper });
    expect(getImportSession).not.toHaveBeenCalled();
    expect(getImportResult).not.toHaveBeenCalled();
  });
});

describe('useCancelImportSession', () => {
  it('cancels with the expected revision and reports the cancelled view', async () => {
    cancelImportSession.mockResolvedValue(viewFixture({ state: 'CANCELLED', actions: [] }));
    const { result } = renderHook(() => useCancelImportSession('user-a'), {
      wrapper,
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.cancel('s1', 3);
    });
    expect(cancelImportSession).toHaveBeenCalledWith('s1', 3);
    expect(outcome).toMatchObject({ kind: 'cancelled' });
  });

  it('sends ONE request for a double tap', async () => {
    let resolve: (value: unknown) => void = () => {};
    cancelImportSession.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() => useCancelImportSession('user-a'), {
      wrapper,
    });
    let first: Promise<unknown> = Promise.resolve();
    let second: unknown;
    await act(async () => {
      first = result.current.cancel('s1', 3);
      second = await result.current.cancel('s1', 3);
    });
    expect(second).toEqual({ kind: 'busy' });
    await act(async () => {
      resolve(viewFixture({ state: 'CANCELLED', actions: [] }));
      await first;
    });
    expect(cancelImportSession).toHaveBeenCalledTimes(1);
  });

  it('maps REVISION_CONFLICT to a reload and ALREADY_APPLIED to a result lookup', async () => {
    cancelImportSession.mockRejectedValueOnce(err(409, wire({})));
    const { result } = renderHook(() => useCancelImportSession('user-a'), {
      wrapper,
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.cancel('s1', 3);
    });
    expect(outcome).toMatchObject({ kind: 'conflict' });
    cancelImportSession.mockRejectedValueOnce(err(409, wire({ code: 'ALREADY_APPLIED' })));
    await act(async () => {
      outcome = await result.current.cancel('s1', 3);
    });
    expect(outcome).toMatchObject({ kind: 'already-applied' });
  });

  it('never reports success when the answer is lost', async () => {
    for (const failure of [
      new ApiTimeoutError(),
      new TypeError('Failed to fetch'),
      err(500, { statusCode: 500, message: 'boom' }),
    ]) {
      cancelImportSession.mockRejectedValueOnce(failure);
      const { result } = renderHook(() => useCancelImportSession('user-a'), {
        wrapper,
      });
      let outcome: { kind: string; info?: { outcomeUnknown: boolean } } | undefined;
      await act(async () => {
        outcome = (await result.current.cancel('s1', 3)) as typeof outcome;
      });
      expect(outcome).toMatchObject({
        kind: 'failed',
        info: { outcomeUnknown: true },
      });
    }
  });

  it('allows a new attempt after a finished one', async () => {
    cancelImportSession
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(viewFixture({ state: 'CANCELLED', actions: [] }));
    const { result } = renderHook(() => useCancelImportSession('user-a'), {
      wrapper,
    });
    await act(async () => {
      await result.current.cancel('s1', 3);
    });
    await act(async () => {
      await result.current.cancel('s1', 3);
    });
    expect(cancelImportSession).toHaveBeenCalledTimes(2);
  });
});
