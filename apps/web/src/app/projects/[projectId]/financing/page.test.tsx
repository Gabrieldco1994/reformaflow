import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FinancingPage from './page';

const mutate = vi.fn();

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'project-1', projectType: 'CASA', projectName: 'Casa' }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, isLoading: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: (options: { mutationFn: () => Promise<unknown> }) => ({
    mutate: () => mutate(options.mutationFn),
    isPending: false,
    error: null,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    put: vi.fn((_path: string, body: unknown) => Promise.resolve(body)),
    patch: vi.fn(),
  },
}));

describe('FinancingPage', () => {
  beforeEach(() => mutate.mockClear());

  it('converte reais e percentual para centavos e basis points ao salvar', async () => {
    const { api } = await import('@/lib/api');
    render(<FinancingPage />);

    fireEvent.change(screen.getByLabelText('Valor financiado (R$)'), { target: { value: '250000.50' } });
    fireEvent.change(screen.getByLabelText('Taxa mensal (%)'), { target: { value: '0.85' } });
    fireEvent.change(screen.getByLabelText('Prazo (meses)'), { target: { value: '360' } });
    fireEvent.change(screen.getByLabelText('Primeira parcela'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Dia do vencimento'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar financiamento' }));

    const runMutation = mutate.mock.calls[0][0] as () => Promise<unknown>;
    await runMutation();
    expect(api.put).toHaveBeenCalledWith('/projects/project-1/financing', expect.objectContaining({
      valorTotalFinanciado: 25000050,
      taxaJurosMensalBps: 85,
      prazoMeses: 360,
    }));
  });
});
