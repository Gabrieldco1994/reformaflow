import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportModal } from './ImportModal';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const post = api.post as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({});
});

describe('ImportModal — confirmação antes da importação destrutiva (#607)', () => {
  it('sem cronograma (0 etapas / 0 tarefas): botão único importa direto, sem passo extra', async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    render(
      <ImportModal
        projectId="p1"
        stageCount={0}
        taskCount={0}
        onImported={onImported}
        onClose={vi.fn()}
      />,
    );

    const importBtn = screen.getByRole('button', { name: 'Importar Modelo de Obra' });
    expect(importBtn).toBeInTheDocument();
    // nenhum aviso de substituição no fluxo sem cronograma
    expect(screen.queryByText(/substitui/i)).not.toBeInTheDocument();

    await user.click(importBtn);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/projects/p1/schedule/import', expect.anything());
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  });

  it('com cronograma (5 etapas / 20 tarefas): avisa da substituição, mostra as contagens e NÃO importa sem confirmação explícita', async () => {
    const user = userEvent.setup();
    render(
      <ImportModal
        projectId="p1"
        stageCount={5}
        taskCount={20}
        onImported={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // (a) declara que o cronograma atual será substituído + (b) mostra contagens
    expect(screen.getByText('Isto vai substituir o cronograma atual.')).toBeInTheDocument();
    expect(screen.getByText(/5 etapas e 20 tarefas/)).toBeInTheDocument();

    // o botão primário do passo 1 NÃO dispara a importação
    const primary = screen.getByRole('button', { name: 'Substituir cronograma' });
    await user.click(primary);
    expect(post).not.toHaveBeenCalled();

    // (c) só o botão de confirmação explícito do passo 2 chama a API
    const confirm = screen.getByRole('button', { name: 'Apagar e importar modelo' });
    expect(confirm).toBeInTheDocument();
    await user.click(confirm);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/projects/p1/schedule/import', expect.anything());
  });

  it('borda (0 etapas / 3 tarefas): count > 0 em qualquer um exige confirmação', async () => {
    const user = userEvent.setup();
    render(
      <ImportModal
        projectId="p1"
        stageCount={0}
        taskCount={3}
        onImported={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/0 etapas e 3 tarefas/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importar Modelo de Obra' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Substituir cronograma' }));
    expect(post).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apagar e importar modelo' }));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('"Cancelar" no passo de confirmação fecha sem chamar a API', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ImportModal
        projectId="p1"
        stageCount={5}
        taskCount={20}
        onImported={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Substituir cronograma' }));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(post).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
