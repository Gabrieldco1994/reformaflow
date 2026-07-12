import { parseJsonWithRepair } from './json-repair';

describe('parseJsonWithRepair', () => {
  it('parses valid JSON directly', () => {
    expect(parseJsonWithRepair<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('strips trailing commas', () => {
    expect(parseJsonWithRepair<{ a: number[] }>('{"a": [1, 2,]}')).toEqual({ a: [1, 2] });
  });

  it('repairs truncated JSON by dropping the dangling value and closing braces', () => {
    // simula corte no meio de uma string por MAX_TOKENS
    const truncated = '{"a": 1, "b": [1, 2], "c": "texto que foi cortado no mei';
    expect(parseJsonWithRepair<{ a: number; b: number[] }>(truncated)).toEqual({
      a: 1,
      b: [1, 2],
    });
  });

  it('throws when repair is not possible', () => {
    expect(() => parseJsonWithRepair('not json at all')).toThrow();
  });
});
