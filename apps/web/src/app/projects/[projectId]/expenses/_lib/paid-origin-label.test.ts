import { describe, expect, it } from 'vitest';
import { buildPaidOriginIndex, formatPaidOriginLabel, pickOriginForOccurrence } from './paid-origin-label';
import type { ExpensePaidOrigin, PaidOriginRef } from '@/types';

const nubank: PaidOriginRef = { kind: 'card', last4: '3541', nickname: 'Nubank',
  institution: 'Mastercard', sourceProjectId: 'p', sourceProjectName: 'Pessoal' };
const latam: PaidOriginRef = { ...nubank, last4: '5572', nickname: 'Latam' };
const contaSemApelido: PaidOriginRef = { kind: 'bank', last4: '7424', nickname: null,
  institution: 'ITAU', sourceProjectId: 'p', sourceProjectName: 'Pessoal' };

describe('formatPaidOriginLabel', () => {
  it('usa apelido + ••last4 quando há apelido', () => {
    expect(formatPaidOriginLabel(nubank)).toBe('Nubank ••3541');
  });
  it('cai no fallback "Conta ••last4" sem apelido', () => {
    expect(formatPaidOriginLabel(contaSemApelido)).toBe('Conta ••7424');
  });
  it('cai no fallback "Cartão ••last4" sem apelido', () => {
    expect(formatPaidOriginLabel({ ...nubank, nickname: null })).toBe('Cartão ••3541');
  });
});

describe('pickOriginForOccurrence — O9 (occIndex 1-based ↔ parcelaIndex 0-based)', () => {
  const settlement: ExpensePaidOrigin = {
    expenseId: 'tgt-infra', via: 'settlement', multiple: true,
    parcelas: [{ parcelaIndex: 4, origin: nubank }, { parcelaIndex: 5, origin: latam }],
    origins: [nubank, latam],
  };

  it('occIndex 5 casa com parcelaIndex 4 (nunca 5)', () => {
    expect(pickOriginForOccurrence(settlement, 5)).toEqual(nubank);
  });
  it('occIndex 6 casa com parcelaIndex 5', () => {
    expect(pickOriginForOccurrence(settlement, 6)).toEqual(latam);
  });
  it('boundary: occIndex 1 casa com parcelaIndex 0 e NÃO é tratado como falsy', () => {
    const s: ExpensePaidOrigin = { ...settlement, parcelas: [{ parcelaIndex: 0, origin: nubank }], origins: [nubank] };
    expect(pickOriginForOccurrence(s, 1)).toEqual(nubank);
  });
  it('occIndex sem parcela correspondente devolve null (não estoura, não usa a 1ª)', () => {
    expect(pickOriginForOccurrence(settlement, 1)).toBeNull();
  });
  it('via=rateio devolve a origem agregada para QUALQUER occIndex', () => {
    const r: ExpensePaidOrigin = { expenseId: 't', via: 'rateio', parcelas: [], origins: [latam], multiple: false };
    for (const i of [1, 2, 10]) expect(pickOriginForOccurrence(r, i)).toEqual(latam);
  });
  it('via=link devolve a origem agregada para QUALQUER occIndex', () => {
    const l: ExpensePaidOrigin = { expenseId: 't', via: 'link', parcelas: [], origins: [nubank], multiple: false };
    expect(pickOriginForOccurrence(l, 3)).toEqual(nubank);
  });
  it('entrada undefined (loading/erro/sem origem) devolve null', () => {
    expect(pickOriginForOccurrence(undefined, 1)).toBeNull();
  });
});

describe('buildPaidOriginIndex', () => {
  it('indexa por expenseId e tolera resposta ausente', () => {
    expect(buildPaidOriginIndex(undefined).size).toBe(0);
    const map = buildPaidOriginIndex({ items: [
      { expenseId: 'a', via: 'link', parcelas: [], origins: [nubank], multiple: false }] });
    expect(map.get('a')!.origins[0].last4).toBe('3541');
  });
});
