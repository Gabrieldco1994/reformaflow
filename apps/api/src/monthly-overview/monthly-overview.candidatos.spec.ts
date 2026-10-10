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
  tipoDespesa: string | null;
  projetoOrigem: { id: string; name: string; type: string } | null;
  expenseIsCredit: unknown;
}>) => ({
  id: null,
  foreignExpenseId: null,
  kind: 'saida' as const,
  descricao: 'Gasto',
  valor: 1_000_00, // 1000 BRL in centavos
  data: '2026-08-15T00:00:00.000Z',
  isInvoice: false,
  realizado: false,
  tipoDespesa: null,
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

  it('exclui neutros (MOVIMENTACAO_INTERNA / INVESTIMENTOS) mesmo que planejados e grandes', () => {
    const serie = makeSerie([
      { mes: '2026-07', saldoProjetado: 10_000 },
      { mes: '2026-08', saldoProjetado: -5_000 },
    ]);
    const views = [
      {
        saidas: [
          makeSaida({ id: 'neutro-1', tipoDespesa: 'MOVIMENTACAO_INTERNA', valor: 999_999_00 }),
          makeSaida({ id: 'neutro-2', tipoDespesa: 'INVESTIMENTOS', valor: 500_000_00 }),
          makeSaida({ id: 'real-1', tipoDespesa: null, valor: 1_00 }),
        ],
      },
      { saidas: [] },
    ];
    const result = buildRunwayCandidatos(serie, views, ['2026-07', '2026-08'], '2026-07');
    const ids = result.map((c) => c.expenseId);
    expect(ids).not.toContain('neutro-1');
    expect(ids).not.toContain('neutro-2');
    expect(ids).toContain('real-1'); // despesa real sem tipoDespesa passa
  });
});

describe('buildRunwayCandidatos — expenseIsCredit (#704 read contract)', () => {
  const serie = makeSerie([
    { mes: '2026-07', saldoProjetado: 10_000 },
    { mes: '2026-08', saldoProjetado: 5_000 },
    { mes: '2026-09', saldoProjetado: -5_000 },
  ]);
  const months = ['2026-07', '2026-08', '2026-09'];
  const run = (views: Array<Array<ReturnType<typeof makeSaida>>>) =>
    buildRunwayCandidatos(serie, views.map((saidas) => ({ saidas })), months, '2026-07');

  it('root positive + negative window occurrence stays false; root negative + positive occurrence is true', () => {
    const result = run([
      [
        makeSaida({ id: 'pos-root', descricao: 'Root +', valor: -200_00, data: '2026-07-10T00:00:00.000Z', expenseIsCredit: false }),
        makeSaida({ id: 'neg-root', descricao: 'Root -', valor: 200_00, data: '2026-07-11T00:00:00.000Z', expenseIsCredit: true }),
      ],
      [],
      [],
    ]);
    expect(result).toEqual([
      { expenseId: 'neg-root', descricao: 'Root -', valor: 200_00, data: '2026-07-11T00:00:00.000Z', projetoOrigem: null, expenseIsCredit: true },
      { expenseId: 'pos-root', descricao: 'Root +', valor: -200_00, data: '2026-07-10T00:00:00.000Z', projetoOrigem: null, expenseIsCredit: false },
    ]);
  });

  it('never infers the flag from the accumulated value; ordinary candidates keep their shape (no key)', () => {
    const result = run([
      [
        makeSaida({ id: 'plain', descricao: 'Plain', valor: -50_00 }),
        makeSaida({ id: 'other', descricao: 'Other', valor: 70_00 }),
      ],
      [],
      [],
    ]);
    expect(result).toEqual([
      { expenseId: 'other', descricao: 'Other', valor: 70_00, data: '2026-08-15T00:00:00.000Z', projetoOrigem: null },
      { expenseId: 'plain', descricao: 'Plain', valor: -50_00, data: '2026-08-15T00:00:00.000Z', projetoOrigem: null },
    ]);
    expect(result.every((row) => !('expenseIsCredit' in row))).toBe(true);
  });

  it('keeps the flag across months of the same expense and ignores views that carry none', () => {
    const result = run([
      [makeSaida({ id: 'e1', valor: 100_00, data: '2026-07-20T00:00:00.000Z', expenseIsCredit: true })],
      [makeSaida({ id: 'e1', valor: 100_00, data: '2026-08-20T00:00:00.000Z' })],
      [makeSaida({ id: 'e1', valor: 100_00, data: '2026-09-20T00:00:00.000Z', expenseIsCredit: true })],
    ]);
    expect(result).toEqual([
      { expenseId: 'e1', descricao: 'Gasto', valor: 300_00, data: '2026-07-20T00:00:00.000Z', projetoOrigem: null, expenseIsCredit: true },
    ]);
  });

  it('conflicting labels for the same expense across views drop the flag (no arbitrary last-wins); selection is unchanged', () => {
    const result = run([
      [makeSaida({ id: 'e1', valor: 100_00, expenseIsCredit: true }), makeSaida({ id: 'e2', valor: 50_00, expenseIsCredit: false })],
      [makeSaida({ id: 'e1', valor: 100_00, expenseIsCredit: false }), makeSaida({ id: 'e2', valor: 50_00, expenseIsCredit: true })],
      [],
    ]);
    expect(result).toEqual([
      { expenseId: 'e1', descricao: 'Gasto', valor: 200_00, data: '2026-08-15T00:00:00.000Z', projetoOrigem: null },
      { expenseId: 'e2', descricao: 'Gasto', valor: 100_00, data: '2026-08-15T00:00:00.000Z', projetoOrigem: null },
    ]);
  });

  it('a conflict is sticky regardless of view order and ignores non-boolean labels', () => {
    const base = [
      makeSaida({ id: 'e1', valor: 10_00, expenseIsCredit: true }),
      makeSaida({ id: 'e1', valor: 10_00, expenseIsCredit: false }),
      makeSaida({ id: 'e1', valor: 10_00, expenseIsCredit: true }),
    ];
    for (const order of [base, [...base].reverse()]) {
      const [row] = run([[order[0]], [order[1]], [order[2]]]);
      expect('expenseIsCredit' in row).toBe(false);
    }
    const [text] = run([[makeSaida({ id: 'e2', valor: 10_00, expenseIsCredit: 'true' })], [], []]);
    expect('expenseIsCredit' in text).toBe(false);
  });
});
