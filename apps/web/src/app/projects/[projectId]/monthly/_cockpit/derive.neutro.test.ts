import { describe, it, expect } from 'vitest';
import { deriveMonth, deriveTotals, deriveCockpitTop } from './derive';
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

// Compra real (consumo) + pagamento de fatura (neutro) no mesmo mês.
const compra = entry({ valor: 400000, bankLast4: '3636', cardLast4: null, formaPagamento: 'PIX', tipoDespesaCodigo: 'MORADIA', status: 'PAGO' });
const fatura = entry({
  valor: 1000000,
  bankLast4: '3636',
  cardLast4: null,
  isNeutral: true,
  tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
  status: 'PAGO',
});

describe('cockpit mensal — neutros fora do consumo/resultado', () => {
  it('deriveMonth.gasteiRealizado ignora pagamento de fatura (não dobra)', () => {
    const m = deriveMonth(makeData([compra, fatura]), '2026-06', [compra, fatura]);
    expect(m.gasteiRealizado).toBe(400000); // só a compra, não a fatura de 1.000.000
  });

  it('deriveTotals ignora neutros nas saídas realizadas', () => {
    const t = deriveTotals(makeData([compra, fatura]));
    expect(t.saidasRealizadas).toBe(400000);
    expect(t.fluxoRealizado).toBe(-400000);
  });

  it('deriveCockpitTop.resultadoGastou/resultadoMes sem o neutro', () => {
    const receita = entry({ tipo: 'RECEBIMENTO', status: 'EM_CAIXA', valor: 500000, categoria: null });
    const top = deriveCockpitTop(makeData([compra, fatura, receita]));
    expect(top.resultadoGastou).toBe(400000); // não 1.400.000
    expect(top.resultadoEntrou).toBe(500000);
    expect(top.resultadoMes).toBe(100000);
  });

  it('espelho cross-project não é contado (dedup) no mês', () => {
    const espelho = entry({ valor: 800000, isEspelho: true, tipoDespesaCodigo: 'MORADIA', status: 'PAGO' });
    const m = deriveMonth(makeData([compra, espelho]), '2026-06', [compra, espelho]);
    expect(m.gasteiRealizado).toBe(400000);
  });

  it('m.categorias (Principais gastos) NÃO inclui pagamento de fatura', () => {
    const faturaCat = entry({
      valor: 1000000,
      categoria: 'Pagamento de fatura',
      isNeutral: true,
      tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
    });
    const compraCartao = entry({ valor: 400000, categoria: 'Alimentação', cardLast4: '1234', tipoDespesaCodigo: 'ALIMENTACAO' });
    const m = deriveMonth(makeData([compraCartao, faturaCat]), '2026-06', [compraCartao, faturaCat]);
    const labels = m.categorias.map((c) => c.categoria);
    expect(labels).toContain('Alimentação'); // compra real do cartão aparece
    expect(labels).not.toContain('Pagamento de fatura'); // neutro fora
    expect(m.categorias.find((c) => c.categoria === 'Alimentação')!.valor).toBe(400000);
  });
});
