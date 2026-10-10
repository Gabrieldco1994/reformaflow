import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import type { Expense } from '@/types';
import { ExpensesView } from './ExpensesView';
import { DespesaModal } from '../conta/_components/DespesaModal';

let view = 'category';
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'project', projectType: 'REFORMA' }),
}));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ user: { name: 'Synthetic' }, hasModule: () => true }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/projects/project/expenses',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`view=${view}&period=ALL`),
}));

const credit: Expense = {
  id: 'credit',
  projectId: 'project',
  titulo: 'Crédito sintético',
  fornecedor: 'Fornecedor sintético',
  tipoDespesa: 'MATERIAL_CONSTRUCAO',
  valor: -12_345_678,
  valorTotal: -12_345_678,
  quantidade: 1,
  formaPagamento: 'A_VISTA',
  dataPagamento: '2026-09-10',
  status: 'PAGO',
};

function mount(expense: Expense | (() => Expense), account = false) {
  const current = () => (typeof expense === 'function' ? expense() : expense);
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/projects/project/expenses/credit') return current();
    if (path.includes('/expenses?')) return { items: [current()], total: 1, page: 1, pageSize: 2000, totalPages: 1 };
    if (path.endsWith('/paid-origins')) return { items: [] };
    if (path.endsWith('/rateio')) return { rateado: false };
    if (path === '/projects/project') return { id: 'project', name: 'Projeto sintético', type: 'REFORMA', rooms: [] };
    return [];
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      {account ? <DespesaModal open onClose={vi.fn()} projectId="project" editExpenseId="credit" /> : <ExpensesView />}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  view = 'category';
});
afterEach(() => vi.useRealTimers());

describe.each(['category', 'general'])('credit actions in real ExpensesView: %s', (mode) => {
  it.each([
    { amount: -12_345_678, canDelete: undefined, allowed: false },
    { amount: -12_345_678, canDelete: false, allowed: false },
    { amount: -12_345_678, canDelete: true, allowed: true },
    { amount: 12_345_678, canDelete: undefined, allowed: true },
    { amount: 12_345_678, canDelete: false, allowed: false },
    { amount: 12_345_678, canDelete: true, allowed: true },
  ])('honors amount=$amount canDelete=$canDelete', async ({ amount, canDelete, allowed }) => {
    view = mode;
    mount({ ...credit, valor: amount, valorTotal: amount, canDelete });
    await screen.findByText('Crédito sintético');
    const remove = screen.queryByRole('button', { name: 'Excluir' });
    if (allowed) {
      fireEvent.click(remove!);
      await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/projects/project/expenses/credit'));
    } else {
      expect(remove).toBeNull();
      expect(api.delete).not.toHaveBeenCalled();
    }
    if (amount < 0) {
      expect(screen.queryByRole('button', { name: /Clique para alternar|Editar rápido|Copiar/ })).toBeNull();
      expect(api.post).not.toHaveBeenCalled();
      expect(api.patch).not.toHaveBeenCalled();
    } else {
      expect(screen.getByRole('button', { name: 'Editar rápido' })).toBeEnabled();
    }
  });
});

it.each([false, true])('saves only credit metadata through the real editor (account=%s)', async (account) => {
  const { container } = mount({ ...credit, canDelete: false, sourceAvailableCents: 0 }, account);
  if (!account) fireEvent.click(await screen.findByRole('button', { name: 'Editar completo' }));
  await screen.findByRole('heading', { name: 'Editar Despesa' });
  await waitFor(() => expect(container.querySelector('input[name="titulo"]')).not.toBeNull());
  for (const name of ['tipoDespesa', 'valor', 'quantidade', 'formaPagamento', 'dataPagamento']) {
    expect(container.querySelector(`[name="${name}"]`)).toBeDisabled();
  }
  expect(screen.queryByRole('button', { name: 'Ratear compra' })).toBeNull();
  // #702's explicit zero budget preserves positive-source undo, not credit funding.
  expect(screen.queryByRole('region', { name: 'Aplicar débito existente' })).toBeNull();
  fireEvent.change(container.querySelector('input[name="titulo"]')!, { target: { value: 'Descrição corrigida' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() =>
    expect(api.patch).toHaveBeenCalledWith('/projects/project/expenses/credit', {
      titulo: 'Descrição corrigida',
      fornecedor: 'Fornecedor sintético',
      link: null,
      imageUrl: null,
    }),
  );
  expect(api.post).not.toHaveBeenCalled();
});

describe.each(['category', 'general'])('#704 stale capability after a rejected delete: %s', (mode) => {
  it('refetches the list and drops Excluir once the server no longer grants deletion', async () => {
    view = mode;
    let granted = true;
    mount(() => ({ ...credit, canDelete: granted }));
    const remove = await screen.findByRole('button', { name: 'Excluir' });
    vi.mocked(api.delete).mockRejectedValueOnce(new Error('Exclusão não autorizada agora.'));
    granted = false;
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull());
    expect(api.delete).toHaveBeenCalledTimes(1);
  });
});
