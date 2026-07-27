import { describe, it, expect } from 'vitest';
import {
  detectRecurringSeries,
  isRecurrenceFrequency,
  buildRecurrenceDates,
  type DetectedSeries,
  type RecurrenceDetectorRow,
} from '../src';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (dt: Date) => dt.toISOString().slice(0, 10);

// Gera `count` ocorrências mensais (dia 10) a partir de jan/2026.
const monthly = (
  key: string,
  tipoDespesa: string,
  valorCents: number,
  count: number,
): RecurrenceDetectorRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${key}-${i}`,
    key,
    tipoDespesa,
    valorTotal: valorCents,
    data: utc(2026, 1 + i, 10),
  }));

// 8 séries reais (amostra do brief)
const REAL_SERIES: RecurrenceDetectorRow[] = [
  ...monthly('spotify', 'ASSINATURAS', 2390, 6),
  ...monthly('google one', 'ASSINATURAS', 999, 6),
  ...monthly('netflix', 'ASSINATURAS', 5990, 4),
  ...monthly('tim', 'ASSINATURAS', 8882, 6),
  ...monthly('eletropaulo', 'MORADIA', 24489, 5),
  ...monthly('vivo', 'ASSINATURAS', 14318, 5),
  ...monthly('petlove', 'PETS', 10986, 6),
  ...monthly('ifood club', 'ASSINATURAS', 1990, 6),
];

// Falsos positivos que o detector TEM que rejeitar:
// uber: merchant frequente (36 ocorrências em 6 meses → ~6/mês)
const UBER = Array.from({ length: 36 }, (_, i) => ({
  id: `uber-${i}`,
  key: 'uber uber trip',
  tipoDespesa: 'TRANSPORTE',
  valorTotal: 1500 + i,
  data: utc(2026, 1 + (i % 6), 1 + (i % 27)),
}));
// iof: taxa (20 ocorrências / 6 meses → ratio alto)
const IOF = Array.from({ length: 20 }, (_, i) => ({
  id: `iof-${i}`,
  key: 'iof compra internacional',
  tipoDespesa: 'OUTROS',
  valorTotal: 320 + i,
  data: utc(2026, 1 + (i % 6), 2 + (i % 20)),
}));
// settlement/neutro: fatura paga (mensal → passa no ratio, mas é neutro)
const SETTLEMENT = monthly('fatura paga person multi', 'PAGAMENTO_FATURA_CARTAO', 521200, 6);

const keysOf = (out: DetectedSeries[]) => new Set(out.map((s) => s.key));

describe('detectRecurringSeries — aceita as 8 séries reais', () => {
  const out = detectRecurringSeries([...REAL_SERIES]);
  it('detecta exatamente as 8 assinaturas/contas recorrentes', () => {
    expect(keysOf(out)).toEqual(
      new Set(['spotify', 'google one', 'netflix', 'tim', 'eletropaulo', 'vivo', 'petlove', 'ifood club']),
    );
  });
  it('valorCentsAtual e diaVencimento vêm dos dados (spotify = 2390, dia 10)', () => {
    const spotify = out.find((s) => s.key === 'spotify')!;
    expect(spotify.valorCentsAtual).toBe(2390);
    expect(spotify.diaVencimento).toBe(10);
    expect(spotify.frequencia).toBe('MENSAL');
    expect(spotify.tipoDespesa).toBe('ASSINATURAS');
  });
});

describe('detectRecurringSeries — rejeita falsos positivos reais', () => {
  const out = detectRecurringSeries([...REAL_SERIES, ...UBER, ...IOF, ...SETTLEMENT]);
  const keys = keysOf(out);
  it('rejeita uber (merchant frequente: n >> meses)', () => {
    expect(keys.has('uber uber trip')).toBe(false);
  });
  it('rejeita iof (taxa: ratio alto + token de taxa)', () => {
    expect(keys.has('iof compra internacional')).toBe(false);
  });
  it('rejeita fatura paga (settlement/neutro via NEUTRAL_EXPENSE_TYPES)', () => {
    expect(keys.has('fatura paga person multi')).toBe(false);
  });
  it('não contamina as 8 reais', () => {
    expect(out.filter((s) => ['spotify', 'netflix', 'vivo'].includes(s.key))).toHaveLength(3);
  });
});

describe('detectRecurringSeries — NÃO usa o superset CONSUMPTION_NEUTRAL para visibilidade', () => {
  it('DETECTA aporte mensal INVESTIMENTOS (é recorrência legítima; superset rejeitaria — bug travado)', () => {
    const out = detectRecurringSeries(monthly('aporte xp', 'INVESTIMENTOS', 50000, 6));
    expect(keysOf(out).has('aporte xp')).toBe(true);
  });
  it('DETECTA PAGAMENTO_CASA recorrente (idem: fica no caixa, não é settlement)', () => {
    const out = detectRecurringSeries(monthly('mesada casa', 'PAGAMENTO_CASA', 120000, 6));
    expect(keysOf(out).has('mesada casa')).toBe(true);
  });
});

describe('detectRecurringSeries — boundaries de meses (>=3)', () => {
  it('rejeita quem aparece em só 2 meses distintos', () => {
    const out = detectRecurringSeries(monthly('curta', 'ASSINATURAS', 1000, 2));
    expect(out).toHaveLength(0);
  });
  it('aceita no limite exato de 3 meses', () => {
    const out = detectRecurringSeries(monthly('limite', 'ASSINATURAS', 1000, 3));
    expect(keysOf(out).has('limite')).toBe(true);
  });
});

describe('buildRecurrenceDates — frequências unificadas (BIMESTRAL..ANUAL)', () => {
  it('BIMESTRAL = passo de 2 meses', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 10), fim: utc(2026, 7, 10), frequencia: 'BIMESTRAL' as any,
    });
    expect(out.map(iso)).toEqual(['2026-01-10', '2026-03-10', '2026-05-10', '2026-07-10']);
  });
  it('SEMESTRAL = passo de 6 meses', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 15), fim: utc(2026, 12, 31), frequencia: 'SEMESTRAL' as any,
    });
    expect(out.map(iso)).toEqual(['2026-01-15', '2026-07-15']);
  });
  it('ANUAL = passo de 12 meses', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 3, 5), fim: utc(2028, 3, 5), frequencia: 'ANUAL' as any,
    });
    expect(out.map(iso)).toEqual(['2026-03-05', '2027-03-05', '2028-03-05']);
  });
});

describe('isRecurrenceFrequency — aceita as 6 unificadas', () => {
  it.each(['MENSAL', 'QUINZENAL', 'BIMESTRAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'])(
    'aceita %s', (f) => expect(isRecurrenceFrequency(f)).toBe(true),
  );
  it('rejeita SEMANAL e vazio', () => {
    expect(isRecurrenceFrequency('SEMANAL')).toBe(false);
    expect(isRecurrenceFrequency('')).toBe(false);
  });
});
