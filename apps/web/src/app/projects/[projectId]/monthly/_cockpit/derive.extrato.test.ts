import { describe, it, expect } from 'vitest';
import { buildExtratoDespesas, buildComprometimentoFuturo } from './derive';
import type { MonthlyEntry, MonthlyOverviewResponse, MonthComparison } from '../_types';

const LATAM = '7259';

function entry(patch: Partial<MonthlyEntry>): MonthlyEntry {
  return {
    id: Math.random().toString(36).slice(2),
    data: '2026-05-10T00:00:00.000Z',
    tipo: 'DESPESA',
    status: 'PAGO',
    valor: 0,
    categoria: 'Transporte',
    subcategoria: null,
    formaPagamento: 'CARTAO_CREDITO',
    projectId: 'p1',
    projectName: 'Pessoal',
    projectType: 'PESSOAL',
    isNeutral: false,
    ...patch,
  };
}

const consumoLatam = [
  entry({ cardLast4: LATAM, valor: 200000, data: '2026-05-10T00:00:00.000Z' }),
  entry({ cardLast4: LATAM, valor: 143530, data: '2026-05-12T00:00:00.000Z' }),
]; // 343.530
const cartaoPagaCartao = [
  entry({ cardLast4: LATAM, bankLast4: null, valor: 559783, data: '2026-05-14T00:00:00.000Z', isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO' }),
  entry({ cardLast4: LATAM, bankLast4: null, valor: 664442, data: '2026-05-15T00:00:00.000Z', isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO' }),
];
const liquidacaoConta = entry({
  bankLast4: '3636',
  cardLast4: null,
  valor: 500000,
  data: '2026-05-05T00:00:00.000Z',
  isNeutral: true,
  tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
});

describe('buildExtratoDespesas — visão Geral (consumo real)', () => {
  it('exclui TODO neutro (cartão paga cartão E liquidação pela conta)', () => {
    const { itens, resumo } = buildExtratoDespesas([...consumoLatam, ...cartaoPagaCartao, liquidacaoConta]);
    expect(resumo.qtd).toBe(2);
    expect(resumo.totalSaidas).toBe(343530);
    expect(itens.some((i) => i.valor === 559783)).toBe(false);
    expect(itens.some((i) => i.valor === 664442)).toBe(false);
    expect(itens.some((i) => i.valor === 500000)).toBe(false);
  });
});

const EMPTY_COMPARISON: MonthComparison = {
  current: null,
  previous: null,
  deltaDespesas: 0,
  deltaDespesasPct: null,
  deltaRecebimentos: 0,
  deltaRecebimentosPct: null,
  deltaSaldo: 0,
};

function makeData(entries: MonthlyEntry[]): MonthlyOverviewResponse {
  return {
    mesAtual: '2026-06',
    meses: [],
    comparativo: EMPTY_COMPARISON,
    mesAtualEntries: [],
    entries,
    projetos: [{ id: 'p1', name: 'Pessoal', type: 'PESSOAL' }],
    cards: [],
  };
}

describe('buildComprometimentoFuturo — saída de caixa futura', () => {
  it('inclui cartão-paga-cartão pendente e exclui liquidação pela conta', () => {
    const cartaoPagaPendente = entry({
      cardLast4: LATAM,
      valor: 559783,
      data: '2026-07-30T00:00:00.000Z',
      status: 'PLANEJADO',
      isNeutral: true,
      tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
    });
    // neutro-na-conta com cartão setado (isNeutralAccountSettlement) → excluído
    const liquidacaoNoCartao = entry({
      cardLast4: LATAM,
      bankLast4: '3636',
      valor: 111,
      data: '2026-07-30T00:00:00.000Z',
      status: 'PLANEJADO',
      isNeutral: true,
    });
    const buckets = buildComprometimentoFuturo(makeData([cartaoPagaPendente, liquidacaoNoCartao]), '2026-07', 12);
    const julho = buckets.find((b) => b.mes === '2026-07');
    expect(julho?.total).toBe(559783);
  });
});
