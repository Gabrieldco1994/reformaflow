import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveCockpitTop } from './derive';
import type { MonthlyOverviewResponse } from '../_types';

const data = (projecao?: MonthlyOverviewResponse['projecao']): MonthlyOverviewResponse => ({
  mesAtual: '2026-07', meses: [],
  comparativo: { current: null, previous: null, deltaDespesas: 0, deltaDespesasPct: null, deltaRecebimentos: 0, deltaRecebimentosPct: null, deltaSaldo: 0 },
  mesAtualEntries: [], projetos: [],
  entries: [
    { id: 'old', data: '2026-06-10', tipo: 'DESPESA', status: 'PAGO', valor: 200, categoria: null, subcategoria: null, formaPagamento: null, projectId: 'p', projectName: 'Pessoal', projectType: 'PESSOAL' },
    { id: 'selected', data: '2026-07-10', tipo: 'RECEBIMENTO', status: 'EM_CAIXA', valor: 500, categoria: null, subcategoria: null, formaPagamento: null, projectId: 'p', projectName: 'Pessoal', projectType: 'PESSOAL' },
    { id: 'planned', data: '2026-07-20', tipo: 'DESPESA', status: 'PLANEJADO', valor: 100, categoria: null, subcategoria: null, formaPagamento: null, projectId: 'p', projectName: 'Pessoal', projectType: 'PESSOAL' },
  ],
  caixa: { hoje: 1000, saldoInicial: 1000, temSaldoInicial: true, porMes: [] }, projecao,
});
const canonical = (patch: Record<string, unknown> = {}) => ({ status: 'canonical' as const, mes: '2026-07', caixaHoje: 0, entrouMes: 0, saiuMes: 0, faltaPagarMes: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0, ...patch });
afterEach(() => vi.useRealTimers());

describe('deriveCockpitTop month-aware contract', () => {
  it.each([['2026-06', 1], ['2026-07', 11 / 31], ['2026-08', 0]] as const)('anchors aggregates and elapsed fraction for %s', (month, elapsed) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-11T12:00:00Z'));
    const top = deriveCockpitTop(data(), month);
    expect(top.mesAtualKey).toBe(month); expect(top.pctMesDecorrido).toBeCloseTo(elapsed);
    expect(top.resultadoMes).toBe(month === '2026-07' ? 500 : month === '2026-06' ? -200 : 0);
    if (month === '2026-07') expect(top.resultadoDeltaPct).toBe(350);
  });
  it('uses a matching canonical projection, including zero values', () => {
    const top = deriveCockpitTop(data(canonical()), '2026-07');
    expect(top.projectionSource).toBe('canonical'); expect(top.projectionDegraded).toBe(false);
    expect(top.projecaoMes).toBe(0); expect(top.saidaTotal).toBe(0);
  });

  it('considera o mês corrente no calendário BRT na fronteira UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T02:30:00.000Z')); // 30/06 23:30 BRT
    const jun = deriveCockpitTop(data(), '2026-06');
    const jul = deriveCockpitTop(data(), '2026-07');
    expect(jun.pctMesDecorrido).toBe(1);
    expect(jul.pctMesDecorrido).toBe(0);
  });

  it.each([
    ['month mismatch', canonical({ mes: '2026-06' })],
    ['degraded', { ...canonical(), status: 'degraded' as const }],
    ['missing numeric field', { ...canonical(), sobraPrevista: undefined }],
    ['absent', undefined],
  ])('preserves competency fallback for %s projection', (_name, projecao) => {
    const top = deriveCockpitTop(data(projecao as MonthlyOverviewResponse['projecao']), '2026-07');
    expect(top.projectionSource).toBe('competency-fallback'); expect(top.projectionDegraded).toBe(true);
    expect(top.aPagarMes).toBe(100); expect(top.projecaoMes).toBe(900);
  });
});
