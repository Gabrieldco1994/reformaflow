import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PlantsAiPage from './page';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiUploadMock = vi.fn();

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: 'CASA', projectName: 'Casa' }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    upload: (...args: unknown[]) => apiUploadMock(...args),
  },
}));

vi.mock('@/lib/image-compress', () => ({
  checkImageQuality: vi.fn().mockResolvedValue({ ok: true, width: 800, height: 600 }),
}));

const CREATED_PLANT = {
  id: 'plant-1',
  nome: 'Jiboia da sala',
  localizacao: null,
  especiePopular: null,
  ultimaSaude: null,
  ultimoRiscoPet: null,
  ultimoDiagnosticoEm: null,
};

const DIAGNOSIS_FIXTURE = {
  especieProvavel: { nomePopular: 'Jiboia', nomeCientifico: 'Epipremnum aureum', confianca: 0.9 },
  saude: { status: 'SAUDAVEL' as const, confianca: 0.8, sinais: [] },
  pet: { risco: 'TOXICA' as const, observacao: 'Evitar contato com pets' },
  cuidados: {
    rega: 'Regar 2x por semana',
    luz: 'Luz indireta',
    poda: 'Poda leve',
    adubacao: 'Adubar mensalmente',
    solo: 'Solo drenável',
  },
  problemasPossiveis: [],
};

let plantsInBackend: typeof CREATED_PLANT[] = [];

function makeFile() {
  return new File(['fake-bytes'], 'planta.jpg', { type: 'image/jpeg' });
}

function selectPhoto(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('PlantsAiPage — onboarding de planta nova', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plantsInBackend = [];
    apiGetMock.mockImplementation(async (path: string) => {
      if (path.includes('/diagnosticos')) return [];
      if (path.endsWith('/plants')) return [...plantsInBackend];
      return [];
    });
    apiPostMock.mockImplementation(async (path: string, body: { nome: string }) => {
      const created = { ...CREATED_PLANT, nome: body.nome };
      plantsInBackend.push(created);
      return created;
    });
  });

  it('creates a plant, auto-diagnoses, and refreshes history so the new entry is visible', async () => {
    const HISTORY_ENTRY = {
      id: 'diag-1',
      createdAt: '2026-07-11T00:00:00.000Z',
      especiePopular: 'Jiboia',
      especieCientifica: 'Epipremnum aureum',
      saudeStatus: 'SAUDAVEL',
      riscoPet: 'TOXICA',
    };

    // Before upload the backend has no diagnostics; after upload it gains one.
    let uploadCompleted = false;
    apiGetMock.mockImplementation(async (path: string) => {
      if (path.includes('/diagnosticos')) return uploadCompleted ? [HISTORY_ENTRY] : [];
      if (path.endsWith('/plants')) return [...plantsInBackend];
      return [];
    });
    apiUploadMock.mockImplementationOnce(async () => {
      uploadCompleted = true;
      return {
        diagnosis: DIAGNOSIS_FIXTURE,
        schedule: { persisted: { reminders: 2, maintenance: 1 } },
      };
    });

    const { container } = render(<PlantsAiPage />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());

    const nameInput = container.querySelector(
      'input[placeholder="Nova planta (ex: Jiboia da sala)"]',
    ) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'Jiboia da sala' } });
    selectPhoto(container, makeFile());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Adicionar planta/i })).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Adicionar planta/i }));

    // Diagnosis card appears → upload resolved
    await waitFor(() =>
      expect(
        screen.getByText(/Cronograma salvo: 2 lembrete\(s\), 1 cuidado\(s\)\./),
      ).toBeInTheDocument(),
    );

    // After successful automatic diagnosis, loadHistory(created.id) must be called so that
    // the freshly-persisted entry appears in the history list.
    await waitFor(() =>
      expect(screen.getByText('· saúde: SAUDAVEL')).toBeInTheDocument(),
    );
    expect(screen.getByText('· risco pet: TOXICA')).toBeInTheDocument();
  });

  it('keeps a created plant selected and retries failed automatic diagnosis without creating a duplicate', async () => {
    const { container } = render(<PlantsAiPage />);

    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());

    const addButton = () => screen.getByRole('button', { name: /Adicionar planta/i });
    const diagnoseButton = () => screen.getByRole('button', { name: /Diagnosticar/i });
    const nameInput = container.querySelector(
      'input[placeholder="Nova planta (ex: Jiboia da sala)"]',
    ) as HTMLInputElement;

    // 1. Disabled before photo (name filled, no photo yet).
    fireEvent.change(nameInput, { target: { value: 'Jiboia da sala' } });
    expect(addButton()).toBeDisabled();

    const file = makeFile();
    selectPhoto(container, file);
    await waitFor(() => expect(addButton()).not.toBeDisabled());

    // First automatic diagnosis fails.
    apiUploadMock.mockRejectedValueOnce(new Error('Falha ao diagnosticar'));

    fireEvent.click(addButton());

    await waitFor(() =>
      expect(
        screen.getByText('Planta criada, mas o diagnóstico falhou. Tente novamente para esta planta.'),
      ).toBeInTheDocument(),
    );

    // Exactly one creation call.
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiUploadMock).toHaveBeenCalledTimes(1);

    const firstFormData = apiUploadMock.mock.calls[0][1] as FormData;
    expect(firstFormData.get('file')).toBe(file);
    expect(firstFormData.get('plantId')).toBe('plant-1');
    expect(firstFormData.get('persist')).toBe('true');

    // Selected plant remains, photo remains (retry button enabled).
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('plant-1');
    expect(diagnoseButton()).not.toBeDisabled();

    // Retry via the standalone diagnose action must not create another plant.
    apiUploadMock.mockResolvedValueOnce({
      diagnosis: DIAGNOSIS_FIXTURE,
      schedule: { persisted: { reminders: 2, maintenance: 1 } },
    });

    fireEvent.click(diagnoseButton());

    await waitFor(() =>
      expect(screen.getByText(/Cronograma salvo: 2 lembrete\(s\), 1 cuidado\(s\)\./)).toBeInTheDocument(),
    );

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiUploadMock).toHaveBeenCalledTimes(2);

    const secondFormData = apiUploadMock.mock.calls[1][1] as FormData;
    expect(secondFormData.get('plantId')).toBe('plant-1');

    expect(screen.getByText(/Rega: Regar 2x por semana/)).toBeInTheDocument();
  });
});
