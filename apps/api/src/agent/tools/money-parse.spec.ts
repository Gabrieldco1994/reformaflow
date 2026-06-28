import { parseSpokenMoney } from './money-parse';

describe('parseSpokenMoney', () => {
  it('interpreta vírgula como separador decimal (PT-BR): "206,96" => 206.96', () => {
    expect(parseSpokenMoney('206,96')).toBe(206.96);
  });

  it('não infla centavos: "206,96" nunca vira 20696', () => {
    expect(parseSpokenMoney('206,96')).not.toBe(20696);
  });

  it('milhar com ponto + decimal com vírgula: "20.696,00" => 20696', () => {
    expect(parseSpokenMoney('20.696,00')).toBe(20696);
  });

  it('milhar só com ponto (sem centavos): "1.500" => 1500', () => {
    expect(parseSpokenMoney('1.500')).toBe(1500);
  });

  it('ponto como decimal (formato US/JSON): "206.96" => 206.96', () => {
    expect(parseSpokenMoney('206.96')).toBe(206.96);
  });

  it('inteiro simples falado: "50" => 50', () => {
    expect(parseSpokenMoney('50')).toBe(50);
  });

  it('remove prefixo de moeda e espaços: "R$ 1.234,56" => 1234.56', () => {
    expect(parseSpokenMoney('R$ 1.234,56')).toBe(1234.56);
  });

  it('aceita número já decimal: 206.96 => 206.96', () => {
    expect(parseSpokenMoney(206.96)).toBe(206.96);
  });

  it('arredonda para 2 casas: 10.999 => 11', () => {
    expect(parseSpokenMoney(10.999)).toBe(11);
  });

  it('rejeita zero, negativo e lixo', () => {
    expect(parseSpokenMoney(0)).toBeNull();
    expect(parseSpokenMoney(-5)).toBeNull();
    expect(parseSpokenMoney('abc')).toBeNull();
    expect(parseSpokenMoney('')).toBeNull();
    expect(parseSpokenMoney(null)).toBeNull();
    expect(parseSpokenMoney(undefined)).toBeNull();
  });
});
