import { describe, it, expect } from 'vitest';
import { deriveCockpitTop } from './derive';
import type {
  MonthlyEntry,
  MonthlyOverviewResponse,
  MonthComparison,
} from '../_types';

const EMPTY_COMPARISON: MonthComparison = {
  current: null,
  previous: null,
  deltaDespesas: 0,
  deltaDespesasPct: null,
  deltaRecebimentos: 0,
  deltaRecebimentosPct: null,
  deltaSaldo: 0,
};

function entry(patch: Partial<MonthlyEntry>): MonthlyEntry {
  return {
    id: Math.random().toString(36).slice(2),
    data: '2026-07-10T00:00:00.000Z',
    tipo: 'DESPESA',
    status: 'PLANEJADO',
    valor: 0,
    categoria: 'Transporte',
    subcategoria: null,
    formaPagamento: 'PIX',
    projectId: 'p1',
    projectName: 'Pessoal',
    projectType: 'PESSOAL',
    isNeutral: false,
    ...patch,
  };
}

function baseData(patch: Partial<MonthlyOverviewResponse>): MonthlyOverviewResponse {
  return {
    mesAtual: '2026-07',
    meses: [],
    comparativo: EMPTY_COMPARISON,
    mesAtualEntries: [],
    entries: [],
    projetos: [],
    caixa: { hoje: 6_901_652, saldoInicial: 0, temSaldoInicial: true, porMes: [] },
    ...patch,
  };
}

describe('deriveCockpitTop — projeção de fim de mês (eixo de caixa, §10)', () => {
  it('usa data.projecao (Visão Conta) quando presente — casa a pagar/projeção/saídas', () => {
    // Competência nas entries (22.249) NÃO deve ser usada quando há projecao.
    const data = baseData({
      entries: [entry({ valor: 2_224_902, status: 'PLANEJADO' })],
      projecao: {
        caixaHoje: 6_901_652,
        entrouMes: 0,
        saiuMes: 4_412_804,
        faltaPagarMes: 3_759_570,
        recebimentosPrevistosMes: 2_523_200,
        sobraPrevista: 5_665_282,
      },
    });
    const t = deriveCockpitTop(data);
    expect(t.aPagarMes).toBe(3_759_570); // 37.595,70 (caixa), não 22.249 (competência)
    expect(t.aReceberMes).toBe(2_523_200); // 25.232,00
    expect(t.projecaoMes).toBe(5_665_282); // 56.652,82 = sobra prevista da Visão Conta
    // Saídas em caixa (§10)
    expect(t.entrouMes).toBe(0);
    expect(t.saidaJaSaiu).toBe(4_412_804); // 44.128,04 (saiuMes)
    expect(t.saidaVaiSair).toBe(3_759_570); // = a pagar
    expect(t.saidaTotal).toBe(4_412_804 + 3_759_570); // 81.723,74
  });

  it('cai no cálculo por competência quando projecao ausente (payload antigo)', () => {
    const data = baseData({
      entries: [
        entry({ valor: 2_224_902, status: 'PLANEJADO' }),
        entry({ tipo: 'RECEBIMENTO', valor: 2_523_200, status: 'PLANEJADO' }),
      ],
      // sem projecao
    });
    const t = deriveCockpitTop(data);
    expect(t.aPagarMes).toBe(2_224_902); // competência: despesa planejada
    expect(t.aReceberMes).toBe(2_523_200); // competência: recebimento planejado
    expect(t.projecaoMes).toBe(6_901_652 + 2_523_200 - 2_224_902);
  });
});
