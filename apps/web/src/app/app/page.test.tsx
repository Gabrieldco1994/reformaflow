import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppEntryPage from './page';

const { replaceMock, apiGetMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  apiGetMock: vi.fn(),
}));

let screenQuery = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(screenQuery),
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: apiGetMock,
  },
}));

describe('/app entry routing', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    apiGetMock.mockReset();
    window.localStorage.clear();
    screenQuery = '';
  });

  it('does not force non-PESSOAL projects to /monthly for screen=hoje', async () => {
    screenQuery = 'screen=hoje';
    apiGetMock.mockResolvedValue([{ id: 'c1', type: 'CASA' }]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/c1/dashboard');
    });
  });

  it('does not force non-PESSOAL projects to /monthly for screen=lancar', async () => {
    screenQuery = 'screen=lancar';
    apiGetMock.mockResolvedValue([{ id: 'c1', type: 'CASA' }]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/c1/dashboard');
    });
  });

  it('falls back to type-aware home when screen=maria is not available for the project type', async () => {
    screenQuery = 'screen=maria';
    apiGetMock.mockResolvedValue([{ id: 'c1', type: 'CASA' }]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/c1/dashboard');
    });
  });
});
