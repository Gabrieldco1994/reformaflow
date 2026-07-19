import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import { PlantStep } from './PlantStep';

const apiPostMock = vi.fn();

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: 'PLANTAS', projectName: 'Plantas' }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: vi.fn(),
    upload: vi.fn(),
  },
}));

vi.mock('@/lib/image-compress', () => ({
  checkImageQuality: vi.fn().mockResolvedValue({ ok: true, width: 800, height: 600 }),
}));

describe('PlantStep', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
  });

  it('wraps CreatePlantModal in bare mode (no fixed inset-0 wrapper)', () => {
    const { container } = render(
      <PlantStep projectId="p1" projectType={ProjectType.PLANTAS} onDone={vi.fn()} onSkip={vi.fn()} />,
    );
    expect(container.querySelector('.fixed.inset-0.bg-black\\/40')).not.toBeInTheDocument();
  });

  it('manual-name creation calls onDone via the modal\'s onCreated', async () => {
    apiPostMock.mockResolvedValue({ id: 'plant-1', nome: 'Samambaia' });
    const onDone = vi.fn();
    render(<PlantStep projectId="p1" projectType={ProjectType.PLANTAS} onDone={onDone} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByText('Prefiro só dar um nome, sem foto agora'));
    fireEvent.change(screen.getByPlaceholderText(/Nome da planta/), { target: { value: 'Samambaia' } });
    fireEvent.click(screen.getByText('Criar planta'));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(apiPostMock).toHaveBeenCalledWith('/projects/p1/plants', { nome: 'Samambaia' });
  });

  it("the step's own explicit skip affordance calls onSkip without any api call", () => {
    const onSkip = vi.fn();
    render(<PlantStep projectId="p1" projectType={ProjectType.PLANTAS} onDone={vi.fn()} onSkip={onSkip} />);

    fireEvent.click(screen.getByText(/pular por agora/i));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
