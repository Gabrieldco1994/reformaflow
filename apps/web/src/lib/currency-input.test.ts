import { describe, expect, it } from 'vitest';
import {
  centsToReaisInput,
  currencyInputToCents,
  currencyInputToNumber,
  maskCurrencyInput,
} from './currency-input';

describe('currency-input', () => {
  it('maskCurrencyInput aplica máscara pt-BR automática', () => {
    expect(maskCurrencyInput('1')).toBe('0,01');
    expect(maskCurrencyInput('1234')).toBe('12,34');
    expect(maskCurrencyInput('123456')).toBe('1.234,56');
  });

  it('currencyInputToCents converte formato pt-BR e ponto decimal', () => {
    expect(currencyInputToCents('1.234,56')).toBe(123456);
    expect(currencyInputToCents('1234.56')).toBe(123456);
  });

  it('currencyInputToNumber devolve reais', () => {
    expect(currencyInputToNumber('12,34')).toBe(12.34);
  });

  it('centsToReaisInput formata centavos', () => {
    expect(centsToReaisInput(123456)).toBe('1.234,56');
  });
});
