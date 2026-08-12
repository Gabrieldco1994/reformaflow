import { describe, it, expect, vi, beforeEach } from 'vitest';
import type React from 'react';
import { render, screen } from '@testing-library/react';
import { ExpenseFormModal } from './ExpenseFormModal';
import type { RateioDetalhe } from '../_hooks/useRateioDetalhe';

// VinculosFields usa react-query (useQuery) e é irrelevante para o contrato
// de campos/nomes que este teste de regressão protege — mockamos com um stub
// que registra as props recebidas (usado para o contrato de lock do rateio).
const vinculosPropsSpy = vi.fn();
vi.mock('./VinculosFields', () => ({
  VinculosFields: (props: unknown) => {
    vinculosPropsSpy(props);
    return null;
  },
}));

// useRateioDetalhe é testado isoladamente (useRateioDetalhe.test.tsx); aqui
// controlamos o retorno para exercitar a integração da seção compartilhada.
const useRateioDetalheMock = vi.fn();
vi.mock('../_hooks/useRateioDetalhe', () => ({
  useRateioDetalhe: (...args: unknown[]) => useRateioDetalheMock(...args),
}));

function mockRateio(overrides: Partial<{
  data: RateioDetalhe | undefined;
  isLoading: boolean;
  isError: boolean;
}> = {}) {
  useRateioDetalheMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  });
}

const noop = () => {};

const baseProps = {
  open: true,
  onClose: noop,
  onSubmit: noop,
  editing: null,
  formStatus: 'PLANEJADO' as const,
  tipoDespesa: 'MATERIAL',
  setTipoDespesa: noop,
  formaPagamento: 'A_VISTA',
  setFormaPagamento: noop,
  valor: '',
  setValor: noop,
  quantidade: '1',
  setQuantidade: noop,
  valorTotal: 0,
  titulo: '',
  setTitulo: noop,
  fornecedor: '',
  setFornecedor: noop,
  categoriaMaoDeObra: '',
  setCategoriaMaoDeObra: noop,
  dataPagamento: '',
  setDataPagamento: noop,
  dataInicioParcela: '',
  setDataInicioParcela: noop,
  formVinculos: { creditCardId: '', bankAccountId: '', linkedExpenseId: '' },
  setFormVinculos: noop,
  projectId: 'p1',
  showRooms: true,
  tipoDespesaOptions: [
    { value: 'MATERIAL', label: 'Material' },
    { value: 'MAO_DE_OBRA', label: 'Mão de Obra' },
  ],
  roomOptions: [{ value: 'r1', label: 'Cozinha' }],
  isPending: false,
};

function renderModal(overrides: Partial<React.ComponentProps<typeof ExpenseFormModal>> = {}) {
  return render(<ExpenseFormModal {...baseProps} {...overrides} />);
}

function names(container: HTMLElement, name: string) {
  return container.querySelectorAll(`[name="${name}"]`);
}

