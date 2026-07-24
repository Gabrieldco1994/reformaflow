import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Expense, ExpensesPage } from '@/types';
import { SimpleExpensesView } from './SimpleExpensesView';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: apiMock }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'car-1', projectType: 'CARRO' }),
}));

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1',
    tipoDespesa: 'GASOLINA',
    valor: 15_000,
    quantidade: 1,
    valorTotal: 15_000,
    titulo: 'Posto Shell',
    formaPagamento: 'A_VISTA',
    dataPagamento: '2026-07-10T00:00:00.000Z',
    status: 'PLANEJADO',
    ...overrides,
  } as Expense;
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SimpleExpensesView />
    </QueryClientProvider>,
  );
}

describe('SimpleExpensesView (CASA/CARRO — issue #292)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.get.mockResolvedValue({ items: [makeExpense()] } as ExpensesPage);
    apiMock.post.mockResolvedValue(makeExpense({ id: 'exp-2' }));
  });

  it('lista despesas existentes com valor nowrap e sem opção de import', async () => {
    renderView();
    expect(await screen.findByText('Posto Shell')).toBeInTheDocument();
    // Sem wizard cross-project nem import fatura/extrato nesta tela (AC #292).
    expect(screen.queryByText(/importar fatura/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/importar extrato/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/vincular a um projeto/i)).not.toBeInTheDocument();
  });

  it('abre o modal de nova despesa simples ao clicar em "+ Nova despesa"', async () => {
    renderView();
    await screen.findByText('Posto Shell');
    fireEvent.click(screen.getByRole('button', { name: /nova despesa/i }));
    expect(await screen.findByText('Adicionar rápido')).toBeInTheDocument();
  });

  it('cria despesa via POST no projeto atual', async () => {
    renderView();
    await screen.findByText('Posto Shell');
    fireEvent.click(screen.getByRole('button', { name: /nova despesa/i }));
    await screen.findByText('Adicionar rápido');

    const valorInput = screen.getByPlaceholderText('0,00');
    fireEvent.change(valorInput, { target: { value: '5000' } });
    fireEvent.click(screen.getByTitle('Salvar (Enter)'));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/projects/car-1/expenses', expect.any(Object)));
  });
});
