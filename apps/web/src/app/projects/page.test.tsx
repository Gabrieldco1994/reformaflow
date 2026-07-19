import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsPage from './page';

const { hasModule, pushMock, apiGetMock, apiPostMock, refreshMock, canCreateProjectTypeMock } = vi.hoisted(() => ({
  hasModule: vi.fn(),
  pushMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  refreshMock: vi.fn(),
  canCreateProjectTypeMock: vi.fn(),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({
    hasProjectType: () => true,
    hasProjectAccess: () => true,
    canCreateProjectType: canCreateProjectTypeMock,
    hasModule,
    isAdmin: false,
    user: { id: 'u1' },
    refresh: refreshMock,
  }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
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
vi.mock('./_components/CreateProjectModal', () => ({
  CreateProjectModal: ({
    open,
    newProject,
    setNewProject,
    onCreate,
    creating,
  }: {
    open: boolean;
    newProject: { name: string; type: string; description: string };
    setNewProject: (updater: (prev: { name: string; type: string; description: string }) => { name: string; type: string; description: string }) => void;
    onCreate: () => void;
    creating: boolean;
  }) => {
    if (!open) return null;
    return (
      <div>
        <input
          aria-label="Nome do projeto"
          value={newProject.name}
          onChange={(e) => setNewProject((prev) => ({ ...prev, name: e.target.value }))}
        />
        <button onClick={onCreate} disabled={creating}>
          Criar
        </button>
      </div>
    );
  },
}));

describe('projects hub finance destination', () => {
  beforeEach(() => {
    hasModule.mockReset();
    pushMock.mockReset();
    apiGetMock.mockReset();
    canCreateProjectTypeMock.mockReset();
    canCreateProjectTypeMock.mockReturnValue(false);
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

describe('redirects into the onboarding wizard (not straight to /apoio) after creating a project of any type', () => {
  beforeEach(() => {
    hasModule.mockReset();
    hasModule.mockReturnValue(false);
    pushMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue([]);
    apiPostMock.mockReset();
    refreshMock.mockReset();
    refreshMock.mockResolvedValue(undefined);
    canCreateProjectTypeMock.mockReset();
    canCreateProjectTypeMock.mockReturnValue(true);
  });

  it('routes to /onboarding/setup with the new project id and type for a CARRO project', async () => {
    apiPostMock.mockResolvedValue({ id: 'proj-42', name: 'Meu Carro', type: 'CARRO', createdAt: '2026-07-11T12:00:00-03:00' });
    const user = userEvent.setup();
    render(<ProjectsPage />);

    await user.click(await screen.findByRole('button', { name: 'Novo Projeto' }));
    await user.type(screen.getByLabelText('Nome do projeto'), 'Meu Carro');
    await user.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/onboarding/setup?projectId=proj-42&type=CARRO'),
    );
  });

  it('routes to /onboarding/setup for a PLANTAS project too', async () => {
    apiPostMock.mockResolvedValue({ id: 'proj-99', name: 'Minhas Plantas', type: 'PLANTAS', createdAt: '2026-07-11T12:00:00-03:00' });
    const user = userEvent.setup();
    render(<ProjectsPage />);

    await user.click(await screen.findByRole('button', { name: 'Novo Projeto' }));
    await user.type(screen.getByLabelText('Nome do projeto'), 'Minhas Plantas');
    await user.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith('/onboarding/setup?projectId=proj-99&type=PLANTAS'),
    );
  });

  it('still calls refresh() before redirecting', async () => {
    apiPostMock.mockResolvedValue({ id: 'proj-7', name: 'Casa Nova', type: 'CASA', createdAt: '2026-07-11T12:00:00-03:00' });
    const user = userEvent.setup();
    render(<ProjectsPage />);

    await user.click(await screen.findByRole('button', { name: 'Novo Projeto' }));
    await user.type(screen.getByLabelText('Nome do projeto'), 'Casa Nova');
    await user.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();
    const refreshOrder = refreshMock.mock.invocationCallOrder[0];
    const pushOrder = pushMock.mock.invocationCallOrder[0];
    expect(refreshOrder).toBeLessThan(pushOrder);
  });
});
