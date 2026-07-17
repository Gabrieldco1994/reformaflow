import { describe, it, expect } from 'vitest';
import { reaisToCents, centsToReais, maskReaisInput } from './money';

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

describe('maskReaisInput', () => {
  it('aplica máscara automática pt-BR', () => {
    expect(maskReaisInput('1')).toBe('0,01');
    expect(maskReaisInput('12')).toBe('0,12');
    expect(maskReaisInput('1234')).toBe('12,34');
    expect(maskReaisInput('123456')).toBe('1.234,56');
  });

  it('ignora caracteres não numéricos', () => {
    expect(maskReaisInput('R$ 1.234,56')).toBe('1.234,56');
  });
});
