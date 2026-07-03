import { describe, it, expect } from 'vitest';
import { buildCaixaData } from './derive';
import { spendByOrigin } from './spend-by-origin';
import type {
  MonthlyEntry,
  MonthlyOverviewResponse,
  MonthComparison,
  CardConfigDTO,
} from '../_types';

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

const EMPTY_COMPARISON: MonthComparison = {
  current: null,
  previous: null,
  deltaDespesas: 0,
  deltaDespesasPct: null,
  deltaRecebimentos: 0,
  deltaRecebimentosPct: null,
  deltaSaldo: 0,
};

const CARDS: CardConfigDTO[] = [
  { last4: LATAM, nickname: 'Latampass', closingDay: 25, dueDay: 1 },
  { last4: '4444', nickname: 'Nubank', closingDay: 3, dueDay: 1 },
  { last4: '8888', nickname: 'Personalite', closingDay: 20, dueDay: 27 },
];

function makeData(entries: MonthlyEntry[]): MonthlyOverviewResponse {
  return {
    mesAtual: '2026-06',
    meses: [],
    comparativo: EMPTY_COMPARISON,
    mesAtualEntries: [],
    entries,
    projetos: [{ id: 'p1', name: 'Pessoal', type: 'PESSOAL' }],
    cards: CARDS,
  };
}

// Latampass ••7259 (close 25, due 1): compras de 05/2026 e "cartão paga cartão"
// de 30/04 caem todas no vencimento 2026-06.
const consumoLatam = [
  entry({ cardLast4: LATAM, valor: 200000, data: '2026-05-10T00:00:00.000Z' }),
  entry({ cardLast4: LATAM, valor: 143530, data: '2026-05-12T00:00:00.000Z' }),
]; // 343.530 = R$ 3.435,30
const cartaoPagaCartao = [
  entry({ cardLast4: LATAM, bankLast4: null, valor: 559783, data: '2026-04-30T00:00:00.000Z', isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO' }),
  entry({ cardLast4: LATAM, bankLast4: null, valor: 664442, data: '2026-04-30T00:00:00.000Z', isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO' }),
]; // 1.224.225
// Total fatura Latam 2026-06 = 343.530 + 1.224.225 = 1.567.755 = R$ 15.677,55

describe('buildCaixaData — convergência com a fatura da Visão Conta', () => {
  it('Vai sair por cartão == fatura (inclui cartão paga cartão remapeado)', () => {
    const caixa = buildCaixaData(makeData([...consumoLatam, ...cartaoPagaCartao]));
    const junho = (caixa.entries ?? []).filter((e) => (e.data ?? '').slice(0, 7) === '2026-06');
    const { cards } = spendByOrigin(junho, { keepCardSettlement: true });
    expect(cards.get(LATAM)).toBe(1567755);
  });

  it('neutro cobrado no cartão é remapeado para o vencimento, não descartado', () => {
    const caixa = buildCaixaData(makeData([...consumoLatam, ...cartaoPagaCartao]));
    const latamJunho = (caixa.entries ?? []).filter(
      (e) => e.cardLast4 === LATAM && (e.data ?? '').slice(0, 7) === '2026-06',
    );
    expect(latamJunho).toHaveLength(4);
    expect(latamJunho.reduce((s, e) => s + e.valor, 0)).toBe(1567755);
    expect(latamJunho.some((e) => e.valor === 559783)).toBe(true);
    expect(latamJunho.some((e) => e.valor === 664442)).toBe(true);
  });

  it('neutro pago PELA CONTA é removido do eixo caixa', () => {
    const liquidacaoConta = entry({
      bankLast4: '3636',
      cardLast4: null,
      valor: 500000,
      data: '2026-06-05T00:00:00.000Z',
      isNeutral: true,
      tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
    });
    const caixa = buildCaixaData(makeData([...consumoLatam, liquidacaoConta]));
    expect((caixa.entries ?? []).some((e) => e.valor === 500000)).toBe(false);
  });

  it('cartões sem cartão-paga-cartão não regridem no eixo caixa', () => {
    const nubank = entry({ cardLast4: '4444', valor: 442034, data: '2026-05-08T00:00:00.000Z' });
    const personalite = entry({ cardLast4: '8888', valor: 733384, data: '2026-05-09T00:00:00.000Z' });
    const caixa = buildCaixaData(makeData([nubank, personalite]));
    const { cards } = spendByOrigin(caixa.entries ?? [], { keepCardSettlement: true });
    expect(cards.get('4444')).toBe(442034);
    expect(cards.get('8888')).toBe(733384);
  });

  it('agregado do mês não dobra por causa do cartão paga cartão', () => {
    const caixa = buildCaixaData(makeData([...consumoLatam, ...cartaoPagaCartao]));
    const junho = caixa.meses.find((m) => m.mes === '2026-06');
    expect(junho?.totalDespesas).toBe(1567755);
  });

  it('escopo PESSOAL dedup espelho cross-project (Vai sair por cartão = Visão Conta)', () => {
    const espelho = entry({ cardLast4: LATAM, projectId: 'pessoal', projectType: 'PESSOAL', isEspelho: true, valor: 741534, data: '2026-05-10T00:00:00.000Z' });
    const canonical = entry({ cardLast4: LATAM, projectId: 'reforma', projectType: 'REFORMA', valor: 741533, data: '2026-05-11T00:00:00.000Z' });
    const puro = entry({ cardLast4: LATAM, projectId: 'pessoal', projectType: 'PESSOAL', valor: 345027, data: '2026-05-12T00:00:00.000Z' });
    const caixa = buildCaixaData(makeData([espelho, canonical, puro]));
    const junho = (caixa.entries ?? []).filter((e) => (e.data ?? '').slice(0, 7) === '2026-06');
    // sem escopo: dobra o espelho
    expect(spendByOrigin(junho, { keepCardSettlement: true }).cards.get(LATAM)).toBe(741534 + 741533 + 345027);
    // com escopo PESSOAL: só o projeto pessoal (espelho + puro) = 1.086.561
    expect(spendByOrigin(junho, { keepCardSettlement: true, pessoalProjectId: 'pessoal' }).cards.get(LATAM)).toBe(741534 + 345027);
  });
});
