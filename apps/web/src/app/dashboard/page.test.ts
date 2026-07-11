import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect }));

import Page from './page';

describe('/dashboard compatibility redirect', () => {
  beforeEach(() => redirect.mockClear());

  it.each([
    [undefined, '/financeiro'],
    [{}, '/financeiro'],
    [
      { period: '30d', project: ['p1', 'p2'], ignored: undefined },
      '/financeiro?period=30d&project=p1&project=p2',
    ],
    [
      { q: 'café & obra', tag: ['a/b', 'x+y'], empty: '' },
      '/financeiro?q=caf%C3%A9+%26+obra&tag=a%2Fb&tag=x%2By&empty=',
    ],
  ])('redirects search params %j to the canonical financeiro route', (searchParams, destination) => {
    Page({ searchParams } as never);
    expect(redirect).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith(destination);
  });
});
