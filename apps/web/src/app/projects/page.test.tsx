import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsPage from './page';

const hasModule = vi.fn();

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    hasProjectType: () => true,
    hasProjectAccess: () => true,
    canCreateProjectType: () => false,
    hasModule,
    isAdmin: false,
    user: { id: 'u1' },
    refresh: vi.fn(),
  }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Casa', type: 'REFORMA', createdAt: '2026-07-11T12:00:00-03:00' },
    ]),
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));
vi.mock('@/components/notifications/NotificationsBell', () => ({ NotificationsBell: () => null }));
vi.mock('./_components/ProjectHubCard', () => ({ ProjectHubCard: () => <div>Casa</div> }));
vi.mock('./_components/CreateProjectModal', () => ({ CreateProjectModal: () => null }));

describe('projects hub finance destination', () => {
  beforeEach(() => hasModule.mockReset());

  it('shows only the canonical Financeiro link when authorized', async () => {
    hasModule.mockReturnValue(true);
    render(<ProjectsPage />);
    const link = await screen.findByRole('link', { name: /Financeiro/ });
    expect(link).toHaveAttribute('href', '/financeiro');
    expect(document.querySelector('a[href="/dashboard"]')).not.toBeInTheDocument();
  });

  it('does not expose the finance destination when unauthorized', async () => {
    hasModule.mockReturnValue(false);
    render(<ProjectsPage />);
    await waitFor(() => expect(screen.getAllByText('Casa').length).toBeGreaterThan(0));
    expect(screen.queryByRole('link', { name: /Financeiro/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/dashboard"]')).not.toBeInTheDocument();
  });
});
