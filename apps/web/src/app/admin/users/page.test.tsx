import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { replaceMock, useRouterMock, useAuthMock, apiGetMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  const useRouterMock = vi.fn(() => ({ replace: replaceMock }));
  const useAuthMock = vi.fn();
  const apiGetMock = vi.fn();
  return { replaceMock, useRouterMock, useAuthMock, apiGetMock };
});

vi.mock('next/navigation', () => ({ useRouter: useRouterMock }));

vi.mock('@/contexts/auth-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/contexts/auth-context')>();
  return { ...actual, useAuth: useAuthMock };
});

vi.mock('@/lib/api', () => ({ api: { get: apiGetMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

import AdminUsersPage from './page';

describe('/admin/users analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthMock.mockReturnValue({
      user: { id: 'admin-1', tenantId: 'tenant-1' },
      isAdmin: true,
      loading: false,
    });
  });

  it('renders the project/expense creation columns and values', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/users')) {
        return Promise.resolve([
          {
            id: 'u1',
            username: 'ana',
            name: 'Ana',
            role: 'USER',
            tenantId: 'tenant-1',
            allowedModules: [],
            allowedProjects: [],
            allowedProjectTypes: [],
            createdByUserId: null,
            createdByName: null,
            lastLoginAt: null,
            lastActivityAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            tenantName: 'Tenant 1',
            projectsCreatedCount: 4,
            expensesCreatedCount: 37,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    render(<AdminUsersPage />);

    expect(await screen.findByText('Projetos criados')).toBeInTheDocument();
    expect(await screen.findByText('Despesas criadas')).toBeInTheDocument();
    expect(await screen.findByText('4')).toBeInTheDocument();
    expect(await screen.findByText('37')).toBeInTheDocument();
  });

  it('shows zeros for users with no creation history', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.startsWith('/users')) {
        return Promise.resolve([
          {
            id: 'u2',
            username: 'bruno',
            name: 'Bruno',
            role: 'USER',
            tenantId: 'tenant-1',
            allowedModules: [],
            allowedProjects: [],
            allowedProjectTypes: [],
            createdByUserId: null,
            createdByName: null,
            lastLoginAt: null,
            lastActivityAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            tenantName: 'Tenant 1',
            projectsCreatedCount: 0,
            expensesCreatedCount: 0,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    render(<AdminUsersPage />);

    const zeroCells = await screen.findAllByText('0');
    expect(zeroCells.length).toBeGreaterThanOrEqual(2);
  });
});
