import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Expense } from '@/types';
import type { RateioDetalhe, RateioDetalheItem } from '../_hooks/useRateioDetalhe';
import { RatearCompraModal } from './RatearCompraModal';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (path: string) => apiGet(path) },
}));

// Fonte PESSOAL de R$12.771,00, rateada entre 9 planejadas de R$1.419,00 cada
// (12.771 / 9 = 1.419 exatos).
const SOURCE: Expense = {
  id: 'source-1',
  tipoDespesa: 'MATERIAL_CONSTRUCAO',
  valor: 1_277_100,
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

const NO_RATEIO: RateioDetalhe = {
  sourceExpenseId: SOURCE.id,
  rateado: false,
  totalSourceCents: SOURCE.valorTotal,
  rateadoCents: 0,
  sobraCents: SOURCE.valorTotal,
  removedTargetsCount: 0,
  hiddenTargetsCount: 0,
  hiddenAllocationCents: 0,
  items: [],
};

function makeItem(index: number, allocationCents = 141_900): RateioDetalheItem {
  return {
    targetExpenseId: `target-${index}`,
    titulo: `Planejada ${index}`,
    fornecedor: null,
    projectId: 'p2',
    projectName: 'Reforma A',
    projectType: 'REFORMA',
    allocationCents,
    plannedValorTotalCents: 141_900,
    status: 'PLANEJADO',
  };
}

function makeRateio(
  items: RateioDetalheItem[],
  overrides: Partial<RateioDetalhe> = {},
): RateioDetalhe {
  const rateadoCents = items.reduce((sum, item) => sum + item.allocationCents, 0);
  return {
    ...NO_RATEIO,
    rateado: true,
    rateadoCents,
    sobraCents: SOURCE.valorTotal - rateadoCents,
    items,
    ...overrides,
  };
}

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderModal({
  source = SOURCE,
  client = createClient(),
}: {
  source?: Expense;
  client?: QueryClient;
} = {}) {
  const onSubmit = vi.fn();
  const onDesratear = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <RatearCompraModal
        open
        onClose={vi.fn()}
        source={source}
        ownerProjectId="p1"
        onSubmit={onSubmit}
        onDesratear={onDesratear}
      />
    </QueryClientProvider>,
  );
  return { ...utils, client, onSubmit, onDesratear };
}

