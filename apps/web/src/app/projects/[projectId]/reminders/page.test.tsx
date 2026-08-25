import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #585 — `loadReminders` engolia qualquer erro de rede/API e caía
 * silenciosamente em "nenhum lembrete", indistinguível de uma lista vazia de
 * verdade. Os handlers de ação (concluir/adiar/editar/excluir) só faziam
 * `console.error`, sem feedback visível quando a chamada falhava.
 *
 * Contrato: três estados mutuamente exclusivos (carregando / erro-com-retry /
 * vazio real) + toast de erro visível nas quatro ações de mutação.
 */

const { apiGet, apiPost, apiPatch, apiDelete, toastError } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({
    projectId: 'project-1',
    projectType: 'CASA',
    projectName: 'Minha casa',
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...(args as [])),
    post: (...args: unknown[]) => apiPost(...(args as [])),
    patch: (...args: unknown[]) => apiPatch(...(args as [])),
    delete: (...args: unknown[]) => apiDelete(...(args as [])),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: toastError },
}));

import RemindersPage from './page';

function isEmptyStateMessage(element: Element | null) {
  return (
    element?.tagName.toLowerCase() === 'p' &&
    !!element.textContent?.startsWith('Nenhum lembrete') &&
    !!element.closest('.border-dashed')
  );
}

function findByEmptyMessage() {
  return screen.findByText((_content, element) => isEmptyStateMessage(element));
}

function queryByEmptyMessage() {
  return screen.queryByText((_content, element) => isEmptyStateMessage(element));
}

const oneReminder = {
  id: 'reminder-1',
  titulo: 'Trocar filtro de ar',
  descricao: null,
  data: '2099-01-31T00:00:00.000Z',
  recorrencia: 'UNICA',
  status: 'PENDENTE',
  prioridade: 'MEDIA',
};

describe('RemindersPage — estados de erro/vazio (#585)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiPatch.mockReset();
    apiDelete.mockReset();
    toastError.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('mostra erro-com-retry quando o fetch falha, nunca "nenhum lembrete"', async () => {
    apiGet.mockRejectedValueOnce(new Error('Falha de rede'));
    render(<RemindersPage />);

    expect(await screen.findByText('Não foi possível carregar os lembretes')).toBeInTheDocument();
    expect(screen.getByText('Falha de rede')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
    expect(queryByEmptyMessage()).not.toBeInTheDocument();
  });

  it('"Tentar novamente" rechama a busca e sai do estado de erro', async () => {
    apiGet.mockRejectedValueOnce(new Error('Falha de rede'));
    apiGet.mockResolvedValueOnce([]);
    render(<RemindersPage />);

    const retry = await screen.findByRole('button', { name: 'Tentar novamente' });
    fireEvent.click(retry);

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(await findByEmptyMessage()).toBeInTheDocument();
    expect(screen.queryByText('Não foi possível carregar os lembretes')).not.toBeInTheDocument();
  });

  it('mostra o vazio real só quando a busca teve sucesso e não há lembretes', async () => {
    apiGet.mockResolvedValueOnce([]);
    render(<RemindersPage />);

    expect(await findByEmptyMessage()).toBeInTheDocument();
    expect(screen.queryByText('Não foi possível carregar os lembretes')).not.toBeInTheDocument();
  });

  it('dá feedback visível quando "Concluir" falha, além do console.error', async () => {
    apiGet.mockResolvedValueOnce([oneReminder]);
    apiPatch.mockRejectedValueOnce(new Error('Erro ao concluir'));
    render(<RemindersPage />);

    const doneButton = await screen.findByTitle('Concluir');
    fireEvent.click(doneButton);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it('dá feedback visível quando "Excluir" falha', async () => {
    apiGet.mockResolvedValueOnce([oneReminder]);
    apiDelete.mockRejectedValueOnce(new Error('Erro ao excluir'));
    render(<RemindersPage />);

    await screen.findByRole('article', { name: oneReminder.titulo });
    fireEvent.click(screen.getByRole('button', { name: `Ações ${oneReminder.titulo}` }));
    fireEvent.click(await screen.findByText('Excluir'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
