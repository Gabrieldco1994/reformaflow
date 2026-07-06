import { describe, it, expect } from 'vitest';
import { buildRecurrenceDates, isRecurrenceFrequency } from '../src';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('isRecurrenceFrequency', () => {
  it('aceita MENSAL e QUINZENAL, rejeita o resto', () => {
    expect(isRecurrenceFrequency('MENSAL')).toBe(true);
    expect(isRecurrenceFrequency('QUINZENAL')).toBe(true);
    expect(isRecurrenceFrequency('SEMANAL')).toBe(false);
    expect(isRecurrenceFrequency(null)).toBe(false);
    expect(isRecurrenceFrequency('')).toBe(false);
  });
});

describe('buildRecurrenceDates — MENSAL', () => {
  it('gera uma ocorrência por mês, mesmo dia, início e fim inclusivos', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 10),
      fim: utc(2026, 4, 10),
      frequencia: 'MENSAL',
    });
    expect(out.map(iso)).toEqual(['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10']);
  });

  it('clamp para o último dia do mês quando o dia não existe (31 → fev)', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 31),
      fim: utc(2026, 3, 31),
      frequencia: 'MENSAL',
    });
    // jan 31, fev 28 (2026 não bissexto), mar 31
    expect(out.map(iso)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('início == fim gera 1 ocorrência', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 6, 5),
      fim: utc(2026, 6, 5),
      frequencia: 'MENSAL',
    });
    expect(out.map(iso)).toEqual(['2026-06-05']);
  });

  it('fim antes do início retorna vazio', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 6, 5),
      fim: utc(2026, 5, 5),
      frequencia: 'MENSAL',
    });
    expect(out).toEqual([]);
  });

  it('fim no meio do mês não inclui a ocorrência posterior', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 20),
      fim: utc(2026, 3, 10),
      frequencia: 'MENSAL',
    });
    // jan 20, fev 20 (mar 20 > fim 10/mar → fora)
    expect(out.map(iso)).toEqual(['2026-01-20', '2026-02-20']);
  });
});

describe('buildRecurrenceDates — QUINZENAL', () => {
  it('gera a cada 15 dias, inclusivo', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 1),
      fim: utc(2026, 2, 15),
      frequencia: 'QUINZENAL',
    });
    // 01/01, 16/01, 31/01, 15/02
    expect(out.map(iso)).toEqual(['2026-01-01', '2026-01-16', '2026-01-31', '2026-02-15']);
  });

  it('para na data limite exata', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 1),
      fim: utc(2026, 1, 16),
      frequencia: 'QUINZENAL',
    });
    expect(out.map(iso)).toEqual(['2026-01-01', '2026-01-16']);
  });
});

describe('buildRecurrenceDates — teto de segurança', () => {
  it('respeita maxOcorrencias', () => {
    const out = buildRecurrenceDates({
      inicio: utc(2026, 1, 1),
      fim: utc(2100, 1, 1),
      frequencia: 'MENSAL',
      maxOcorrencias: 5,
    });
    expect(out).toHaveLength(5);
  });
});
