import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect }));

import Home from './page';

describe('/ root app-first redirect', () => {
  beforeEach(() => redirect.mockClear());

  it('redirects to /app', () => {
    Home();
    expect(redirect).toHaveBeenCalledWith('/app');
  });
});
