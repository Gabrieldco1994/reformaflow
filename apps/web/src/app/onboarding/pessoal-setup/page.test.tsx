import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PessoalSetupPage from './page';

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1' }, refresh: mocks.refresh }),
}));
vi.mock('@/lib/api', () => ({
  api: { post: mocks.apiPost },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

describe('PessoalSetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.apiPost.mockImplementation((path: string) => {
      if (path === '/projects') return Promise.resolve({ id: 'proj-1' });
      return Promise.resolve({});
    });
  });

  it('ao concluir (ou pular) o wizard, leva para o guia de apoio — nunca direto pro Cockpit sem passar por ele', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PessoalSetupPage />);

    await user.click(await screen.findByRole('button', { name: /criar e continuar/i }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith('/projects', expect.objectContaining({ type: 'PESSOAL' })));

    // Pula conta (confirmação em 2 cliques) e cartão — caminho mais curto até "done".
    await user.click(await screen.findByRole('button', { name: /pular por agora/i }));
    await user.click(await screen.findByRole('button', { name: /pular mesmo assim/i }));
    await user.click(await screen.findByRole('button', { name: /pular — cadastro depois/i }));

    await screen.findByText(/tudo pronto/i);
    vi.advanceTimersByTime(1500);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/projects/proj-1/apoio'));
    expect(mocks.replace).not.toHaveBeenCalledWith(expect.stringContaining('/monthly'));

    vi.useRealTimers();
  });
});
