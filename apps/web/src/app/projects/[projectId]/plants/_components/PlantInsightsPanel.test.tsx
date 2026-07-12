import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { usePlantInsights } from '../_hooks/usePlantInsights';
import { PlantInsightsPanel } from './PlantInsightsPanel';
import type { PlantInsightsResponse } from '../_types';

const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
  },
}));

// Test 16: Hook loads insights successfully
describe('PlantInsights Frontend - Hook', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it('should fetch and return insights when component mounts', async () => {
    const mockInsights: PlantInsightsResponse = {
      diagnosis: {
        cuidados: {
          rega: '2x/week',
          luz: '6h+',
          poda: 'monthly',
          adubacao: 'spring',
          solo: 'well-drained',
        },
        saude: { status: 'SAUDAVEL' },
        pet: { risco: 'SEGURO' },
        problemasPossiveis: [],
      },
      cuidadoAgendado: {},
    };

    apiGetMock.mockResolvedValue(mockInsights);

    // Create a test component that uses the hook
    function TestHookComponent() {
      const { data, loading, error } = usePlantInsights('proj1', 'plant1');
      return (
        <div>
          {loading && <p>Loading...</p>}
          {error && <p>Error: {error}</p>}
          {data && <p>Data loaded: {data.diagnosis?.saude.status}</p>}
        </div>
      );
    }

    render(<TestHookComponent />);

    // Initially should show loading
    expect(screen.getByText('Loading...')).toBeInTheDocument();

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText(/Data loaded: SAUDAVEL/)).toBeInTheDocument();
    });

    // Verify the hook returned data
    expect(apiGetMock).toHaveBeenCalledWith('/projects/proj1/plants/plant1/insights');
  });

  // Test 17: Hook handles API error gracefully
  it('should set error state when API call fails', async () => {
    const testError = new Error('Network error');
    apiGetMock.mockRejectedValue(testError);

    function TestHookComponent() {
      const { data, loading, error } = usePlantInsights('proj1', 'plant1');
      return (
        <div>
          {loading && <p>Loading...</p>}
          {error && <p>Error: {error}</p>}
          {data && <p>Data loaded</p>}
        </div>
      );
    }

    render(<TestHookComponent />);

    await waitFor(() => {
      expect(screen.getByText(/Error: Network error/)).toBeInTheDocument();
    });

    // Data should not be loaded
    expect(screen.queryByText('Data loaded')).not.toBeInTheDocument();
  });
});

