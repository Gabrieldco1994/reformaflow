import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OnboardingSetupPage from './page';

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiPut: vi.fn(),
  apiUpload: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1' }, refresh: mocks.refresh }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    post: mocks.apiPost,
    patch: mocks.apiPatch,
    put: mocks.apiPut,
    upload: mocks.apiUpload,
    get: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.searchParams,
}));

/** Per-type sequence of skip-button name regexes to click through every anchor step. */
const SKIP_SEQUENCES: Record<string, RegExp[]> = {
  PESSOAL: [/pular por agora/i, /pular mesmo assim/i, /pular — cadastro depois/i, /pular por agora/i, /pular por agora/i],
  REFORMA: [/pular por agora/i],
  COMPRA: [/pular por agora/i],
  CASA: [/cancelar/i],
  CARRO: [/pular por agora/i],
  PLANTAS: [/pular por agora/i],
};

async function skipEverything(user: ReturnType<typeof userEvent.setup>, type: string) {
  for (const regex of SKIP_SEQUENCES[type]) {
    const el = await screen.findByText(regex);
    await user.click(el);
  }
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OnboardingSetupPage />
    </QueryClientProvider>,
  );
}

describe('OnboardingSetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.apiPost.mockImplementation((path: string) => {
      if (path === '/projects') return Promise.resolve({ id: 'proj-1', type: mocks.searchParams.get('type') });
      return Promise.resolve({});
    });
    mocks.apiPatch.mockResolvedValue({});
    mocks.apiPut.mockResolvedValue({});
    mocks.apiUpload.mockResolvedValue({});
  });

  it.each([
    ['PESSOAL', 4],
    ['REFORMA', 1],
    ['COMPRA', 1],
    ['CASA', 1],
    ['CARRO', 1],
    ['PLANTAS', 1],
  ])('auto-creates the %s project, skips every anchor step, and always lands on /projects/:id/apoio (never /monthly)', async (type) => {
    mocks.searchParams = new URLSearchParams({ type });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /criar e continuar/i }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/projects', expect.objectContaining({ type })));

    await skipEverything(user, type);

    await screen.findByText(/tudo pronto/i);
    vi.advanceTimersByTime(1500);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/projects/proj-1/apoio'));
    expect(mocks.replace).not.toHaveBeenCalledWith(expect.stringContaining('/monthly'));

    vi.useRealTimers();
  });

  it('when projectId is supplied via query param, skips the project-creation step entirely and starts at the first anchor step', async () => {
    mocks.searchParams = new URLSearchParams({ type: 'CASA', projectId: 'existing-1' });
    renderPage();

    expect(screen.queryByRole('button', { name: /criar e continuar/i })).not.toBeInTheDocument();
    expect(await screen.findByPlaceholderText('Nome da conta')).toBeInTheDocument();
    expect(mocks.apiPost).not.toHaveBeenCalledWith('/projects', expect.anything());

    vi.useRealTimers();
  });

  it('redirects to /projects when type is missing', async () => {
    mocks.searchParams = new URLSearchParams();
    renderPage();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/projects'));
    vi.useRealTimers();
  });

  it('redirects to /projects when type is not a valid ProjectType', async () => {
    mocks.searchParams = new URLSearchParams({ type: 'NOT_A_TYPE' });
    renderPage();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/projects'));
    vi.useRealTimers();
  });

  it('double-clicking "Criar e continuar" only creates one project (createdRef guard)', async () => {
    mocks.searchParams = new URLSearchParams({ type: 'REFORMA' });
    let resolveCreate: (value: { id: string }) => void = () => {};
    mocks.apiPost.mockImplementation((path: string) => {
      if (path === '/projects') return new Promise((resolve) => { resolveCreate = resolve; });
      return Promise.resolve({});
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
    renderPage();

    const button = await screen.findByRole('button', { name: /criar e continuar|criando/i });
    await user.click(button);
    await user.click(button);

    resolveCreate({ id: 'proj-1' });
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(1));

    vi.useRealTimers();
  });
});