describe('RatearCompraModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio') ? Promise.resolve(NO_RATEIO) : Promise.resolve(TARGETS),
    );
  });

  it('precarrega um rateio existente com o valor exato e envia o conjunto completo', async () => {
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio')
        ? Promise.resolve(
            makeRateio([
              {
                ...makeItem(1, SOURCE.valorTotal),
                plannedValorTotalCents: null,
              },
            ]),
          )
        : Promise.resolve(TARGETS),
    );

    const { onSubmit } = renderModal();

    const input = await screen.findByDisplayValue('12.771,00');
    expect(screen.getByText(/planejado R\$ 12\.771,00/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Salvar rateio/i }));

    expect(onSubmit).toHaveBeenCalledWith([
      { targetExpenseId: 'target-1', allocation: SOURCE.valorTotal },
    ]);
  });

  it('precarrega todas as N alocações existentes com valores exatos e envia todas', async () => {
    const items = TARGETS.map((_, index) => makeItem(index + 1));
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio') ? Promise.resolve(makeRateio(items)) : Promise.resolve(TARGETS),
    );

    const { onSubmit } = renderModal();

    await waitFor(() => expect(screen.getAllByDisplayValue('1.419,00')).toHaveLength(9));
    fireEvent.click(screen.getByRole('button', { name: /Salvar rateio/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual(
      items.map((item) => ({
        targetExpenseId: item.targetExpenseId,
        allocation: item.allocationCents,
      })),
    );
  });

  it('abre vazio para rateado=false e não oferece Desfazer', async () => {
    renderModal();

    expect(await screen.findByPlaceholderText(/Buscar planejada/i)).toBeInTheDocument();
    expect(screen.queryByTitle('Remover')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Desfazer rateio/i })).not.toBeInTheDocument();
  });

  it('mostra carregamento explícito sem renderizar o editor vazio', () => {
    apiGet.mockImplementation(
      (path: string) =>
        path.endsWith('/rateio')
          ? new Promise<RateioDetalhe>(() => undefined)
          : Promise.resolve(TARGETS),
    );

    renderModal();

    expect(screen.getByText(/Carregando rateio da compra/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Buscar planejada/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Salvar rateio/i })).not.toBeInTheDocument();
  });

  it('aguarda o detalhe atual antes de hidratar o editor quando há cache antigo', async () => {
    const cached = makeRateio([{ ...makeItem(1, SOURCE.valorTotal), titulo: 'Cache antigo' }]);
    const fresh = makeRateio([makeItem(1, 500_000), makeItem(2, 777_100)]);
    let resolveDetail!: (detail: RateioDetalhe) => void;
    const currentDetail = new Promise<RateioDetalhe>((resolve) => {
      resolveDetail = resolve;
    });
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio') ? currentDetail : Promise.resolve(TARGETS),
    );
    const client = createClient();
    client.setQueryData(['rateio-detalhe', 'p1', SOURCE.id], cached);

    renderModal({ client });

    expect(screen.getByText(/Carregando rateio da compra/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('12.771,00')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Buscar planejada/i)).not.toBeInTheDocument();

    resolveDetail(fresh);

    expect(await screen.findByDisplayValue('5.000,00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('7.771,00')).toBeInTheDocument();
    expect(screen.queryByText('Cache antigo')).not.toBeInTheDocument();
  });

  it('mostra erro sem editor e permite tentar novamente', async () => {
    let attempts = 0;
    apiGet.mockImplementation((path: string) => {
      if (!path.endsWith('/rateio')) return Promise.resolve(TARGETS);
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('falhou')) : Promise.resolve(NO_RATEIO);
    });
    const client = createClient();
    client.setQueryData(
      ['rateio-detalhe', 'p1', SOURCE.id],
      makeRateio([makeItem(1, SOURCE.valorTotal)]),
    );

    renderModal({ client });

    const retry = await screen.findByRole('button', { name: /Tentar novamente/i });
    expect(screen.queryByDisplayValue('12.771,00')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Buscar planejada/i)).not.toBeInTheDocument();
    fireEvent.click(retry);

    expect(await screen.findByPlaceholderText(/Buscar planejada/i)).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('não oferece na busca um alvo que já veio preenchido no rateio', async () => {
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio')
        ? Promise.resolve(makeRateio([makeItem(1, SOURCE.valorTotal)]))
        : Promise.resolve([TARGETS[0], TARGETS[1]]),
    );
    renderModal();

    fireEvent.focus(await screen.findByPlaceholderText(/Buscar planejada/i));

    expect(await screen.findByRole('button', { name: /^Planejada 2 /i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Planejada 1 /i })).not.toBeInTheDocument();
  });

  it.each([
    ['ocultas', { hiddenTargetsCount: 1, hiddenAllocationCents: 277_100 }],
    ['removidas', { removedTargetsCount: 1 }],
  ])('bloqueia edição destrutiva quando há alocações %s e mantém Desfazer', async (_, counts) => {
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio')
        ? Promise.resolve(makeRateio([makeItem(1, 1_000_000)], counts))
        : Promise.resolve(TARGETS),
    );
    const { onSubmit } = renderModal();

    const allocationInput = await screen.findByDisplayValue('10.000,00');
    expect(allocationInput).toBeDisabled();
    expect(screen.getByPlaceholderText(/Buscar planejada/i)).toBeDisabled();
    expect(screen.getByTitle('Preencher com a sobra')).toBeDisabled();
    expect(screen.getByTitle('Remover')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Salvar rateio/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Desfazer rateio/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Salvar rateio/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('não sobrescreve uma edição local quando o detalhe é reconsultado', async () => {
    let detail = makeRateio([
      {
        ...makeItem(1, SOURCE.valorTotal),
        plannedValorTotalCents: null,
      },
    ]);
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio') ? Promise.resolve(detail) : Promise.resolve(TARGETS),
    );
    const client = createClient();
    renderModal({ client });

    const input = await screen.findByDisplayValue('12.771,00');
    fireEvent.change(input, { target: { value: '12.000,00' } });
    detail = makeRateio([{ ...makeItem(1, SOURCE.valorTotal), titulo: 'Atualizada no servidor' }]);

    await act(async () => {
      await client.refetchQueries({ queryKey: ['rateio-detalhe', 'p1', SOURCE.id] });
    });

    expect(screen.getByDisplayValue('12.000,00')).toBeInTheDocument();
    expect(screen.queryByText('Atualizada no servidor')).not.toBeInTheDocument();
  });

  it('deduplica a seleção repetida do mesmo alvo dentro da atualização funcional', async () => {
    renderModal();

    const search = await screen.findByPlaceholderText(/Buscar planejada/i);
    fireEvent.focus(search);
    const button = await screen.findByText('Planejada 1');
    fireEvent.click(button);
    fireEvent.click(button);

    expect(screen.getAllByTitle('Remover')).toHaveLength(1);
  });
});

describe('RatearCompraModal — parser de dinheiro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation((path: string) =>
      path.endsWith('/rateio') ? Promise.resolve(NO_RATEIO) : Promise.resolve(TARGETS),
    );
  });

  it('sugere e salva 141900 centavos por alvo ao distribuir R$12.771,00 entre 9 planejadas de R$1.419,00 (nunca 14190000)', async () => {
    const { onSubmit } = renderModal();

    const search = await screen.findByPlaceholderText(/Buscar planejada/i);

    for (let i = 1; i <= 9; i++) {
      fireEvent.focus(search);
      const label = `Planejada ${i}`;
      // eslint-disable-next-line no-await-in-loop
      const button = await screen.findByText(label);
      fireEvent.click(button);
    }

    const inputs = screen.getAllByRole('textbox').filter(
      (el) => (el as HTMLInputElement).value.length > 0 && el !== search,
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

    const search = await screen.findByPlaceholderText(/Buscar planejada/i);
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
