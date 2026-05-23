import { describe, it, expect } from 'vitest';
import {
  calculateRollingBalance,
  calculateRollingBalanceRealizado,
  buildMonthlyAccumulated,
  buildMonthlyOverview,
  compareMonths,
  computeCashFlowEntries,
  generateInstallmentDates,
  splitIntoCents,
  toCents,
  fromCents,
} from '../src/calculations';
import { CashFlowType, CashFlowStatus, PaymentForm } from '../src/enums';
import type { CashFlowEntry } from '../src/types';

describe('calculateRollingBalance', () => {
  it('soma recebimentos e subtrai despesas em ordem', () => {
    const entries = [
      { tipo: CashFlowType.RECEBIMENTO, valor: 30000 },
      { tipo: CashFlowType.DESPESA, valor: 5000 },
      { tipo: CashFlowType.DESPESA, valor: 3000 },
      { tipo: CashFlowType.RECEBIMENTO, valor: 10000 },
    ];
    expect(calculateRollingBalance(entries)).toEqual([30000, 25000, 22000, 32000]);
  });

  it('retorna array vazio para lista vazia', () => {
    expect(calculateRollingBalance([])).toEqual([]);
  });

  it('pode resultar em saldo negativo', () => {
    const entries = [
      { tipo: CashFlowType.DESPESA, valor: 5000 },
      { tipo: CashFlowType.DESPESA, valor: 3000 },
    ];
    expect(calculateRollingBalance(entries)).toEqual([-5000, -8000]);
  });
});

