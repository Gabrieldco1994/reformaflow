import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VinculoBasket } from './VinculoBasket';
import {
  useNovaDespesaWizard,
  makeInitialWizardState,
} from '../_hooks/useNovaDespesaWizard';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => apiGet(path),
    post: (path: string, body: unknown) => apiPost(path, body),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CROSS = [
  {
    id: 'valid-1',
    titulo: 'Piso porcelanato',
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valorTotal: 8000,
    status: 'PLANEJADO',
    project: { id: 'p2', name: 'Reforma A', type: 'REFORMA' },
  },
  {
    id: 'same-1',
    titulo: 'Mesmo projeto',
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valorTotal: 3000,
    status: 'PLANEJADO',
    project: { id: 'p1', name: 'Fonte', type: 'PESSOAL' },
  },
  {
    id: 'neutral-1',
    titulo: 'Pagamento fatura',
    tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
    valorTotal: 9000,
    status: 'PLANEJADO',
    project: { id: 'p2', name: 'Reforma A', type: 'REFORMA' },
  },
];

function routeApi(path: string) {
  if (path.includes('cross-project')) return Promise.resolve(CROSS);
  if (path === '/projects') {
    return Promise.resolve([{ id: 'p2', name: 'Reforma A', type: 'REFORMA', rooms: [] }]);
  }
  return Promise.resolve([]);
}

function Harness() {
  const { state, dispatch, guards, totals } = useNovaDespesaWizard(
    makeInitialWizardState('PLANEJAR'),
  );
  useEffect(() => {
    dispatch({
      type: 'SET_DRAFT',
      patch: { valor: '100', quantidade: '1', tipoDespesa: 'MATERIAL_CONSTRUCAO', titulo: 'Fonte' },
    });
    dispatch({ type: 'GO_BASKET' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <VinculoBasket
      projectId="p1"
      draft={state.draft}
      basket={state.basket}
      totals={totals}
      canSave={guards.canSaveBasket()}
      dispatch={dispatch}
      onConfirm={vi.fn()}
      saving={false}
    />
  );
}

function renderBasket() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe('VinculoBasket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockImplementation(routeApi);
  });

  it('oculta candidatos do mesmo projeto e neutros; mostra os válidos', async () => {
    renderBasket();
    expect(await screen.findByText('Piso porcelanato')).toBeInTheDocument();
    expect(screen.queryByText('Mesmo projeto')).toBeNull();
    expect(screen.queryByText('Pagamento fatura')).toBeNull();
  });

  it('adicionar existente + nova, fechar a sobra habilita salvar (reaisToCents no input)', async () => {
    const { container } = renderBasket();
    // Adiciona o alvo existente.
    fireEvent.click(await screen.findByText('Piso porcelanato'));

    // Adiciona um alvo NOVO via LinkedExpenseFields.
    fireEvent.click(screen.getByRole('button', { name: /Criar nova despesa/i }));
    const projSelect = container.querySelector('[name="targetProjectId"]') as HTMLSelectElement;
    fireEvent.change(projSelect, { target: { value: 'p2' } });
    fireEvent.click(await screen.findByRole('button', { name: /Adicionar ao cesto/i }));

    // Aloca 40,00 no existente (reaisToCents → 4000 centavos).
    const existingInput = screen.getByLabelText(/Valor real de Piso porcelanato/i) as HTMLInputElement;
    fireEvent.change(existingInput, { target: { value: '40' } });

    // Botão salvar ainda desabilitado (sobra != 0).
    const saveBtn = screen.getByRole('button', { name: /Realizar vínculo/i });
    expect(saveBtn).toBeDisabled();

    // Preenche a sobra no alvo novo.
    const sobraBtns = screen.getAllByRole('button', { name: /^sobra$/i });
    fireEvent.click(sobraBtns[sobraBtns.length - 1]);

    await waitFor(() => expect(saveBtn).not.toBeDisabled());
  });
});
