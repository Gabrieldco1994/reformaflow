import { describe, expect, it } from 'vitest';
import {
  centsToReaisInput,
  currencyInputToCents,
  currencyInputToNumber,
  maskCurrencyInput,
  maskCurrencyInputPositive,
} from './currency-input';

describe('currency-input', () => {
  it('maskCurrencyInput aplica máscara pt-BR automática', () => {
    expect(maskCurrencyInput('1')).toBe('0,01');
    expect(maskCurrencyInput('1234')).toBe('12,34');
    expect(maskCurrencyInput('123456')).toBe('1.234,56');
  });

  // Regressão #572: editar um estorno de -R$100 na prévia de importação salvava
  // como +R$100 porque o `\D` do replace também descartava o sinal de menos.
  it('maskCurrencyInput preserva o sinal de menos (estorno/crédito)', () => {
    expect(maskCurrencyInput('-1234')).toBe('-12,34');
    expect(maskCurrencyInput('-123456')).toBe('-1.234,56');
    // Só o sinal digitado, sem dígito ainda: mantém '-' como placeholder em vez
    // de zerar — senão o usuário nunca consegue reconstruir um negativo
    // digitando do zero (regressão observada em QA real do #572).
    expect(maskCurrencyInput('-')).toBe('-');
  });

  it('maskCurrencyInputPositive descarta o sinal de menos para campos que nunca aceitam negativo', () => {
    expect(maskCurrencyInputPositive('-1234')).toBe('12,34');
    expect(maskCurrencyInputPositive('1234')).toBe('12,34');
  });

  it('currencyInputToCents converte formato pt-BR e ponto decimal', () => {
    expect(currencyInputToCents('1.234,56')).toBe(123456);
    expect(currencyInputToCents('1234.56')).toBe(123456);
  });

  it('currencyInputToCents preserva valores negativos (estorno)', () => {
    expect(currencyInputToCents('-1.234,56')).toBe(-123456);
  });

  it('currencyInputToNumber devolve reais', () => {
    expect(currencyInputToNumber('12,34')).toBe(12.34);
  });

  it('centsToReaisInput formata centavos', () => {
    expect(centsToReaisInput(123456)).toBe('1.234,56');
  });
});
