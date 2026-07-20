import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CarInfoForm } from './CarInfoForm';

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
    put: (...args: unknown[]) => apiPutMock(...args),
  },
}));

function renderWithClient(projectId = 'p1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CarInfoForm projectId={projectId} />
    </QueryClientProvider>,
  );
}

describe('CarInfoForm', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPutMock.mockReset();
    apiGetMock.mockResolvedValue(null);
    apiPutMock.mockResolvedValue({});
  });

  it('receives projectId as a prop (no useProject() context required — renders without mocking @/contexts/project-context)', async () => {
    renderWithClient('p1');
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith('/projects/p1/car-info'));
    expect(await screen.findByText('Meu Carro')).toBeInTheDocument();
  });

  it("loads existing data via useQuery keyed ['car-info', projectId]", async () => {
    apiGetMock.mockResolvedValue({
      marca: 'Toyota', modelo: 'Corolla', anoFabricacao: 2022, anoModelo: 2023,
      cor: 'Prata', placa: 'ABC1D23', tabelaFipe: null, valorPago: null,
      kmAtual: null, kmUltimaRevisao: null,
    });
    renderWithClient('p1');
    expect(await screen.findByDisplayValue('Toyota')).toBeInTheDocument();
  });

  it('Salvar calls PUT /projects/:id/car-info with only the non-empty fields (omits empty-string fields as undefined)', async () => {
    renderWithClient('p1');
    await screen.findByText('Meu Carro');
    fireEvent.change(screen.getByPlaceholderText('Ex: Toyota'), { target: { value: 'Fiat' } });
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(apiPutMock).toHaveBeenCalledWith('/projects/p1/car-info', expect.objectContaining({
      marca: 'Fiat',
      modelo: undefined,
      cor: undefined,
      placa: undefined,
    })));
  });

  it('shows the FIPE-comparison and km-revision banners at their existing thresholds', async () => {
    apiGetMock.mockResolvedValue({
      marca: 'Toyota', modelo: 'Corolla', anoFabricacao: 2022, anoModelo: 2023,
      cor: 'Prata', placa: 'ABC1D23', tabelaFipe: 10000000, valorPago: 11000000,
      kmAtual: 50000, kmUltimaRevisao: 40000,
    });
    renderWithClient('p1');
    expect(await screen.findByText(/acima da FIPE/)).toBeInTheDocument();
    expect(screen.getByText(/hora de revisar/)).toBeInTheDocument();
  });
});
