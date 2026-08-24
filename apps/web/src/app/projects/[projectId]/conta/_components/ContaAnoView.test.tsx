import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContaAnoView } from './ContaAnoView';
import type { AccountViewYearlyResponse } from '../_types';

const mockUseQuery = vi.fn();
const mockResumoCards = vi.fn();
const mockMovimentacoesSection = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn() },
}));

vi.mock('./ResumoCards', () => ({
  ResumoCards: (props: Record<string, unknown>) => {
    mockResumoCards(props);
    return null;
  },
}));

vi.mock('./MovimentacoesSection', () => ({
  MovimentacoesSection: (props: Record<string, unknown>) => {
    mockMovimentacoesSection(props);
    return null;
  },
}));

function yearlyResponse(): AccountViewYearlyResponse {
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
        bankLast4: '1234',
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
        bankLast4: '1234',
        tipoDespesa: 'MORADIA',
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
      serie12m: [],
      mediaAnual: 0,
      deltaVsMediaPct: null,
    },
  };
}

describe('ContaAnoView', () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mockResumoCards.mockReset();
    mockMovimentacoesSection.mockReset();
  });

  it('reusa o total canônico das saídas e preserva os itens pago + planejado no drilldown', () => {
    const accountData = yearlyResponse();
    mockUseQuery.mockReturnValue({ data: accountData, isLoading: false });

    render(
      <ContaAnoView
        projectId="p1"
        year="2026"
        originFilter={null}
        onOriginFilterChange={vi.fn()}
        quickFilter={null}
        onQuickFilterChange={vi.fn()}
        onInvoiceAction={vi.fn()}
      />,
    );

    expect(mockResumoCards).toHaveBeenCalledTimes(1);
    expect(mockResumoCards.mock.calls[0]?.[0]).toMatchObject({
      period: 'ano',
      saiuMes: 22_000,
    });
    expect(mockMovimentacoesSection).toHaveBeenCalledTimes(1);
    expect(
      (mockMovimentacoesSection.mock.calls[0]?.[0] as { data: AccountViewYearlyResponse }).data.saidas.map(
        (item) => item.status,
      ),
    ).toEqual(['PAGO', 'PLANEJADO']);
  });
});
