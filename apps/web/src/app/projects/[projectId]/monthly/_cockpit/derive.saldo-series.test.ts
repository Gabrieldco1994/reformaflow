import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSaldoSeries, deriveMonth } from './derive';
import type { MonthlyOverviewResponse } from '../_types';

function makeData(): MonthlyOverviewResponse {
  return {
    mesAtual: '2026-07',
    meses: [
      {
        mes: '2026-06',
        totalDespesas: 0,
        totalRecebimentos: 0,
        despesasRealizadas: 0,
        recebimentosRealizados: 0,
        saldoMes: 0,
        saldoMesRealizado: 0,
        porOrigem: {},
        porCategoria: [],
      },
      {
        mes: '2026-07',
        totalDespesas: 0,
        totalRecebimentos: 0,
        despesasRealizadas: 0,
        recebimentosRealizados: 0,
        saldoMes: 0,
        saldoMesRealizado: 0,
        porOrigem: {},
        porCategoria: [],
      },
    ],
    comparativo: {
      current: null,
      previous: null,
      deltaDespesas: 0,
      deltaDespesasPct: null,
      deltaRecebimentos: 0,
      deltaRecebimentosPct: null,
      deltaSaldo: 0,
    },
    mesAtualEntries: [],
    entries: [
      {
        id: 'r1',
        data: '2026-07-10',
        tipo: 'RECEBIMENTO',
        status: 'EM_CAIXA',
        valor: 300_000,
        categoria: null,
        subcategoria: null,
        formaPagamento: null,
        projectId: 'p',
        projectName: 'Pessoal',
        projectType: 'PESSOAL',
      },
      {
        id: 'd1',
        data: '2026-07-12',
        tipo: 'DESPESA',
        status: 'PAGO',
        valor: 50_000,
        categoria: 'Outros',
        subcategoria: null,
        formaPagamento: null,
        projectId: 'p',
        projectName: 'Pessoal',
        projectType: 'PESSOAL',
      },
    ],
    projetos: [],
    caixa: {
      hoje: 1_100_000,
      saldoInicial: 1_000_000,
      temSaldoInicial: true,
      porMes: [{ mes: '2026-06', caixa: 1_000_000 }],
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('buildSaldoSeries', () => {
  it('anchors the "Hoje" point to canonical caixa when caixaReal is enabled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));

    const data = makeData();
    const m = deriveMonth(data, '2026-07', data.entries);
    expect(m.caixaReal).toBe(true);
    expect(m.saldoAtual).toBe(1_100_000);

    const serie = buildSaldoSeries(m, data.entries ?? [], m.ritmoDiario);
    const hojeRow = serie.find((row) => row.dia === m.hoje);

    expect(hojeRow?.projetado).toBe(m.saldoAtual);
  });

  it('treats future-dated realized entries as projected in current month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));

    const data = makeData();
    data.caixa = undefined;
    data.entries = [
      {
        id: 'future-expense',
        data: '2026-07-20',
        tipo: 'DESPESA',
        status: 'PAGO',
        valor: 70_000,
        categoria: 'Outros',
        subcategoria: null,
        formaPagamento: null,
        projectId: 'p',
        projectName: 'Pessoal',
        projectType: 'PESSOAL',
      },
      {
        id: 'future-income',
        data: '2026-07-25',
        tipo: 'RECEBIMENTO',
        status: 'EM_CAIXA',
        valor: 20_000,
        categoria: null,
        subcategoria: null,
        formaPagamento: null,
        projectId: 'p',
        projectName: 'Pessoal',
        projectType: 'PESSOAL',
      },
    ];

    const m = deriveMonth(data, '2026-07', data.entries);
    expect(m.gasteiRealizado).toBe(0);
    expect(m.gasteiPlanejado).toBe(70_000);
    expect(m.entrouRealizado).toBe(0);
    expect(m.entrouPrevisto).toBe(20_000);
  });
});
