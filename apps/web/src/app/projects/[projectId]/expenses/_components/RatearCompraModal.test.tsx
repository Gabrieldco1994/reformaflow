import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RatearCompraModal } from './RatearCompraModal';
import type { Expense } from '@/types';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (path: string) => apiGet(path) },
}));

// Fonte PESSOAL de R$12.771,00, rateada entre 9 planejadas de R$1.419,00 cada
// (12.771 / 9 = 1.419 exatos).
const SOURCE: Expense = {
  id: 'source-1',
  tipoDespesa: 'MATERIAL_CONSTRUCAO',
  valor: 12771,
  quantidade: 1,
  valorTotal: 1_277_100,
  titulo: 'Compra a ratear',
  formaPagamento: 'PIX',
  status: 'PAGO',
};

const TARGETS = Array.from({ length: 9 }, (_, i) => ({
  id: `target-${i + 1}`,
  titulo: `Planejada ${i + 1}`,
  valorTotal: 141_900,
  status: 'PLANEJADO',
  project: { id: 'p2', name: 'Reforma A', type: 'REFORMA' },
}));

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSubmit = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <RatearCompraModal
        open
        onClose={vi.fn()}
        source={SOURCE}
        ownerProjectId="p1"
        onSubmit={onSubmit}
        onDesratear={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onSubmit };
}

describe('RatearCompraModal — parser de dinheiro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation(() => Promise.resolve(TARGETS));
  });

  it('sugere e salva 141900 centavos por alvo ao distribuir R$12.771,00 entre 9 planejadas de R$1.419,00 (nunca 14190000)', async () => {
    const { onSubmit } = renderModal();

    const search = screen.getByPlaceholderText(/Buscar planejada/i);

    for (let i = 1; i <= 9; i++) {
      fireEvent.focus(search);
      const label = `Planejada ${i}`;
      // eslint-disable-next-line no-await-in-loop
      const button = await screen.findByText(label);
      fireEvent.click(button);
    }

    const inputs = screen.getAllByRole('textbox').filter((el) =>
      (el as HTMLInputElement).value.length > 0 && el !== search,
    ) as HTMLInputElement[];
    expect(inputs).toHaveLength(9);
    // A sugestão automática deve corresponder ao formato aceito pelo parser
    // (nunca gerar 100x o valor por causa de heurística de milhar divergente).
    inputs.forEach((input) => expect(input.value).not.toBe(''));

    const saveBtn = screen.getByRole('button', { name: /Salvar rateio/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const allocations = onSubmit.mock.calls[0][0] as {
      targetExpenseId: string;
      allocation: number;
    }[];
    expect(allocations).toHaveLength(9);
    allocations.forEach((a) => expect(a.allocation).toBe(141_900));
    const total = allocations.reduce((s, a) => s + a.allocation, 0);
    expect(total).toBe(1_277_100);
  });

  it('preserva entrada manual em formato BR ("1.419,00" → 141900 centavos)', async () => {
    const { onSubmit } = renderModal();

    const search = screen.getByPlaceholderText(/Buscar planejada/i);
    fireEvent.focus(search);
    const button = await screen.findByText('Planejada 1');
    fireEvent.click(button);

    const input = screen.getByDisplayValue(/.+/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1.419,00' } });

    // Faltam 8 alvos para fechar a sobra; adiciona os demais com a sugestão
    // automática para poder salvar e conferir a soma exata.
    for (let i = 2; i <= 9; i++) {
      fireEvent.focus(search);
      const label = `Planejada ${i}`;
      // eslint-disable-next-line no-await-in-loop
      const btn = await screen.findByText(label);
      fireEvent.click(btn);
    }

    const saveBtn = screen.getByRole('button', { name: /Salvar rateio/i });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const allocations = onSubmit.mock.calls[0][0] as {
      targetExpenseId: string;
      allocation: number;
    }[];
    const first = allocations.find((a) => a.targetExpenseId === 'target-1');
    expect(first?.allocation).toBe(141_900);
    const total = allocations.reduce((s, a) => s + a.allocation, 0);
    expect(total).toBe(1_277_100);
  });
});
