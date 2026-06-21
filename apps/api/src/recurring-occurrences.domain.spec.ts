import { buildRecurringOccurrences } from '@reformaflow/domain';

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

describe('buildRecurringOccurrences', () => {
  it('gera uma ocorrência por mês do início até o horizonte (inclusive)', () => {
    const out = buildRecurringOccurrences({
      valorTotal: 10000,
      dataInicio: d('2026-01-10'),
      recorrenciaFim: null,
      horizonEnd: d('2026-04-15'),
    });
    expect(out.map((o) => o.data.toISOString().slice(0, 10))).toEqual([
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
    ]);
    expect(out.map((o) => o.index)).toEqual([0, 1, 2, 3]);
    expect(out.every((o) => o.valor === 10000)).toBe(true);
  });

  it('respeita recorrenciaFim quando anterior ao horizonte', () => {
    const out = buildRecurringOccurrences({
      valorTotal: 5000,
      dataInicio: d('2026-01-05'),
      recorrenciaFim: d('2026-02-28'),
      horizonEnd: d('2026-12-31'),
    });
    expect(out).toHaveLength(2);
    expect(out[1].data.toISOString().slice(0, 10)).toBe('2026-02-05');
  });

  it('faz clamp do dia para meses mais curtos (dia 31)', () => {
    const out = buildRecurringOccurrences({
      valorTotal: 100,
      dataInicio: d('2026-01-31'),
      recorrenciaFim: null,
      horizonEnd: d('2026-03-31'),
    });
    expect(out.map((o) => o.data.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });

  it('retorna vazio quando o horizonte é anterior ao início', () => {
    const out = buildRecurringOccurrences({
      valorTotal: 100,
      dataInicio: d('2026-05-01'),
      recorrenciaFim: null,
      horizonEnd: d('2026-04-30'),
    });
    expect(out).toEqual([]);
  });

  it('inclui o mês do início quando o horizonte cai no mesmo mês antes do dia', () => {
    const out = buildRecurringOccurrences({
      valorTotal: 100,
      dataInicio: d('2026-06-20'),
      recorrenciaFim: null,
      horizonEnd: d('2026-06-01'),
    });
    expect(out).toHaveLength(1);
    expect(out[0].data.toISOString().slice(0, 10)).toBe('2026-06-20');
  });
});
