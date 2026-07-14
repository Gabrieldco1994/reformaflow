import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './page';

const { replaceMock, loginMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  loginMock: vi.fn(),
}));

let searchQuery = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchQuery),
}));

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ login: loginMock }),
}));

describe('/login redirect target', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    loginMock.mockReset();
    loginMock.mockResolvedValue(undefined);
    searchQuery = '';
  });

  it('redirects to /app when next is not provided', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Usuário'), 'demo');
    await user.type(screen.getByLabelText('Senha'), '123456');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('demo', '123456');
    });
    expect(replaceMock).toHaveBeenCalledWith('/app');
  });
});
