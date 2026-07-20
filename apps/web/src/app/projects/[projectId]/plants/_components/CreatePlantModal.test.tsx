import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreatePlantModal } from './CreatePlantModal';

const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
const apiUploadMock = vi.fn();

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: 'PLANTAS', projectName: 'Plantas' }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    upload: (...args: unknown[]) => apiUploadMock(...args),
  },
}));

vi.mock('@/lib/image-compress', () => ({
  checkImageQuality: vi.fn().mockResolvedValue({ ok: true, width: 800, height: 600 }),
}));

function makeFile() {
  return new File(['fake-bytes'], 'planta.jpg', { type: 'image/jpeg' });
}

function pickPhoto(buttonLabel: string, file: File) {
  fireEvent.click(screen.getByText(buttonLabel));
  const inputs = document.querySelectorAll('input[type="file"]');
  const input = buttonLabel === 'Tirar foto' ? inputs[0] : inputs[1];
  fireEvent.change(input, { target: { files: [file] } });
}

describe('CreatePlantModal', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
    apiUploadMock.mockReset();
  });

  it('diagnoses the photo, auto-creates the plant, and lets the user confirm/rename the AI-suggested name', async () => {
    apiUploadMock.mockResolvedValue({
      plantId: 'plant-1',
      diagnosis: { especieProvavel: { nomePopular: 'Jiboia', nomeCientifico: 'Epipremnum aureum', confianca: 0.9 } },
    });
    apiPatchMock.mockResolvedValue({});
    const onCreated = vi.fn();

    render(<CreatePlantModal onClose={vi.fn()} onCreated={onCreated} />);

    pickPhoto('Enviar foto', makeFile());

    await waitFor(() => expect(screen.getByText(/Jiboia/)).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Nome da planta') as HTMLInputElement;
    expect(input.value).toBe('Jiboia');
    fireEvent.change(input, { target: { value: 'Jiboia da sala' } });
    fireEvent.click(screen.getByText('Concluir'));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(apiPatchMock).toHaveBeenCalledWith('/projects/p1/plants/plant-1', { nome: 'Jiboia da sala' });
  });

  it('falls back to manual name creation when the AI diagnosis fails', async () => {
    apiUploadMock.mockRejectedValue(new Error('Gemini indisponível'));
    apiPostMock.mockResolvedValue({ id: 'plant-2', nome: 'Samambaia' });
    const onCreated = vi.fn();

    render(<CreatePlantModal onClose={vi.fn()} onCreated={onCreated} />);

    pickPhoto('Enviar foto', makeFile());

    await waitFor(() => expect(screen.getByPlaceholderText(/Nome da planta/)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/Nome da planta/), { target: { value: 'Samambaia' } });
    fireEvent.click(screen.getByText('Criar planta'));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith('/projects/p1/plants', { nome: 'Samambaia' });
  });

  it('allows creating without a photo at all, straight from a typed name', async () => {
    apiPostMock.mockResolvedValue({ id: 'plant-3', nome: 'Cacto' });
    const onCreated = vi.fn();

    render(<CreatePlantModal onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.click(screen.getByText('Prefiro só dar um nome, sem foto agora'));
    fireEvent.change(screen.getByPlaceholderText(/Nome da planta/), { target: { value: 'Cacto' } });
    fireEvent.click(screen.getByText('Criar planta'));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith('/projects/p1/plants', { nome: 'Cacto' });
    expect(apiUploadMock).not.toHaveBeenCalled();
  });

  it('bare=true renders without the outer "fixed inset-0 bg-black/40" wrapper class; bare=false (default) keeps it', () => {
    const { container, unmount } = render(<CreatePlantModal onClose={vi.fn()} onCreated={vi.fn()} bare />);
    expect(container.querySelector('.fixed.inset-0.bg-black\\/40')).not.toBeInTheDocument();
    unmount();

    const { container: containerDefault } = render(<CreatePlantModal onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(containerDefault.querySelector('.fixed.inset-0.bg-black\\/40')).toBeInTheDocument();
  });
});
