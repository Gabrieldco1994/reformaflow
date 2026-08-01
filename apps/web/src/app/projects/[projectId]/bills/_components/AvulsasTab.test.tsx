import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { AvulsasTab } from './AvulsasTab';
import type { AvulsaRow } from '../_display';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: apiMock }));

function makeExpense(overrides: Partial<AvulsaRow> = {}): AvulsaRow {
  return {
    id: 'exp-1',
    tipoDespesa: 'MANUTENCAO',
    titulo: 'Conserto telhado',
    fornecedor: 'Zé Pedreiro',
    valor: 10_000,
    valorTotal: 30_000,
    quantidade: 3,
    status: 'PAGO',
    formaPagamento: 'A_VISTA',
    dataPagamento: '2026-07-10T00:00:00.000Z',
    dataInicioParcela: null,
    quantidadeParcela: null,
    ...overrides,
  };
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AvulsasTab projectId="p1" projectType={ProjectType.CASA} />
    </QueryClientProvider>,
  );
}

function getValorInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[name="valor"]');
  if (!input) throw new Error('input[name="valor"] not found');
  return input;
}

describe('AvulsasTab — preservação de quantidade na edição (issue #369)', () => {
  beforeEach(() => {
    // AvulsasTab filtra a lista pelo mês corrente (new Date()); fixar o relógio
    // torna o teste determinístico independente de fuso/dia — sem isso, a
    // virada de mês (ou UTC vs. horário local do CI) esvazia a lista mockada.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue({ items: [makeExpense()], total: 1 });
    apiMock.patch.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('PATCH preserva quantidade=3 ao editar despesa avulsa, em vez de forçar 1', async () => {
    renderTab();
    await screen.findAllByText('Conserto telhado');

    fireEvent.click(screen.getAllByRole('button', { name: /editar/i })[0]);
    await screen.findByText('Editar despesa avulsa');

    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        '/projects/p1/expenses/exp-1',
        expect.objectContaining({ quantidade: 3 }),
      ),
    );
  });

  it('criação de nova despesa avulsa continua enviando quantidade=1 (form não expõe o campo)', async () => {
    const { container } = renderTab();
    await screen.findAllByText('Conserto telhado');

    fireEvent.click(screen.getByRole('button', { name: /nova despesa avulsa/i }));
    await screen.findByRole('heading', { name: 'Nova despesa avulsa' });

    fireEvent.change(getValorInput(container), { target: { value: '150,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        '/projects/p1/expenses',
        expect.objectContaining({ quantidade: 1 }),
      ),
    );
  });
});
