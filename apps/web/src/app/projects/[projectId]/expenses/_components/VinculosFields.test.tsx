import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VinculosFields } from './VinculosFields';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGet(path),
  },
}));

function renderFields(
  props: Partial<React.ComponentProps<typeof VinculosFields>> = {},
  crossExpenses: unknown[] = [],
) {
  apiGet.mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['cross-project-expenses', 'p1', ''], crossExpenses);
  const baseValue = {
    creditCardId: '',
    bankAccountId: '',
    linkedExpenseId: '',
  };
  return render(
    <QueryClientProvider client={client}>
      <VinculosFields projectId="p1" value={baseValue} onChange={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

describe('VinculosFields — rateado trava o vínculo cross-project', () => {
  const documented = {
    id: 'documented', titulo: 'Compra documentada', valorTotal: 20004,
    formaPagamento: 'PARCELADO', quantidadeParcela: 2,
    status: 'PLANEJADO', paidParcelas: '[0]',
    project: { id: 'p2', name: 'Obra', type: 'REFORMA' },
    schedule: {
      version: 1,
      occurrences: [
        { index: 0, parcela: '2/3', valor: 10001, data: '2026-08-10', invoiceDueMonth: '2026-11' },
        { index: 1, parcela: '3/3', valor: 10003, data: '2026-09-28', invoiceDueMonth: null },
      ],
    },
  };

  it('#701 presents the selected documented installment amount, not the expense total', () => {
    renderFields({
      value: { creditCardId: '', bankAccountId: '', linkedExpenseId: 'documented', linkedParcelaIndex: 1 },
    }, [documented]);
    expect(screen.getByText(/parcela 3\/3 · R\$\s*100,03/)).toBeInTheDocument();
  });

  it('#701 renders the printed remainder labels and selects local index 1 for 3/3', async () => {
    const onChange = vi.fn();
    renderFields({ onChange }, [documented]);
    fireEvent.focus(screen.getByPlaceholderText(/Buscar por título ou fornecedor/));
    const remaining = await screen.findByRole('button', { name: /parcela 3\/3.*100,03/ });
    expect(screen.getByRole('button', { name: /parcela 2\/3.*100,01.*PAGO/ })).toBeInTheDocument();
    fireEvent.click(remaining);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      linkedExpenseId: 'documented', linkedParcelaIndex: 1,
    }));
  });

  it('sem lockLinkedExpense e com linkedExpenseId, mostra "Remover"', () => {
    renderFields({ value: { creditCardId: '', bankAccountId: '', linkedExpenseId: 'exp-9' }, initialLinkedExpenseLabel: 'Alvo X' });
    expect(screen.getByText(/Remover/i)).toBeInTheDocument();
  });

  it('com lockLinkedExpense=true e linkedExpenseId setado, NÃO mostra "Remover" (read-only)', () => {
    renderFields({
      value: { creditCardId: '', bankAccountId: '', linkedExpenseId: 'exp-9' },
      initialLinkedExpenseLabel: 'Alvo X',
      lockLinkedExpense: true,
    });
    expect(screen.queryByText(/Remover/i)).not.toBeInTheDocument();
  });

  it('com lockLinkedExpense=true e sem linkedExpenseId, NÃO oferece buscar/criar vínculo novo', () => {
    renderFields({ value: { creditCardId: '', bankAccountId: '', linkedExpenseId: '' }, lockLinkedExpense: true });
    expect(screen.queryByPlaceholderText(/Buscar por título ou fornecedor/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Criar despesa em outro projeto/i })).not.toBeInTheDocument();
  });

  it('rateio travado (lockLinkedExpense=true) renderiza zero editores cross-project (vinculos-cross-project-editor)', () => {
    renderFields({ value: { creditCardId: '', bankAccountId: '', linkedExpenseId: '' }, lockLinkedExpense: true });
    expect(screen.queryAllByTestId('vinculos-cross-project-editor')).toHaveLength(0);
  });

  it('despesa não-rateada (lockLinkedExpense ausente) renderiza exatamente um editor cross-project visível', () => {
    renderFields({ value: { creditCardId: '', bankAccountId: '', linkedExpenseId: '' } });
    const editors = screen.getAllByTestId('vinculos-cross-project-editor');
    expect(editors).toHaveLength(1);
    expect(editors[0]).toBeVisible();
  });

  it('sem lockLinkedExpense e sem linkedExpenseId, oferece buscar vínculo normalmente', () => {
    renderFields({ value: { creditCardId: '', bankAccountId: '', linkedExpenseId: '' } });
    expect(screen.getByPlaceholderText(/Buscar por título ou fornecedor/i)).toBeInTheDocument();
  });
});
