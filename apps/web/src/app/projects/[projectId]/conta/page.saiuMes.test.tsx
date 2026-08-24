import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ContaPage from './page';
import type { AccountViewResponse } from './_types';

const useQueryMock = vi.fn();
const useQueryClientMock = vi.fn(() => ({ invalidateQueries: vi.fn() }));
const resumoCardsMock = vi.fn();
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
  useQueryClient: () => useQueryClientMock(),
}));

vi.mock('@/app/_components/LoadingBlock', () => ({ LoadingBlock: () => null }));
vi.mock('./_components/ContaMonthPicker', () => ({ ContaMonthPicker: () => null }));
vi.mock('./_components/CartoesSection', () => ({ CartoesSection: () => null }));
vi.mock('./_components/BankAccountsSection', () => ({ default: () => null }));
vi.mock('../monthly/_cockpit/PendenciasQueueCard', () => ({ PendenciasQueueCard: () => null }));
vi.mock('../expenses/_components/NovaDespesaLauncher', () => ({ NovaDespesaLauncher: () => null }));
vi.mock('./_components/ContaQuickActions', () => ({ ContaQuickActions: () => null }));
vi.mock('./_components/PagarFaturaDialog', () => ({ PagarFaturaDialog: () => null }));
vi.mock('./_components/UndoInvoicePaymentDialog', () => ({ UndoInvoicePaymentDialog: () => null }));
vi.mock('./_components/InvoiceInterventionDialog', () => ({ InvoiceInterventionDialog: () => null }));
vi.mock('./_components/MovimentacoesSection', () => ({
  MovimentacoesSection: (props: Record<string, unknown>) => {
    movimentacoesSectionMock(props);
    return null;
  },
}));
vi.mock('./_components/ResumoCards', () => ({
  ResumoCards: (props: Record<string, unknown>) => {
    resumoCardsMock(props);
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
        id: 'paid',
        kind: 'saida',
        descricao: 'Pago',
        data: '2026-07-10T00:00:00.000Z',
        forma: 'debito',
        valor: 10_000,
        realizado: true,
        status: 'PAGO',
        cardLast4: null,
        bankLast4: null,
        tipoDespesa: 'MERCADO',
        isInvoice: false,
        editavel: true,
        dueMonth: null,
        projetoOrigem: null,
      },
      {
        id: 'planned',
        kind: 'saida',
        descricao: 'Planejado',
        data: '2026-07-11T00:00:00.000Z',
        forma: 'pix',
        valor: 12_000,
        realizado: false,
        status: 'PLANEJADO',
        cardLast4: null,
        bankLast4: null,
        tipoDespesa: 'MORADIA',
        isInvoice: false,
        editavel: true,
        dueMonth: null,
        projetoOrigem: null,
      },
    ],
    comprasCartao: [
      {
        id: 'card-purchase',
        kind: 'saida',
        descricao: 'Cartão',
        data: '2026-07-12T00:00:00.000Z',
        forma: 'cartao',
        valor: 6_000,
        realizado: true,
        status: 'PAGO',
        cardLast4: '4242',
        bankLast4: null,
        tipoDespesa: 'MERCADO',
        isInvoice: false,
        editavel: true,
        dueMonth: '2026-08',
        projetoOrigem: null,
      },
    ],
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

describe('ContaPage', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    resumoCardsMock.mockReset();
    movimentacoesSectionMock.mockReset();
  });

  it('deriva o card mensal da mesma lista do drilldown, sem usar saiuMes realizado-only', () => {
    const data = accountResponse();
    useQueryMock.mockImplementation(({ queryKey }: { queryKey: readonly unknown[] }) => {
      if (queryKey[0] === 'account-view') return { data, isLoading: false, error: null };
      if (queryKey[0] === 'dre-overview') return { data: null, isLoading: false, error: null };
      return { data: [], isLoading: false, error: null };
    });

    render(<ContaPage />);

    expect(resumoCardsMock).toHaveBeenCalledTimes(1);
    expect(resumoCardsMock.mock.calls[0]?.[0]).toMatchObject({ saiuMes: 22_000 });
    expect(movimentacoesSectionMock).toHaveBeenCalledTimes(1);
    expect(
      (movimentacoesSectionMock.mock.calls[0]?.[0] as { data: AccountViewResponse }).data.comprasCartao,
    ).toHaveLength(1);
    expect(
      (movimentacoesSectionMock.mock.calls[0]?.[0] as { data: AccountViewResponse }).data.saidas.map(
        (item) => item.status,
      ),
    ).toEqual(['PAGO', 'PLANEJADO']);
  });
});
