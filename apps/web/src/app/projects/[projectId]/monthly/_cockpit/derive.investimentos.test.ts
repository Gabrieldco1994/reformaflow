import { describe, it, expect } from 'vitest';
import {
  deriveMonth,
  deriveTotals,
  deriveCockpitTop,
  deriveYear,
  categoriasDoAno,
  gastoMedioMensal,
} from './derive';
import { spendByOrigin } from './spend-by-origin';
import { entryIsConsumptionNeutral, isNeutralAccountSettlement } from './neutral';
import type { MonthlyEntry, MonthComparison, MonthlyOverviewResponse } from '../_types';

function entry(patch: Partial<MonthlyEntry>): MonthlyEntry {
  return {
    id: Math.random().toString(36).slice(2),
    data: '2026-06-10T00:00:00.000Z',
    tipo: 'DESPESA',
    status: 'PAGO',
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
  };
}

// Aporte (INVESTIMENTOS): saída real de caixa pela conta, mas NÃO é consumo.
// isNeutralConsumo=true (backend), isNeutral=false (NÃO é settlement → fica no eixo caixa).
const aporte = entry({
  valor: 11_249_094,
  bankLast4: '3636',
  cardLast4: null,
  tipoDespesaCodigo: 'INVESTIMENTOS',
  categoria: 'Investimentos',
  isNeutral: false,
  isNeutralConsumo: true,
  status: 'PAGO',
  data: '2026-06-05T00:00:00.000Z',
});
// Compra real de consumo.
const compra = entry({
  valor: 400000,
  cardLast4: '1234',
  bankLast4: null,
  tipoDespesaCodigo: 'ALIMENTACAO',
  categoria: 'Alimentação',
  status: 'PAGO',
  data: '2026-06-10T00:00:00.000Z',
});

describe('INVESTIMENTOS (aporte) fora do consumo/resultado', () => {
  it('deriveMonth.gasteiRealizado ignora o aporte', () => {
    const m = deriveMonth(makeData([compra, aporte]), '2026-06', [compra, aporte]);
    expect(m.gasteiRealizado).toBe(400000); // não 11.649.094
  });

  it('deriveTotals.saidasRealizadas exclui o aporte', () => {
    expect(deriveTotals(makeData([compra, aporte])).saidasRealizadas).toBe(400000);
  });

  it('deriveCockpitTop.resultadoGastou exclui o aporte', () => {
    expect(deriveCockpitTop(makeData([compra, aporte])).resultadoGastou).toBe(400000);
  });

  it('categorias do mês (Principais gastos) não incluem Investimentos', () => {
    const m = deriveMonth(makeData([compra, aporte]), '2026-06', [compra, aporte]);
    expect(m.categorias.map((c) => c.categoria)).not.toContain('Investimentos');
  });

  it('categoriasDoAno e gastoMedioMensal (÷12) excluem o aporte', () => {
    const d = makeData([compra, aporte]);
    expect(categoriasDoAno(d.entries!, 2026).map((c) => c.categoria)).not.toContain('Investimentos');
    expect(gastoMedioMensal(d.entries!, 2026).valor).toBe(Math.round(400000 / 12));
  });

  it('deriveYear.despesaAno exclui o aporte', () => {
    expect(deriveYear(makeData([compra, aporte]), 2026).despesaAno).toBe(400000);
  });
});

describe('simetria: resgate (RESGATE) fora da renda', () => {
  const resgate = entry({
    tipo: 'RECEBIMENTO',
    status: 'EM_CAIXA',
    valor: 11_322_065,
    bankLast4: '3636',
    cardLast4: null,
    categoria: 'Aplicação / Resgate',
    isNeutralConsumo: true,
    isNeutral: false,
    data: '2026-06-20T00:00:00.000Z',
  });
  // Rendimento (JUROS_RENDA_FIXA) — renda REAL, permanece.
  const rendimento = entry({
    tipo: 'RECEBIMENTO',
    status: 'EM_CAIXA',
    valor: 50000,
    bankLast4: '3636',
    cardLast4: null,
    categoria: 'Rendimentos / Investimentos',
    isNeutralConsumo: false,
    isNeutral: false,
    data: '2026-06-20T00:00:00.000Z',
  });

  it('resgate não conta como receita; rendimento sim', () => {
    const top = deriveCockpitTop(makeData([compra, aporte, resgate, rendimento]));
    expect(top.resultadoEntrou).toBe(50000); // só o rendimento, não o resgate
    expect(top.resultadoGastou).toBe(400000); // aporte fora
    expect(top.resultadoMes).toBe(50000 - 400000);
  });

  it('deriveYear.receitaAno inclui rendimento e exclui resgate', () => {
    const y = deriveYear(makeData([compra, aporte, resgate, rendimento]), 2026);
    expect(y.receitaAno).toBe(50000);
    expect(y.despesaAno).toBe(400000);
  });
});

describe('INVARIANTE: aporte PERMANECE no eixo de caixa (saída real, não settlement)', () => {
  it('isNeutralAccountSettlement é false para o aporte (não é settlement)', () => {
    expect(isNeutralAccountSettlement(aporte)).toBe(false);
  });

  it('entryIsConsumptionNeutral é true para o aporte (fora do consumo)', () => {
    expect(entryIsConsumptionNeutral(aporte)).toBe(true);
  });

  it('competência (Gastei) EXCLUI o aporte da conta', () => {
    const { accounts } = spendByOrigin([aporte]); // keepCardSettlement=false
    expect(accounts.get('3636') ?? 0).toBe(0);
  });

  it('caixa (Vai sair) MANTÉM o aporte na conta — não é settlement', () => {
    const { accounts } = spendByOrigin([aporte], { keepCardSettlement: true });
    expect(accounts.get('3636')).toBe(11_249_094);
  });
});
