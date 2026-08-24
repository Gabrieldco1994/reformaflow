import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RecurringBillFormModal from './RecurringBillFormModal';
import { BILL_CATEGORIES, BILL_FREQUENCIES } from '../_display';

const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => apiPostMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
  },
}));

describe('RecurringBillFormModal', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockResolvedValue({});
    apiPatchMock.mockResolvedValue({});
  });

  it('renders all 7 fields with the existing BILL_CATEGORIES/BILL_FREQUENCIES options', () => {
    render(
      <RecurringBillFormModal projectId="p1" projectType="CASA" bill={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByPlaceholderText('Nome da conta')).toBeInTheDocument();
    expect(screen.getByLabelText(/valor/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/dia vencimento/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/categoria/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/frequência/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/observações/i)).toBeInTheDocument();

    for (const c of BILL_CATEGORIES) {
      expect(screen.getByRole('option', { name: c.label })).toBeInTheDocument();
    }
    for (const f of BILL_FREQUENCIES) {
      expect(screen.getByRole('option', { name: f.label })).toBeInTheDocument();
    }
  });

  it('create mode POSTs /projects/:id/recurring-bills with the typed body, calls onSaved', async () => {
    const onSaved = vi.fn();
    render(
      <RecurringBillFormModal projectId="p1" projectType="CASA" bill={null} onClose={vi.fn()} onSaved={onSaved} />,
    );
    fireEvent.change(screen.getByPlaceholderText('Nome da conta'), { target: { value: 'Luz' } });
    fireEvent.change(screen.getByLabelText(/valor/i), { target: { value: '150,00' } });
    fireEvent.click(screen.getByRole('button', { name: /criar/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith(
      '/projects/p1/recurring-bills',
      expect.objectContaining({ nome: 'Luz', valor: 15000, categoria: 'LUZ', frequencia: 'MENSAL' }),
    ));
    expect(onSaved).toHaveBeenCalled();
  });

  it('edit mode (bill prop set) PATCHes /projects/:id/recurring-bills/:id instead', async () => {
    const onSaved = vi.fn();
    const bill = {
      id: 'bill-1',
      nome: 'Água',
      valor: 8000,
      categoria: 'AGUA',
      frequencia: 'MENSAL',
      diaVencimento: 5,
      status: 'ATIVO' as const,
      observacoes: '',
    };
    render(
      <RecurringBillFormModal projectId="p1" projectType="CASA" bill={bill} onClose={vi.fn()} onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(apiPatchMock).toHaveBeenCalledWith(
      '/projects/p1/recurring-bills/bill-1',
      expect.objectContaining({ nome: 'Água' }),
    ));
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('bare=true renders without the fixed inset-0 overlay; bare=false (default) renders with it', () => {
    const { container, unmount } = render(
      <RecurringBillFormModal projectId="p1" projectType="CASA" bill={null} onClose={vi.fn()} onSaved={vi.fn()} bare />,
    );
    expect(container.querySelector('.fixed.inset-0')).not.toBeInTheDocument();
    unmount();

    const { container: containerDefault } = render(
      <RecurringBillFormModal projectId="p1" projectType="CASA" bill={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(containerDefault.querySelector('.fixed.inset-0')).toBeInTheDocument();
  });

  it('CASA/CARRO hint banner shown only when creating (no editing bill)', () => {
    const { rerender } = render(
      <RecurringBillFormModal projectId="p1" projectType="CASA" bill={null} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText(/lance como despesa recorrente no projeto/i)).toBeInTheDocument();

    rerender(
      <RecurringBillFormModal
        projectId="p1"
        projectType="CASA"
        bill={{
          id: 'bill-1',
          nome: 'Água',
          valor: 8000,
          categoria: 'AGUA',
          frequencia: 'MENSAL',
          diaVencimento: 5,
          status: 'ATIVO',
          observacoes: '',
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByText(/lance como despesa recorrente no projeto/i)).not.toBeInTheDocument();
  });
});
