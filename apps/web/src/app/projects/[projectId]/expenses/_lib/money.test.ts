import { describe, it, expect } from 'vitest';
import { reaisToCents, centsToReais } from './money';

describe('reaisToCents', () => {
  it('converte formato BR com milhar e decimal', () => {
    expect(reaisToCents('5.000,00')).toBe(500000);
  });
  it('converte formato com ponto decimal puro', () => {
    expect(reaisToCents('5000.50')).toBe(500050);
  });
  it('converte inteiro simples', () => {
    expect(reaisToCents('3200')).toBe(320000);
  });
  it('string vazia → 0', () => {
    expect(reaisToCents('')).toBe(0);
  });
  it('só espaços → 0', () => {
    expect(reaisToCents('   ')).toBe(0);
  });
  it('valor inválido → 0', () => {
    expect(reaisToCents('abc')).toBe(0);
  });
  it('negativos são suportados', () => {
    expect(reaisToCents('-100')).toBe(-10000);
    expect(reaisToCents('-1.000,50')).toBe(-100050);
  });
});

describe('centsToReais', () => {
  it('formata centavos em reais BR', () => {
    expect(centsToReais(500000)).toBe('5.000,00');
  });
  it('valor não finito → 0,00', () => {
    expect(centsToReais(Number.NaN)).toBe('0,00');
  });
});