// Test 18-23: Component tests
describe('PlantInsights Frontend - PlantInsightsPanel', () => {
  // Test 18: Component renders care guide section
  it('should render care guide with 5 sections', () => {
    const insights: PlantInsightsResponse = {
      diagnosis: {
        cuidados: {
          rega: '2x/week',
          luz: '6h+',
          poda: 'monthly',
          adubacao: 'spring',
          solo: 'well-drained',
        },
        saude: { status: 'SAUDAVEL' },
        pet: { risco: 'SEGURO' },
        problemasPossiveis: [],
      },
      cuidadoAgendado: {},
    };

    render(<PlantInsightsPanel insights={insights} />);

    expect(screen.getByText(/Rega/)).toBeInTheDocument();
    expect(screen.getByText(/2x\/week/)).toBeInTheDocument();
    expect(screen.getByText(/Luz/)).toBeInTheDocument();
    expect(screen.getByText(/6h\+/)).toBeInTheDocument();
    expect(screen.getByText(/Poda/)).toBeInTheDocument();
    expect(screen.getByText(/monthly/)).toBeInTheDocument();
    expect(screen.getByText(/Adubação/)).toBeInTheDocument();
    expect(screen.getByText(/spring/)).toBeInTheDocument();
    expect(screen.getByText(/Solo/)).toBeInTheDocument();
    expect(screen.getByText(/well-drained/)).toBeInTheDocument();
  });

  // Test 19: Component renders health & pet section with badges
  it('should render health status and pet risk with badges', () => {
    const insights: PlantInsightsResponse = {
      diagnosis: {
        cuidados: {
          rega: '2x/week',
          luz: '6h+',
          poda: 'monthly',
          adubacao: 'spring',
          solo: 'well-drained',
        },
        saude: { status: 'ATENCAO' },
        pet: { risco: 'CAUTELA' },
        problemasPossiveis: [],
      },
      cuidadoAgendado: {},
    };

    render(<PlantInsightsPanel insights={insights} />);

    const badges = screen.getAllByText(/ATENCAO|CAUTELA/);
    expect(badges.length).toBeGreaterThan(0);
  });

  // Test 20: Component renders problems section when present
  it('should list problems with severity and action plan', () => {
    const insights: PlantInsightsResponse = {
      diagnosis: {
        cuidados: {
          rega: '2x/week',
          luz: '6h+',
          poda: 'monthly',
          adubacao: 'spring',
          solo: 'well-drained',
        },
        saude: { status: 'SAUDAVEL' },
        pet: { risco: 'SEGURO' },
        problemasPossiveis: [
          {
            nome: 'Oídio',
            gravidade: 'MEDIA',
            planoAcao: ['Pulverizador', 'Isolar'],
          },
        ],
      },
      cuidadoAgendado: {},
    };

    render(<PlantInsightsPanel insights={insights} />);

    expect(screen.getByText('Oídio')).toBeInTheDocument();
    expect(screen.getByText('MEDIA')).toBeInTheDocument();
    expect(screen.getByText(/Pulverizador/)).toBeInTheDocument();
    expect(screen.getByText(/Isolar/)).toBeInTheDocument();
  });

  // Test 21: Component handles missing diagnosis gracefully
  it('should show placeholder when diagnosis is null', () => {
    const insights: PlantInsightsResponse = {
      diagnosis: null,
      cuidadoAgendado: {},
    };

    render(<PlantInsightsPanel insights={insights} />);

    expect(screen.getByText(/Nenhum diagnóstico disponível/)).toBeInTheDocument();
  });

  // Test 22: Component renders upcoming reminders in schedule section
  it('should display reminders with title, date, and status', () => {
    const insights: PlantInsightsResponse = {
      diagnosis: {
        cuidados: {
          rega: '2x/week',
          luz: '6h+',
          poda: 'monthly',
          adubacao: 'spring',
          solo: 'well-drained',
        },
        saude: { status: 'SAUDAVEL' },
        pet: { risco: 'SEGURO' },
        problemasPossiveis: [],
      },
      cuidadoAgendado: {
        reminders: [
          {
            titulo: 'Regar',
            data: '2026-07-15',
            status: 'PENDENTE',
            prioridade: 'MEDIA',
          },
        ],
      },
    };

    render(<PlantInsightsPanel insights={insights} />);

    expect(screen.getByText(/Regar/)).toBeInTheDocument();
    expect(screen.getByText(/15\/07\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/PENDENTE/)).toBeInTheDocument();
  });

  // Test 23: Component renders maintenance history in schedule section
  it('should display maintenance tasks with type, date, and cost', () => {
    const insights: PlantInsightsResponse = {
      diagnosis: {
        cuidados: {
          rega: '2x/week',
          luz: '6h+',
          poda: 'monthly',
          adubacao: 'spring',
          solo: 'well-drained',
        },
        saude: { status: 'SAUDAVEL' },
        pet: { risco: 'SEGURO' },
        problemasPossiveis: [],
      },
      cuidadoAgendado: {
        maintenance: [
          {
            tipo: 'Limpeza',
            dataRealizada: '2026-07-10',
            custo: 5000,
          },
        ],
      },
    };

    render(<PlantInsightsPanel insights={insights} />);

    expect(screen.getByText(/Limpeza/)).toBeInTheDocument();
    expect(screen.getByText(/10\/07\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/R\$ 50/)).toBeInTheDocument();
  });
});
