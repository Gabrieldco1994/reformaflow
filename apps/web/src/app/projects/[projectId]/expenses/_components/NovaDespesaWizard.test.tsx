import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Expense } from '@/types';
import { NovaDespesaWizard } from './NovaDespesaWizard';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ id: 'new-1' }) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const tipoOptions = [
  { value: 'MATERIAL_CONSTRUCAO', label: 'Material' },
  { value: 'MAO_DE_OBRA', label: 'Mão de Obra' },
];

function renderWizard(overrides: Partial<React.ComponentProps<typeof NovaDespesaWizard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props: React.ComponentProps<typeof NovaDespesaWizard> = {
    open: true,
    mode: 'PLANEJAR',
    projectId: 'p1',
    projectType: 'PESSOAL',
    allowRecorrente: false,
    tipoOptions,
    roomOptions: [],
    showRooms: false,
    plannedExpenses: [],
    onPay: vi.fn(),
    payDisabled: false,
    onClose: vi.fn(),
    onCreated: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <QueryClientProvider client={client}>
      <NovaDespesaWizard {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, props };
}

function fillDados(container: HTMLElement) {
  fireEvent.change(container.querySelector('[name="tipoDespesa"]')!, {
    target: { value: 'MATERIAL_CONSTRUCAO' },
  });
  fireEvent.change(container.querySelector('[name="valor"]')!, { target: { value: '100' } });
}

describe('NovaDespesaWizard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mode=PLANEJAR abre no passo DADOS', () => {
    const { container } = renderWizard();
    expect(container.querySelector('[name="tipoDespesa"]')).toBeTruthy();
    expect(container.querySelector('[name="formaPagamento"]')).toBeNull();
  });

  it('preencher DADOS e Avançar leva ao passo PAGAMENTO', () => {
    const { container } = renderWizard();
    fillDados(container);
    fireEvent.click(screen.getByRole('button', { name: /Avançar/i }));
    expect(container.querySelector('[name="formaPagamento"]')).toBeTruthy();
  });

  it('Voltar preserva os dados preenchidos', () => {
    const { container } = renderWizard();
    fillDados(container);
    fireEvent.click(screen.getByRole('button', { name: /Avançar/i }));
    fireEvent.click(screen.getByRole('button', { name: /Voltar/i }));
    expect((container.querySelector('[name="valor"]') as HTMLInputElement).value).toBe('100');
  });

  it('passo AÇÃO mostra os 2 caminhos (registrar/planejar e vincular)', () => {
    const { container } = renderWizard();
    fillDados(container);
    fireEvent.click(screen.getByRole('button', { name: /Avançar/i }));
    fireEvent.change(container.querySelector('[name="formaPagamento"]')!, {
      target: { value: 'A_VISTA' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Avançar/i }));
    expect(screen.getByText(/Planejar despesa/i)).toBeInTheDocument();
    expect(screen.getByText(/Realizar vínculo de despesa/i)).toBeInTheDocument();
  });

  it('mode=PAGA mostra o garfo (Nova vs Pagar planejada)', () => {
    renderWizard({ mode: 'PAGA' });
    expect(screen.getByText('Nova despesa paga')).toBeInTheDocument();
    expect(screen.getByText('Pagar despesa planejada')).toBeInTheDocument();
  });

  it('garfo PAGA → "Pagar planejada" lista as despesas e clicar chama onPay', () => {
    const planned: Expense[] = [
      {
        id: 'exp-9',
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        titulo: 'Cimento',
        fornecedor: 'Loja X',
        valorTotal: 5000,
        status: 'PLANEJADO',
      } as unknown as Expense,
    ];
    const onPay = vi.fn();
    renderWizard({ mode: 'PAGA', plannedExpenses: planned, onPay });
    fireEvent.click(screen.getByText('Pagar despesa planejada'));
    const item = screen.getByText('Cimento');
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(onPay).toHaveBeenCalledWith('exp-9');
  });
});