describe('ExpenseFormModal — contrato de campos (regressão)', () => {
  beforeEach(() => {
    vinculosPropsSpy.mockClear();
    useRateioDetalheMock.mockReset();
    mockRateio();
  });

  it('renderiza os inputs base com os name= corretos', () => {
    const { container } = renderModal();
    for (const name of ['tipoDespesa', 'valor', 'quantidade', 'titulo', 'formaPagamento', 'dataCompra']) {
      expect(names(container, name).length).toBeGreaterThan(0);
    }
  });

  it('com forma A_VISTA aparece dataPagamento e não aparecem campos de parcela', () => {
    const { container } = renderModal({ formaPagamento: 'A_VISTA' });
    expect(names(container, 'dataPagamento').length).toBe(1);
    expect(names(container, 'quantidadeParcela').length).toBe(0);
    expect(names(container, 'dataInicioParcela').length).toBe(0);
  });

  it('com forma PARCELADO aparecem parcelas e não aparece dataPagamento', () => {
    const { container } = renderModal({ formaPagamento: 'PARCELADO' });
    expect(names(container, 'quantidadeParcela').length).toBe(1);
    expect(names(container, 'dataInicioParcela').length).toBe(1);
    expect(names(container, 'dataPagamento').length).toBe(0);
  });

  it('com showRooms=true aparece roomId; com showRooms=false (Visão Conta) não aparece', () => {
    const { container } = renderModal({ showRooms: true });
    expect(names(container, 'roomId').length).toBe(1);

    const { container: c2 } = renderModal({ showRooms: false });
    expect(names(c2, 'roomId').length).toBe(0);
  });

  it('allowRecorrente=true + forma single mostra checkbox recorrente; false não mostra', () => {
    const { container } = renderModal({ allowRecorrente: true, formaPagamento: 'A_VISTA' });
    expect(names(container, 'recorrente').length).toBe(1);

    const { container: c2 } = renderModal({ allowRecorrente: false, formaPagamento: 'A_VISTA' });
    expect(names(c2, 'recorrente').length).toBe(0);
  });

  it('recorrente não aparece com forma parcelada mesmo com allowRecorrente', () => {
    const { container } = renderModal({ allowRecorrente: true, formaPagamento: 'PARCELADO' });
    expect(names(container, 'recorrente').length).toBe(0);
  });

  it('tipoDespesa=MAO_DE_OBRA mostra categoriaMaoDeObra', () => {
    const { container } = renderModal({ tipoDespesa: 'MAO_DE_OBRA' });
    expect(names(container, 'categoriaMaoDeObra').length).toBe(1);

    const { container: c2 } = renderModal({ tipoDespesa: 'MATERIAL' });
    expect(names(c2, 'categoriaMaoDeObra').length).toBe(0);
  });
});

const RATEIO_DETALHE: RateioDetalhe = {
  sourceExpenseId: 'exp-1',
  rateado: true,
  totalSourceCents: 10000,
  rateadoCents: 10000,
  sobraCents: 0,
  removedTargetsCount: 0,
  hiddenTargetsCount: 0,
  hiddenAllocationCents: 0,
  items: [
    {
      targetExpenseId: 'tgt-1',
      titulo: 'Piso',
      fornecedor: null,
      projectId: 'p2',
      projectName: 'Reforma A',
      projectType: 'REFORMA',
      allocationCents: 10000,
      plannedValorTotalCents: 15000,
      status: 'PLANEJADO',
    },
  ],
};

describe('ExpenseFormModal — seção de detalhe do rateio (compartilhada)', () => {
  beforeEach(() => {
    vinculosPropsSpy.mockClear();
    useRateioDetalheMock.mockReset();
  });

  it('sem despesa em edição, não consulta o rateio e não mostra a seção', () => {
    mockRateio();
    renderModal({ editing: null });
    expect(screen.queryByText('Compra rateada')).not.toBeInTheDocument();
  });

  it('editando despesa rateada (rateado=true), mostra a seção com os itens', () => {
    mockRateio({ data: RATEIO_DETALHE });
    renderModal({ editing: { id: 'exp-1' } as never });
    expect(screen.getByText('Compra rateada')).toBeInTheDocument();
    expect(screen.getByText('Piso')).toBeInTheDocument();
    expect(vinculosPropsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ lockLinkedExpense: true }),
    );
  });

  it('editando despesa não rateada (rateado=false), não mostra a seção e não trava VinculosFields', () => {
    mockRateio({ data: { ...RATEIO_DETALHE, rateado: false, items: [] } });
    renderModal({ editing: { id: 'exp-2' } as never });
    expect(screen.queryByText('Compra rateada')).not.toBeInTheDocument();
    expect(vinculosPropsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ lockLinkedExpense: false }),
    );
  });

  it('enquanto carrega o rateio, mostra estado de loading explícito', () => {
    mockRateio({ isLoading: true });
    renderModal({ editing: { id: 'exp-3' } as never });
    expect(screen.getByText(/carregando rateio/i)).toBeInTheDocument();
  });

  it('em erro, mostra retry acionável', () => {
    mockRateio({ isError: true });
    renderModal({ editing: { id: 'exp-4' } as never });
    expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
  });
});