describe('computeCashFlowEntries', () => {
  it('adiciona rollingBalance a cada entrada', () => {
    const entries: CashFlowEntry[] = [
      {
        id: '1',
        projectId: 'p1',
        tenantId: 't1',
        expenseId: null,
        receiptId: null,
        tipo: CashFlowType.RECEBIMENTO,
        valor: 30000,
        data: new Date('2025-01-01'),
        status: CashFlowStatus.EM_CAIXA,
        categoria: null,
        subcategoria: null,
        ambiente: null,
        formaPagamento: null,
        parcela: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as unknown as CashFlowEntry,
      {
        id: '2',
        projectId: 'p1',
        tenantId: 't1',
        expenseId: null,
        receiptId: null,
        tipo: CashFlowType.DESPESA,
        valor: 6000,
        data: new Date('2025-01-15'),
        status: CashFlowStatus.PAGO,
        categoria: null,
        subcategoria: null,
        ambiente: null,
        formaPagamento: null,
        parcela: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as unknown as CashFlowEntry,
    ];
    const result = computeCashFlowEntries(entries);
    expect(result[0]!.rollingBalance).toBe(30000);
    expect(result[1]!.rollingBalance).toBe(24000);
  });

  it('preserva as outras propriedades das entradas', () => {
    const entries: CashFlowEntry[] = [
      {
        id: 'x',
        projectId: 'p',
        tenantId: 't',
        expenseId: null,
        receiptId: null,
        tipo: CashFlowType.RECEBIMENTO,
        valor: 100,
        data: new Date('2025-01-01'),
        status: CashFlowStatus.EM_CAIXA,
        categoria: 'Aporte',
        subcategoria: null,
        ambiente: null,
        formaPagamento: null,
        parcela: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as unknown as CashFlowEntry,
    ];
    const result = computeCashFlowEntries(entries);
    expect(result[0]!.id).toBe('x');
    expect(result[0]!.categoria).toBe('Aporte');
    expect(result[0]!.rollingBalance).toBe(100);
  });
});

describe('calculateRollingBalanceRealizado', () => {
  it('considera apenas PAGO e EM_CAIXA; ignora PLANEJADO e PREVISTO', () => {
    const entries = [
      { tipo: CashFlowType.RECEBIMENTO, valor: 10000, status: CashFlowStatus.EM_CAIXA },
      { tipo: CashFlowType.RECEBIMENTO, valor: 50000, status: CashFlowStatus.PREVISTO },
      { tipo: CashFlowType.DESPESA, valor: 3000, status: CashFlowStatus.PAGO },
      { tipo: CashFlowType.DESPESA, valor: 7000, status: CashFlowStatus.PLANEJADO },
    ];
    // realizado: +10000, +10000 (PREVISTO ignorado), -3000, -3000 (PLANEJADO ignorado)
    expect(calculateRollingBalanceRealizado(entries)).toEqual([10000, 10000, 7000, 7000]);
  });

  it('retorna 0 quando nada foi realizado', () => {
    const entries = [
      { tipo: CashFlowType.RECEBIMENTO, valor: 1000, status: CashFlowStatus.PREVISTO },
      { tipo: CashFlowType.DESPESA, valor: 500, status: CashFlowStatus.PLANEJADO },
    ];
    expect(calculateRollingBalanceRealizado(entries)).toEqual([0, 0]);
  });
});

describe('buildMonthlyAccumulated', () => {
  it('preenche meses vazios entre o primeiro e o último mês com entries', () => {
    const entries = [
      {
        tipo: CashFlowType.RECEBIMENTO, valor: 10000,
        status: CashFlowStatus.EM_CAIXA, data: new Date(Date.UTC(2025, 0, 5)),
      },
      {
        tipo: CashFlowType.DESPESA, valor: 4000,
        status: CashFlowStatus.PAGO, data: new Date(Date.UTC(2025, 3, 20)),
      },
    ];
    const rows = buildMonthlyAccumulated(entries);
    expect(rows.map((r) => r.mes)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04']);
    expect(rows[0]!.saldoAcumulado).toBe(10000);
    expect(rows[1]!.saldoAcumulado).toBe(10000); // mês vazio mantém saldo
    expect(rows[2]!.saldoAcumulado).toBe(10000);
    expect(rows[3]!.saldoAcumulado).toBe(6000);
  });

  it('separa saldo projetado de saldo realizado', () => {
    const entries = [
      {
        tipo: CashFlowType.RECEBIMENTO, valor: 5000,
        status: CashFlowStatus.PREVISTO, data: new Date(Date.UTC(2025, 0, 10)),
      },
      {
        tipo: CashFlowType.RECEBIMENTO, valor: 3000,
        status: CashFlowStatus.EM_CAIXA, data: new Date(Date.UTC(2025, 0, 12)),
      },
      {
        tipo: CashFlowType.DESPESA, valor: 1000,
        status: CashFlowStatus.PLANEJADO, data: new Date(Date.UTC(2025, 1, 5)),
      },
      {
        tipo: CashFlowType.DESPESA, valor: 500,
        status: CashFlowStatus.PAGO, data: new Date(Date.UTC(2025, 1, 8)),
      },
    ];
    const rows = buildMonthlyAccumulated(entries);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.saldoAcumulado).toBe(8000);          // 5000 + 3000
    expect(rows[0]!.saldoAcumuladoRealizado).toBe(3000); // só EM_CAIXA
    expect(rows[1]!.saldoAcumulado).toBe(6500);          // 8000 - 1000 - 500
    expect(rows[1]!.saldoAcumuladoRealizado).toBe(2500); // 3000 - 500
  });

  it('retorna [] quando não há entries', () => {
    expect(buildMonthlyAccumulated([])).toEqual([]);
  });

  it('agrupa múltiplas entries no mesmo mês corretamente', () => {
    const entries = [
      {
        tipo: CashFlowType.DESPESA, valor: 100,
        status: CashFlowStatus.PAGO, data: new Date(Date.UTC(2025, 5, 1)),
      },
      {
        tipo: CashFlowType.DESPESA, valor: 200,
        status: CashFlowStatus.PAGO, data: new Date(Date.UTC(2025, 5, 15)),
      },
      {
        tipo: CashFlowType.RECEBIMENTO, valor: 1000,
        status: CashFlowStatus.EM_CAIXA, data: new Date(Date.UTC(2025, 5, 28)),
      },
    ];
    const rows = buildMonthlyAccumulated(entries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.despesas).toBe(300);
    expect(rows[0]!.recebimentos).toBe(1000);
    expect(rows[0]!.saldoAcumulado).toBe(700);
    expect(rows[0]!.saldoAcumuladoRealizado).toBe(700);
  });
});

describe('generateInstallmentDates', () => {
  it('PARCELADO gera datas mensais (mesmo dia do mês)', () => {
    const start = new Date('2025-01-15T00:00:00Z');
    const dates = generateInstallmentDates(start, 3, PaymentForm.PARCELADO);
    expect(dates).toHaveLength(3);
    expect(dates[0]!.getUTCMonth()).toBe(0);
    expect(dates[1]!.getUTCMonth()).toBe(1);
    expect(dates[2]!.getUTCMonth()).toBe(2);
  });

  it('QUINZENAL gera datas a cada 15 dias', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const dates = generateInstallmentDates(start, 3, PaymentForm.QUINZENAL);
    expect(dates).toHaveLength(3);
    const day0 = dates[0]!.getTime();
    const day1 = dates[1]!.getTime();
    const day2 = dates[2]!.getTime();
    expect((day1 - day0) / (24 * 60 * 60 * 1000)).toBe(15);
    expect((day2 - day1) / (24 * 60 * 60 * 1000)).toBe(15);
  });

  it('quantidade=1 retorna apenas a data inicial', () => {
    const start = new Date('2025-01-15T00:00:00Z');
    const dates = generateInstallmentDates(start, 1, PaymentForm.PARCELADO);
    expect(dates).toHaveLength(1);
    expect(dates[0]!.getTime()).toBe(start.getTime());
  });

  it('não muta a data inicial', () => {
    const start = new Date('2025-01-15T00:00:00Z');
    const startMs = start.getTime();
    generateInstallmentDates(start, 5, PaymentForm.PARCELADO);
    expect(start.getTime()).toBe(startMs);
  });
});

describe('splitIntoCents', () => {
  it('divide igualmente quando totalCents é múltiplo', () => {
    expect(splitIntoCents(1000, 4)).toEqual([250, 250, 250, 250]);
  });

  it('última parcela absorve o resto (centavos)', () => {
    expect(splitIntoCents(1001, 4)).toEqual([250, 250, 250, 251]);
  });

  it('soma das parcelas é sempre igual ao total', () => {
    for (const [total, n] of [[100, 3], [999, 7], [10001, 12]]) {
      const parts = splitIntoCents(total, n);
      expect(parts.reduce((s, v) => s + v, 0)).toBe(total);
    }
  });

  it('1 parcela retorna o total', () => {
    expect(splitIntoCents(5000, 1)).toEqual([5000]);
  });
});

describe('toCents / fromCents', () => {
  it('toCents arredonda para inteiro mais próximo', () => {
    expect(toCents(10.555)).toBe(1056); // .555 * 100 = 55.5 → 56
    expect(toCents(0)).toBe(0);
    expect(toCents(1)).toBe(100);
  });

  it('fromCents divide por 100', () => {
    expect(fromCents(1234)).toBe(12.34);
    expect(fromCents(0)).toBe(0);
  });

  it('toCents/fromCents são inversos para valores "redondos"', () => {
    for (const value of [0, 1, 10.5, 100, 1234.56]) {
      expect(fromCents(toCents(value))).toBeCloseTo(value, 2);
    }
  });
});

describe('buildMonthlyOverview', () => {
  it('retorna lista vazia para input vazio', () => {
    expect(buildMonthlyOverview([])).toEqual([]);
  });

  it('agrupa por mês com saldo do mês (não acumulado) e porOrigem', () => {
    const entries = [
      { tipo: CashFlowType.RECEBIMENTO, valor: 50000, status: CashFlowStatus.EM_CAIXA, data: '2026-07-05', categoria: 'Salário', projectOrigin: 'PESSOAL' },
      { tipo: CashFlowType.DESPESA, valor: 10000, status: CashFlowStatus.PAGO, data: '2026-07-10', categoria: 'Alimentação', projectOrigin: 'PESSOAL' },
      { tipo: CashFlowType.DESPESA, valor: 5000, status: CashFlowStatus.PLANEJADO, data: '2026-07-20', categoria: 'Material p/ Construção', projectOrigin: 'REFORMA' },
      { tipo: CashFlowType.DESPESA, valor: 2000, status: CashFlowStatus.PAGO, data: '2026-08-01', categoria: 'Combustível', projectOrigin: 'CARRO' },
    ];
    const rows = buildMonthlyOverview(entries);
    expect(rows.map((r) => r.mes)).toEqual(['2026-07', '2026-08']);

    const jul = rows[0]!;
    expect(jul.totalRecebimentos).toBe(50000);
    expect(jul.totalDespesas).toBe(15000);
    expect(jul.saldoMes).toBe(35000); // 50000 − 15000
    expect(jul.recebimentosRealizados).toBe(50000);
    expect(jul.despesasRealizadas).toBe(10000); // só PAGO; PLANEJADO REFORMA não conta
    expect(jul.saldoMesRealizado).toBe(40000);
    expect(jul.porOrigem.PESSOAL).toEqual({ despesas: 10000, recebimentos: 50000 });
    expect(jul.porOrigem.REFORMA).toEqual({ despesas: 5000, recebimentos: 0 });

    const ago = rows[1]!;
    expect(ago.totalDespesas).toBe(2000);
    expect(ago.saldoMes).toBe(-2000);
    expect(ago.porOrigem.CARRO).toEqual({ despesas: 2000, recebimentos: 0 });
  });

  it('porCategoria é ordenado desc e limitado por topCategorias', () => {
    const entries = [
      { tipo: CashFlowType.DESPESA, valor: 100, status: CashFlowStatus.PLANEJADO, data: '2026-07-01', categoria: 'A', projectOrigin: 'PESSOAL' },
      { tipo: CashFlowType.DESPESA, valor: 500, status: CashFlowStatus.PLANEJADO, data: '2026-07-02', categoria: 'B', projectOrigin: 'PESSOAL' },
      { tipo: CashFlowType.DESPESA, valor: 300, status: CashFlowStatus.PLANEJADO, data: '2026-07-03', categoria: 'C', projectOrigin: 'PESSOAL' },
      { tipo: CashFlowType.DESPESA, valor: 200, status: CashFlowStatus.PLANEJADO, data: '2026-07-04', categoria: 'A', projectOrigin: 'PESSOAL' },
    ];
    const rows = buildMonthlyOverview(entries, { topCategorias: 2 });
    expect(rows[0]!.porCategoria).toEqual([
      { categoria: 'B', valor: 500 },
      { categoria: 'A', valor: 300 }, // 100+200
    ]);
  });

  it('preenche meses vazios entre primeiro e último com gap-filling', () => {
    const entries = [
      { tipo: CashFlowType.DESPESA, valor: 100, status: CashFlowStatus.PAGO, data: '2026-05-01', categoria: 'X', projectOrigin: 'PESSOAL' },
      { tipo: CashFlowType.DESPESA, valor: 200, status: CashFlowStatus.PAGO, data: '2026-08-01', categoria: 'X', projectOrigin: 'PESSOAL' },
    ];
    const rows = buildMonthlyOverview(entries);
    expect(rows.map((r) => r.mes)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
    expect(rows[1]!.totalDespesas).toBe(0);
    expect(rows[2]!.totalDespesas).toBe(0);
  });

  it('entries sem projectOrigin vão para "OUTROS"; sem categoria vão para "Sem categoria"', () => {
    const entries = [
      { tipo: CashFlowType.DESPESA, valor: 100, status: CashFlowStatus.PAGO, data: '2026-07-01' },
    ];
    const rows = buildMonthlyOverview(entries);
    expect(rows[0]!.porOrigem.OUTROS).toEqual({ despesas: 100, recebimentos: 0 });
    expect(rows[0]!.porCategoria).toEqual([{ categoria: 'Sem categoria', valor: 100 }]);
  });
});

describe('compareMonths', () => {
  const rows = buildMonthlyOverview([
    { tipo: CashFlowType.DESPESA, valor: 10000, status: CashFlowStatus.PAGO, data: '2026-06-01', categoria: 'A', projectOrigin: 'PESSOAL' },
    { tipo: CashFlowType.RECEBIMENTO, valor: 50000, status: CashFlowStatus.EM_CAIXA, data: '2026-06-01', categoria: 'S', projectOrigin: 'PESSOAL' },
    { tipo: CashFlowType.DESPESA, valor: 15000, status: CashFlowStatus.PAGO, data: '2026-07-01', categoria: 'A', projectOrigin: 'PESSOAL' },
    { tipo: CashFlowType.RECEBIMENTO, valor: 50000, status: CashFlowStatus.EM_CAIXA, data: '2026-07-01', categoria: 'S', projectOrigin: 'PESSOAL' },
  ]);

  it('calcula deltas absolutos e percentuais', () => {
    const cmp = compareMonths(rows, '2026-07');
    expect(cmp.current?.mes).toBe('2026-07');
    expect(cmp.previous?.mes).toBe('2026-06');
    expect(cmp.deltaDespesas).toBe(5000);            // 15000 − 10000
    expect(cmp.deltaDespesasPct).toBe(50);           // 5000 / 10000 * 100
    expect(cmp.deltaRecebimentos).toBe(0);
    expect(cmp.deltaRecebimentosPct).toBe(0);
    expect(cmp.deltaSaldo).toBe(-5000);              // 35000 − 40000
  });

  it('retorna previous=null para o primeiro mês', () => {
    const cmp = compareMonths(rows, '2026-06');
    expect(cmp.previous).toBeNull();
    expect(cmp.deltaDespesasPct).toBeNull();         // sem base
  });

  it('retorna current=null para mês inexistente', () => {
    const cmp = compareMonths(rows, '2026-12');
    expect(cmp.current).toBeNull();
  });
});
