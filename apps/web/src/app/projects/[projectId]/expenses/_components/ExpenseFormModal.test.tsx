import { describe, it, expect, vi } from 'vitest';
import type React from 'react';
import { render } from '@testing-library/react';
import { ExpenseFormModal } from './ExpenseFormModal';

// VinculosFields usa react-query (useQuery) e é irrelevante para o contrato
// de campos/nomes que este teste de regressão protege — mockamos com um stub.
vi.mock('./VinculosFields', () => ({
  VinculosFields: () => null,
}));

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
