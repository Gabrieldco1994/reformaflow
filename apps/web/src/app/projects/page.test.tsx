import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsPage from './page';

const { hasModule, pushMock, apiGetMock } = vi.hoisted(() => ({
  hasModule: vi.fn(),
  pushMock: vi.fn(),
  apiGetMock: vi.fn(),
}));

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
    get: apiGetMock,
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}));
vi.mock('@/components/notifications/NotificationsBell', () => ({ NotificationsBell: () => null }));
vi.mock('./_components/ProjectHubCard', () => ({
  ProjectHubCard: ({ project, onOpen }: { project: { name: string }; onOpen: () => void }) => (
    <button onClick={onOpen}>{project.name}</button>
  ),
}));
vi.mock('./_components/CreateProjectModal', () => ({ CreateProjectModal: () => null }));

describe('projects hub finance destination', () => {
  beforeEach(() => {
    hasModule.mockReset();
    pushMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue([
      { id: 'p1', name: 'Casa', type: 'REFORMA', createdAt: '2026-07-11T12:00:00-03:00' },
    ]);
  });

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

  it('opens project home route by project type instead of hardcoded dashboard', async () => {
    hasModule.mockReturnValue(false);
    apiGetMock.mockResolvedValue([
      { id: 'pessoal-1', name: 'Pessoal', type: 'PESSOAL', createdAt: '2026-07-11T12:00:00-03:00' },
      { id: 'casa-1', name: 'Casa', type: 'CASA', createdAt: '2026-07-11T12:00:00-03:00' },
    ]);

    const user = userEvent.setup();
    render(<ProjectsPage />);

    await user.click(await screen.findByRole('button', { name: 'Pessoal' }));
    await user.click(await screen.findByRole('button', { name: 'Casa' }));

    expect(pushMock).toHaveBeenNthCalledWith(1, '/projects/pessoal-1/monthly');
    expect(pushMock).toHaveBeenNthCalledWith(2, '/projects/casa-1/dashboard');
  });
});
