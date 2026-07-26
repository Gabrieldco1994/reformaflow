import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType, resolveJourney } from '@reformaflow/domain';
import AdminJornadasPage from './page';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  replace: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  isAdmin: true,
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isAdmin: mocks.isAdmin, loading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: mocks.apiGet, put: mocks.apiPut },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

function serverJourneys() {
  return Object.fromEntries(
    Object.values(ProjectType).map((type) => [type, resolveJourney(type)]),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminJornadasPage />
    </QueryClientProvider>,
  );
}

/** Rótulos das telinhas, na ordem em que aparecem na trilha. */
function trackLabels(): string[] {
  return screen.getAllByTestId('journey-step-label').map((el) => el.textContent ?? '');
}

async function waitForTrack() {
  await screen.findByTestId('journey-track');
}

describe('AdminJornadasPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAdmin = true;
    mocks.apiGet.mockResolvedValue(serverJourneys());
    mocks.apiPut.mockImplementation((_path: string, body: { steps: unknown[] }) =>
      Promise.resolve(body.steps),
    );
  });

  it('redireciona quem não é admin', async () => {
    mocks.isAdmin = false;
    renderPage();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/no-permission'));
  });

  it('desenha a trilha do tipo selecionado na ordem da jornada', async () => {
    renderPage();
    await waitForTrack();

    expect(trackLabels()).toEqual(
      resolveJourney(ProjectType.PESSOAL).map((step) => step.label),
    );
  });

  it('reordenar (teclado) reflete na ordem salva no PUT', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    const before = trackLabels();
    await user.click(screen.getByRole('button', { name: /mover "Contas & cartões" para depois/i }));

    expect(trackLabels()[0]).toBe(before[1]);
    expect(trackLabels()[1]).toBe(before[0]);

    await user.click(screen.getByRole('button', { name: /salvar jornada/i }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalled());
    const [path, body] = mocks.apiPut.mock.calls[0];
    expect(path).toBe('/admin/onboarding/journeys/PESSOAL');
    expect(body.steps.map((s: { stepKey: string }) => s.stepKey).slice(0, 2)).toEqual([
      'expense',
      'funding',
    ]);
    expect(body.steps.map((s: { order: number }) => s.order)).toEqual(
      body.steps.map((_: unknown, i: number) => i),
    );
  });

  it('desligar uma tela marca-a como fora da jornada e salva enabled=false', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    await user.click(screen.getByRole('button', { name: /desligar "Importar"/i }));

    const card = screen.getByTestId('journey-card-import');
    expect(within(card).getByText(/fora da jornada/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /salvar jornada/i }));
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalled());
    const body = mocks.apiPut.mock.calls[0][1];
    expect(body.steps.find((s: { stepKey: string }) => s.stepKey === 'import')).toMatchObject({
      enabled: false,
    });
  });

  it('editar os textos propaga para a telinha e para o payload', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    await user.click(screen.getByRole('button', { name: /editar textos de "Despesa"/i }));
    const labelInput = screen.getByLabelText(/rótulo curto/i);
    await user.clear(labelInput);
    await user.type(labelInput, 'Gasto');
    const subtitleInput = screen.getByLabelText(/texto de apoio/i);
    await user.clear(subtitleInput);
    await user.type(subtitleInput, 'Comece pelo café de hoje.');

    expect(trackLabels()).toContain('Gasto');
    // Escopado na telinha: o editor aberto (dentro do mesmo card) também mostra
    // o texto, e o que importa aqui é o preview refletir o que a pessoa verá.
    expect(
      within(screen.getByTestId('journey-card-expense')).getByTestId('journey-step-subtitle'),
    ).toHaveTextContent('Comece pelo café de hoje.');

    await user.click(screen.getByRole('button', { name: /salvar jornada/i }));
    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalled());
    const body = mocks.apiPut.mock.calls[0][1];
    expect(body.steps.find((s: { stepKey: string }) => s.stepKey === 'expense')).toMatchObject({
      label: 'Gasto',
      subtitle: 'Comece pelo café de hoje.',
    });
  });

  it('tornar obrigatória salva skippable=false', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    await user.click(screen.getByRole('button', { name: /tornar "Despesa" obrigatória/i }));
    await user.click(screen.getByRole('button', { name: /salvar jornada/i }));

    await waitFor(() => expect(mocks.apiPut).toHaveBeenCalled());
    const body = mocks.apiPut.mock.calls[0][1];
    expect(body.steps.find((s: { stepKey: string }) => s.stepKey === 'expense')).toMatchObject({
      skippable: false,
    });
  });

  it('mostra o aviso de alterações não salvas e some depois de salvar', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    expect(screen.queryByText(/alterações não salvas/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /desligar "Importar"/i }));
    expect(screen.getByText(/alterações não salvas/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /salvar jornada/i }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/alterações não salvas/i)).not.toBeInTheDocument(),
    );
  });

  it('sinaliza as telas condicionais (alwaysAvailable=false)', async () => {
    renderPage();
    await waitForTrack();

    const card = screen.getByTestId('journey-card-maria-insight');
    expect(within(card).getByText(/condicional/i)).toBeInTheDocument();
  });

  it('troca de tipo de projeto mostra a trilha do outro tipo', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    await user.click(screen.getByRole('button', { name: /^casa$/i }));

    expect(trackLabels()).toEqual(resolveJourney(ProjectType.CASA).map((s) => s.label));
  });

  it('avisa por toast quando o PUT falha e mantém o estado sujo', async () => {
    mocks.apiPut.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();
    await waitForTrack();

    await user.click(screen.getByRole('button', { name: /desligar "Importar"/i }));
    await user.click(screen.getByRole('button', { name: /salvar jornada/i }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.getByText(/alterações não salvas/i)).toBeInTheDocument();
  });
});
