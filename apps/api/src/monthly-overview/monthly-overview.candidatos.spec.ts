import { buildRunwayCandidatos } from './monthly-overview.service';

const makeSerie = (entries: Array<{ mes: string; saldoProjetado: number }>) =>
  entries.map((e) => ({
    mes: e.mes,
    saldoProjetado: e.saldoProjetado,
    recebimentos: 0,
    despesas: 0,
    recebimentosRealizados: null,
    despesasRealizadas: null,
  }));

const makeSaida = (overrides: Partial<{
  id: string | null;
  foreignExpenseId: string | null;
  descricao: string;
  valor: number;
  data: string;
  isInvoice: boolean;
  realizado: boolean;
  projetoOrigem: { id: string; name: string; type: string } | null;
}>) => ({
  id: null,
  foreignExpenseId: null,
  kind: 'saida' as const,
  descricao: 'Gasto',
  valor: 1_000_00, // 1000 BRL in centavos
  data: '2026-08-15T00:00:00.000Z',
  isInvoice: false,
  realizado: false,
  status: 'PLANEJADO',
  projetoOrigem: null,
  ...overrides,
});

describe('buildRunwayCandidatos', () => {
  it('retorna [] quando não há crossover (saldo sempre positivo)', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 100_000 },
      { mes: '2026-08', saldoProjetado: 80_000 },
      { mes: '2026-09', saldoProjetado: 50_000 },
    ]);
    const result = buildRunwayCandidatos(serie, [{saidas:[]}], ['2026-07'], '2026-07');
    expect(result).toEqual([]);
  });

  it('retorna [] quando crossover é antes do mês selecionado', () => {
    const serie = makeSerie([
      { mes: '2026-06', saldoProjetado: -10_000 }, // crossover antes do selected
      { mes: '2026-07', saldoProjetado: -20_000 },
    ]);
    const result = buildRunwayCandidatos(serie, [{saidas:[]}], ['2026-07'], '2026-07');
    expect(result).toEqual([]);
  });

  it('exclui faturas (isInvoice:true)', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -5_000 },
    ]);
    const views = [
      { saidas: [makeSaida({ id: 'e1', isInvoice: true, valor: 999_99 })] },
      { saidas: [] },
    ];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08'], '2026-07');
    expect(result).toEqual([]);
  });

  it('exclui realizados (realizado:true)', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -5_000 },
    ]);
    const views = [
      { saidas: [makeSaida({ id: 'e1', realizado: true, valor: 500_00 })] },
      { saidas: [] },
    ];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08'], '2026-07');
    expect(result).toEqual([]);
  });

  it('exclui espelhos PESSOAL (projetoOrigem set, foreignExpenseId null)', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -5_000 },
    ]);
    const views = [
      {
        saidas: [
          makeSaida({
            id: 'espelho-1',
            foreignExpenseId: null,
            projetoOrigem: { id: 'reform-1', name: 'REFORMA', type: 'REFORMA' },
            valor: 300_00,
          }),
        ],
      },
      { saidas: [] },
    ];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08'], '2026-07');
    expect(result).toEqual([]);
  });

  it('inclui foreignPendingItems (foreignExpenseId set, projetoOrigem set)', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -5_000 },
    ]);
    const views = [
      {
        saidas: [
          makeSaida({
            id: null,
            foreignExpenseId: 'foreign-1',
            projetoOrigem: { id: 'reform-1', name: 'REFORMA', type: 'REFORMA' },
            valor: 300_00,
            descricao: 'Reforma cozinha',
          }),
        ],
      },
      { saidas: [] },
    ];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08'], '2026-07');
    expect(result).toHaveLength(1);
    expect(result[0].expenseId).toBe('foreign-1');
  });

  it('exclui meses após o crossover', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -5_000 },  // crossover
      { mes: '2026-09', saldoProjetado: -10_000 }, // after crossover
    ]);
    const views = [
      { saidas: [makeSaida({ id: 'e-jul', valor: 200_00 })] },
      { saidas: [makeSaida({ id: 'e-ago', valor: 300_00 })] }, // crossover month, included
      { saidas: [makeSaida({ id: 'e-set', valor: 999_99 })] }, // after crossover, excluded
    ];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08', '2026-09'], '2026-07');
    const ids = result.map((c) => c.expenseId);
    expect(ids).toContain('e-jul');
    expect(ids).toContain('e-ago');
    expect(ids).not.toContain('e-set');
  });

  it('ordena por valor desc e limita a 5', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -1_000 },
    ]);
    const saidas = ['e1','e2','e3','e4','e5','e6'].map((id, i) =>
      makeSaida({ id, valor: (i + 1) * 100_00 }) // 100, 200, ..., 600
    );
    const views = [{ saidas }, { saidas: [] }];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08'], '2026-07');
    expect(result).toHaveLength(5);
    expect(result[0].expenseId).toBe('e6'); // highest valor first
    expect(result[4].expenseId).toBe('e2'); // 5th largest
  });

  it('soma parcelas da mesma despesa em múltiplos meses', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -5_000 },
    ]);
    const views = [
      { saidas: [makeSaida({ id: 'e1', valor: 100_00 })] },
      { saidas: [makeSaida({ id: 'e1', valor: 100_00 })] }, // same expense, second installment
    ];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08'], '2026-07');
    expect(result).toHaveLength(1);
    expect(result[0].valor).toBe(200_00); // soma das parcelas
  });
});
