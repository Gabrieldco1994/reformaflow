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

  it('routes screen=hoje to PESSOAL when the last project does not support monthlyOverview', async () => {
    screenQuery = 'screen=hoje';
    window.localStorage.setItem('rf_last_project_id', 'c1');
    apiGetMock.mockResolvedValue([
      { id: 'c1', type: 'CASA' },
      { id: 'p1', type: 'PESSOAL' },
    ]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/p1/monthly');
    });
  });

  it('routes screen=maria to PESSOAL when the last project does not support monthlyOverview', async () => {
    screenQuery = 'screen=maria';
    window.localStorage.setItem('rf_last_project_id', 'c1');
    apiGetMock.mockResolvedValue([
      { id: 'c1', type: 'CASA' },
      { id: 'p1', type: 'PESSOAL' },
    ]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/p1/maria');
    });
  });

  it('routes screen=lancar to PESSOAL when the last project does not support monthlyOverview', async () => {
    screenQuery = 'screen=lancar';
    window.localStorage.setItem('rf_last_project_id', 'c1');
    apiGetMock.mockResolvedValue([
      { id: 'c1', type: 'CASA' },
      { id: 'p1', type: 'PESSOAL' },
    ]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/p1/monthly?launch=1');
    });
  });

  it('routes screen=despesas to a project that supports expenses', async () => {
    screenQuery = 'screen=despesas';
    window.localStorage.setItem('rf_last_project_id', 'plants1');
    apiGetMock.mockResolvedValue([
      { id: 'plants1', type: 'PLANTAS' },
      { id: 'c1', type: 'CASA' },
    ]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/c1/expenses');
    });
  });

  it('falls back to the selected project type home when no project supports the screen', async () => {
    screenQuery = 'screen=maria';
    window.localStorage.setItem('rf_last_project_id', 'plants1');
    apiGetMock.mockResolvedValue([
      { id: 'c1', type: 'CASA' },
      { id: 'plants1', type: 'PLANTAS' },
    ]);

    render(<AppEntryPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/projects/plants1/dashboard');
    });
  });
});
