import { describe, it, expect } from 'vitest';
import { DEFAULT_TIPO_OPTIONS, PESSOAL_TIPO_OPTIONS, getReceiptTipoOptions } from './tipo-options';

describe('getReceiptTipoOptions', () => {
  it('returns PESSOAL_TIPO_OPTIONS for PESSOAL projects', () => {
    expect(getReceiptTipoOptions('PESSOAL')).toBe(PESSOAL_TIPO_OPTIONS);
  });

  it('returns DEFAULT_TIPO_OPTIONS for every other project type', () => {
    expect(getReceiptTipoOptions('REFORMA')).toBe(DEFAULT_TIPO_OPTIONS);
    expect(getReceiptTipoOptions('COMPRA')).toBe(DEFAULT_TIPO_OPTIONS);
    expect(getReceiptTipoOptions('CASA')).toBe(DEFAULT_TIPO_OPTIONS);
    expect(getReceiptTipoOptions('CARRO')).toBe(DEFAULT_TIPO_OPTIONS);
    expect(getReceiptTipoOptions('PLANTAS')).toBe(DEFAULT_TIPO_OPTIONS);
  });
});
