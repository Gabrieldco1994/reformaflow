import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType, resolveJourney, type ResolvedJourneyStep } from '@reformaflow/domain';
import OnboardingSetupPage from './page';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
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
    get: mocks.apiGet,
  },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => mocks.searchParams,
}));

/** Per-type sequence of skip-button name regexes to click through every anchor step
 *  (o passo final "Feedback" com seu botão "Pular" é comum a todos os tipos). */
const SKIP_SEQUENCES: Record<string, RegExp[]> = {
  PESSOAL: [/pular por agora/i, /pular por agora/i, /pular — importar depois/i, /pular por agora/i, /^pular$/i],
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
    // Por padrão a API devolve exatamente a jornada default do catálogo — os
    // testes que exercitam configuração/queda sobrescrevem este mock.
    mocks.apiGet.mockImplementation((path: string) => {
      const match = /^\/onboarding\/journey\/(.+)$/.exec(path);
      if (match) return Promise.resolve(resolveJourney(match[1] as ProjectType));
      return Promise.resolve([]);
    });
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

  describe('jornada configurável', () => {
    function step(over: Partial<ResolvedJourneyStep> & { key: string }): ResolvedJourneyStep {
      return {
        label: over.key,
        subtitle: '',
        enabled: true,
        skippable: true,
        alwaysAvailable: true,
        ...over,
      };
    }

    function mockJourney(steps: ResolvedJourneyStep[] | 'fail') {
      mocks.apiGet.mockImplementation((path: string) => {
        if (!path.startsWith('/onboarding/journey')) return Promise.resolve([]);
        return steps === 'fail'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(steps);
      });
    }

    it('a ordem das telas vem da jornada da API, não do catálogo', async () => {
      mocks.searchParams = new URLSearchParams({ type: 'PESSOAL', projectId: 'p1' });
      mockJourney([
        step({ key: 'receipt', label: 'Recebimento', subtitle: 'TELA A' }),
        step({ key: 'funding', label: 'Contas & cartões', subtitle: 'TELA B' }),
      ]);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderPage();

      await screen.findByText('TELA A');
      expect(screen.queryByText('TELA B')).not.toBeInTheDocument();

      await user.click(await screen.findByText(/pular por agora/i));
      expect(await screen.findByText('TELA B')).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('tela desligada não aparece no fluxo', async () => {
      mocks.searchParams = new URLSearchParams({ type: 'CASA', projectId: 'p1' });
      mockJourney([
        step({ key: 'bill', label: 'Conta', subtitle: 'CONTA FIXA', enabled: false }),
        step({ key: 'feedback', label: 'Feedback', subtitle: 'FEEDBACK AQUI' }),
      ]);
      renderPage();

      expect(await screen.findByText('FEEDBACK AQUI')).toBeInTheDocument();
      expect(screen.queryByText('CONTA FIXA')).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it('tela obrigatória (skippable=false) não oferece "Pular"', async () => {
      mocks.searchParams = new URLSearchParams({ type: 'CARRO', projectId: 'p1' });
      mockJourney([
        step({ key: 'car', label: 'Veículo', subtitle: 'DADOS DO CARRO', skippable: false }),
        step({ key: 'feedback', label: 'Feedback' }),
      ]);
      renderPage();

      await screen.findByText('DADOS DO CARRO');
      expect(screen.queryByText(/pular/i)).not.toBeInTheDocument();

      vi.useRealTimers();
    });

    it('API da jornada falhando: cai no default do catálogo e o wizard continua funcionando', async () => {
      mocks.searchParams = new URLSearchParams({ type: 'PESSOAL' });
      mockJourney('fail');
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderPage();

      await user.click(await screen.findByRole('button', { name: /criar e continuar/i }));
      await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/projects', expect.objectContaining({ type: 'PESSOAL' })));

      await skipEverything(user, 'PESSOAL');
      await screen.findByText(/tudo pronto/i);
      vi.advanceTimersByTime(1500);

      await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/projects/proj-1/monthly'));
      vi.useRealTimers();
    });

    it('API da jornada pendurada (sem resposta): usa o default e não trava num spinner', async () => {
      mocks.searchParams = new URLSearchParams({ type: 'CARRO', projectId: 'p1' });
      mocks.apiGet.mockImplementation((path: string) =>
        path.startsWith('/onboarding/journey') ? new Promise(() => {}) : Promise.resolve([]),
      );
      renderPage();

      const [first] = resolveJourney(ProjectType.CARRO);
      expect(await screen.findByText(first.subtitle)).toBeInTheDocument();

      vi.useRealTimers();
    });
  });
});
