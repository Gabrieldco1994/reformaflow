import { render, act, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ContaPage from './page';
import type { AccountViewResponse } from './_types';

/**
 * #575 — o quick filter do resumo não pode zerar o filtro de conta.
 *
 * Este arquivo renderiza a PÁGINA REAL e captura as props que ela entrega aos
 * filhos. A versão anterior deste teste reimplementava o `useState` da página
 * dentro do próprio teste e afirmava sobre essa cópia — passaria intacta com o
 * defeito de volta em `page.tsx`. Não repita esse padrão: o que precisa ser
 * observado é o callback que a página monta, não um sósia dele.
 *
 * `setOriginFilter(null)` aparece três vezes em `page.tsx`. Só a de
 * `onQuickFilterSelect` é defeito — as outras duas limpam o filtro ao trocar
 * mês/ano, onde limpar é correto (a conta pode não existir no outro recorte).
 * Por isso o segundo teste trava a troca de visão: se alguém "consertar"
 * removendo as três, ele fica vermelho.
 */

const useQueryMock = vi.fn();
const resumoCardsMock = vi.fn();
const cartoesSectionMock = vi.fn();
const movimentacoesSectionMock = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'p1' }),
  usePathname: () => '/projects/p1/conta',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/contexts/project-context', () => ({
  useProject: () => ({ projectId: 'p1', projectType: 'PESSOAL', projectName: 'Pessoal' }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/app/_components/LoadingBlock', () => ({ LoadingBlock: () => null }));
vi.mock('./_components/ContaMonthPicker', () => ({ ContaMonthPicker: () => null }));
vi.mock('./_components/BankAccountsSection', () => ({ default: () => null }));
vi.mock('./_components/ContaAnoView', () => ({ ContaAnoView: () => null }));
vi.mock('../monthly/_cockpit/PendenciasQueueCard', () => ({ PendenciasQueueCard: () => null }));
vi.mock('../expenses/_components/NovaDespesaLauncher', () => ({ NovaDespesaLauncher: () => null }));
vi.mock('./_components/ContaQuickActions', () => ({ ContaQuickActions: () => null }));
vi.mock('./_components/PagarFaturaDialog', () => ({ PagarFaturaDialog: () => null }));
vi.mock('./_components/UndoInvoicePaymentDialog', () => ({ UndoInvoicePaymentDialog: () => null }));
vi.mock('./_components/InvoiceInterventionDialog', () => ({ InvoiceInterventionDialog: () => null }));

vi.mock('./_components/CartoesSection', () => ({
  CartoesSection: (props: Record<string, unknown>) => {
    cartoesSectionMock(props);
    return null;
  },
}));
vi.mock('./_components/ResumoCards', () => ({
  ResumoCards: (props: Record<string, unknown>) => {
    resumoCardsMock(props);
    return null;
  },
}));
vi.mock('./_components/MovimentacoesSection', () => ({
  MovimentacoesSection: (props: Record<string, unknown>) => {
    movimentacoesSectionMock(props);
    return null;
  },
}));
function accountResponse(): AccountViewResponse {
  return {
    mesSelecionado: '2026-07',
    caixaHoje: 100_000,
    carteiraHoje: 0,
    entrouMes: 0,
    saiuMes: 10_000,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 90_000,
    devoCartaoTotal: 0,
    cartoes: [],
    contas: [],
    saidas: [
      {
        id: 'saida-1',
        kind: 'saida',
        descricao: 'Mercado',
        data: '2026-07-10T00:00:00.000Z',
        forma: 'debito',
        valor: 10_000,
        realizado: true,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: '3344',
        tipoDespesa: 'MERCADO',
        isInvoice: false,
        editavel: true,
        dueMonth: null,
        projetoOrigem: null,
      },
    ],
    comprasCartao: [],
    entradas: [],
    ticketMedio: {
      valor: 0,
      nCompras: 0,
      totalCompras: 0,
      serie6m: [],
      media6m: 0,
      deltaVsMediaPct: null,
    },
  };
}

function lastProps(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function renderConta() {
  const data = accountResponse();
  useQueryMock.mockImplementation(({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === 'account-view') return { data, isLoading: false, error: null };
    if (queryKey[0] === 'dre-overview') return { data: null, isLoading: false, error: null };
    return { data: [], isLoading: false, error: null };
  });
  render(<ContaPage />);
}

describe('ContaPage — composição de filtros (#575)', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    resumoCardsMock.mockReset();
    cartoesSectionMock.mockReset();
    movimentacoesSectionMock.mockReset();
  });

  it('mantém o filtro de conta ao selecionar um quick filter do resumo', () => {
    renderConta();

    act(() => {
      (lastProps(cartoesSectionMock).onSelect as (v: string) => void)('3344');
    });
    expect(lastProps(movimentacoesSectionMock).originFilter).toBe('3344');

    act(() => {
      (lastProps(resumoCardsMock).onQuickFilterSelect as (k: string) => void)('saiu');
    });

    // O defeito era zerar `originFilter` aqui. Os dois filtros compõem.
    expect(lastProps(movimentacoesSectionMock).originFilter).toBe('3344');
    expect(lastProps(movimentacoesSectionMock).summaryQuickFilter).toBe('saiu');
  });

  it('continua limpando o filtro de conta ao trocar mês/ano', () => {
    renderConta();

    act(() => {
      (lastProps(cartoesSectionMock).onSelect as (v: string) => void)('3344');
    });
    expect(lastProps(movimentacoesSectionMock).originFilter).toBe('3344');

    // Ida e volta pelo seletor real de período: as duas chamadas a
    // `setOriginFilter(null)` das linhas 166/178 têm de continuar vivas.
    fireEvent.click(screen.getByRole('button', { name: 'Ano todo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mês' }));

    // Limpar aqui é intencional: a conta pode não existir no outro recorte.
    expect(lastProps(movimentacoesSectionMock).originFilter).toBeNull();
  });
});
