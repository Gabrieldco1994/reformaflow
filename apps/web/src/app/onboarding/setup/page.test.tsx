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

/** Per-type sequence of skip-button name regexes to click through every anchor step
 *  (o passo final "Feedback" com seu botão "Pular" é comum a todos os tipos). */
const SKIP_SEQUENCES: Record<string, RegExp[]> = {
  PESSOAL: [/pular por agora/i, /pular — cadastro depois/i, /pular por agora/i, /pular — importar depois/i, /pular por agora/i, /^pular$/i],
  REFORMA: [/pular por agora/i, /^pular$/i],
  COMPRA: [/pular por agora/i, /^pular$/i],
  CASA: [/cancelar/i, /^pular$/i],
  CARRO: [/pular por agora/i, /^pular$/i],
  PLANTAS: [/pular por agora/i, /^pular$/i],
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
    ['PESSOAL', '/projects/proj-1/monthly'],
    ['REFORMA', '/projects/proj-1/dashboard'],
    ['COMPRA', '/projects/proj-1/dashboard'],
    ['CASA', '/projects/proj-1/dashboard'],
    ['CARRO', '/projects/proj-1/dashboard'],
    ['PLANTAS', '/projects/proj-1/dashboard'],
  ])('auto-creates the %s project, skips every anchor step, and lands on its per-type cockpit (%s)', async (type, expectedHome) => {
    mocks.searchParams = new URLSearchParams({ type });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /criar e continuar/i }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/projects', expect.objectContaining({ type })));

    await skipEverything(user, type);

    await screen.findByText(/tudo pronto/i);
    vi.advanceTimersByTime(1500);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(expectedHome));
    expect(mocks.replace).not.toHaveBeenCalledWith(expect.stringContaining('/apoio'));

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
