import { describe, it, expect } from 'vitest';
import { moneyShort, moneyExact } from './money';

describe('moneyShort', () => {
  it('abrevia milhares com sinal antes do R$', () => {
    expect(moneyShort(-20506238)).toBe('-R$ 205 mil');
    expect(moneyShort(641400)).toBe('R$ 6,4 mil');
    expect(moneyShort(5959537)).toBe('R$ 60 mil');
  });
  it('abrevia milhões', () => {
    expect(moneyShort(150000000)).toBe('R$ 1,5 mi');
  });
  it('mostra valores pequenos sem casas', () => {
    expect(moneyShort(99000)).toBe('R$ 990');
    expect(moneyShort(0)).toBe('R$ 0');
  });
  it('faixa 1k–10k usa uma casa', () => {
    expect(moneyShort(120000)).toBe('R$ 1,2 mil');
  });
});

describe('moneyExact', () => {
  it('mostra centavos com sinal antes do R$', () => {
    expect(moneyExact(-20506238)).toBe('-R$ 205.062,38');
    expect(moneyExact(115876)).toBe('R$ 1.158,76');
  });
});
