import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

  it.each([ProjectType.CASA, ProjectType.CARRO])('mostra saldo parcial canônico e salva somente metadados em %s', async (projectType) => {
    const expense = makeExpense({
      titulo: 'Contrato sintético', quantidade: 1, valor: 80_000, valorTotal: 80_000,
      formaPagamento: 'PARCELADO', quantidadeParcela: 1, status: 'PLANEJADO',
      dataPagamento: null, dataInicioParcela: '2026-07-10T00:00:00.000Z',
      installmentSettlements: [{
        parcelaIndex: 0, dueDate: '2026-07-10T00:00:00.000Z',
        contractedCents: 80_000, paidCents: 40_000, remainingCents: 40_000,
        settlementStatus: 'PARTIAL',
      }],
    });
    apiMock.get.mockResolvedValue({ items: [expense], total: 1 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <AvulsasTab projectId="p1" projectType={projectType} />
      </QueryClientProvider>,
    );
    const card = await screen.findByRole('article', { name: 'Contrato sintético' });
    const row = screen.getByRole('row', { name: /Contrato sintético/ });
    for (const surface of [card, row]) {
      expect(within(surface).getByText('Parcial')).toBeInTheDocument();
      expect(within(surface).getByText(/Restante:/)).toHaveTextContent('R$ 400,00');
      expect(within(surface).getByText(/Contratado:/)).toHaveTextContent('R$ 800,00');
      expect(within(surface).getByText(/Pago:/)).toHaveTextContent('R$ 400,00');
      expect(within(surface).getByRole('button', { name: 'Excluir' })).toBeDisabled();
    }
    fireEvent.click(within(card).getByRole('button', { name: 'Editar' }));
    const balance = screen.getByRole('region', { name: 'Saldo da despesa' });
    expect(within(balance).getByText('Parcial')).toBeInTheDocument();
    expect(within(balance).getByText(/Restante:/)).toHaveTextContent('R$ 400,00');
    for (const name of ['valor', 'status', 'formaPagamento', 'quantidadeParcela', 'dataInicioParcela']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeDisabled();
    }
    fireEvent.change(container.querySelector('input[name="titulo"]')!, { target: { value: 'Título corrigido' } });
    fireEvent.change(container.querySelector('select[name="tipoDespesa"]')!, { target: { value: 'OUTROS' } });
    fireEvent.change(container.querySelector('input[name="fornecedor"]')!, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/projects/p1/expenses/exp-1', {
      titulo: 'Título corrigido', tipoDespesa: 'OUTROS', fornecedor: null,
    }));
    expect(apiMock.post).not.toHaveBeenCalled();
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it.each([
    { paidCents: 0, settlementStatus: 'UNPAID', label: 'Planejado' },
    { paidCents: 80_000, settlementStatus: 'PAID', label: 'Pago' },
  ] as const)('respeita o estado canônico $settlementStatus, sem bloquear resumo inicial', async ({ paidCents, settlementStatus, label }) => {
    apiMock.get.mockResolvedValue({ items: [makeExpense({
      titulo: 'Contrato sintético', valor: 80_000, valorTotal: 80_000, quantidade: 1,
      status: 'PLANEJADO', formaPagamento: 'PARCELADO', quantidadeParcela: 1,
      dataPagamento: null, dataInicioParcela: '2026-07-10',
      installmentSettlements: [{
        parcelaIndex: 0, dueDate: '2026-07-10T00:00:00.000Z',
        contractedCents: 80_000, paidCents, remainingCents: 80_000 - paidCents,
        settlementStatus,
      }],
    })], total: 1 });
    const { container } = renderTab();
    const card = await screen.findByRole('article', { name: 'Contrato sintético' });
    expect(within(card).getByText(label)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Editar' }));
    if (paidCents) {
      expect(getValorInput(container)).toBeDisabled();
    } else {
      expect(getValorInput(container)).toBeEnabled();
      fireEvent.change(getValorInput(container), { target: { value: '900,00' } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith(
        '/projects/p1/expenses/exp-1', expect.objectContaining({ valor: 900 }),
      ));
    }
  });

  it.each([
    { projectType: ProjectType.CASA, paidCents: 40_000, remainingCents: 40_000, settlementStatus: 'PARTIAL', paid: 'R$ 1.200,00', remaining: 'R$ 400,00', label: 'Parcial' },
    { projectType: ProjectType.CARRO, paidCents: 40_000, remainingCents: 40_000, settlementStatus: 'PARTIAL', paid: 'R$ 1.200,00', remaining: 'R$ 400,00', label: 'Parcial' },
    { projectType: ProjectType.CASA, paidCents: 80_000, remainingCents: 0, settlementStatus: 'PAID', paid: 'R$ 1.600,00', remaining: 'R$ 0,00', label: 'Pago' },
    { projectType: ProjectType.CARRO, paidCents: 80_000, remainingCents: 0, settlementStatus: 'PAID', paid: 'R$ 1.600,00', remaining: 'R$ 0,00', label: 'Pago' },
    { projectType: ProjectType.CASA, paidCents: 0, remainingCents: 80_000, settlementStatus: 'UNPAID', paid: 'R$ 800,00', remaining: 'R$ 800,00', label: 'Parcial' },
    { projectType: ProjectType.CARRO, paidCents: 0, remainingCents: 80_000, settlementStatus: 'UNPAID', paid: 'R$ 800,00', remaining: 'R$ 800,00', label: 'Parcial' },
  ] as const)('#702-X3 renders the whole mixed contract in $projectType ($settlementStatus)', async ({ projectType, paidCents, remainingCents, settlementStatus, paid, remaining, label }) => {
    const expense = {
      ...makeExpense({
        titulo: 'Contrato misto', valor: 160_000, valorTotal: 160_000, quantidade: 1,
        status: settlementStatus === 'PAID' ? 'PAGO' : 'PLANEJADO',
        formaPagamento: 'PARCELADO', quantidadeParcela: 2,
        dataPagamento: null, dataInicioParcela: '2026-07-10',
        installmentSettlements: [{
          parcelaIndex: 1, dueDate: '2026-08-10', contractedCents: 80_000,
          paidCents, remainingCents, settlementStatus,
        }],
      }),
      paidParcelas: settlementStatus === 'PAID' ? '[0,1]' : '[0]',
    };
    apiMock.get.mockResolvedValue({ items: [expense], total: 1 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AvulsasTab projectId="p1" projectType={projectType} />
      </QueryClientProvider>,
    );
    const card = await screen.findByRole('article', { name: 'Contrato misto' });
    const row = screen.getByRole('row', { name: /Contrato misto/ });
    fireEvent.click(within(card).getByRole('button', { name: 'Editar' }));
    const balance = screen.getByRole('region', { name: 'Saldo da despesa' });
    for (const surface of [card, row, balance]) {
      expect(within(surface).getByText(label)).toBeInTheDocument();
      expect(within(surface).getByText(/Contratado:/)).toHaveTextContent('R$ 1.600,00');
      expect(within(surface).getByText(/Pago:/)).toHaveTextContent(paid);
      expect(within(surface).getByText(/Restante:/)).toHaveTextContent(remaining);
    }
    expect(apiMock.patch).not.toHaveBeenCalled();
  });
});
