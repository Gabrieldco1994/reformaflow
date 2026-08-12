import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VinculosFields } from './VinculosFields';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGet(path),
  },
}));

function renderFields(props: Partial<React.ComponentProps<typeof VinculosFields>> = {}) {
  apiGet.mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
