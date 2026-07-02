import { describe, it, expect } from 'vitest';
import {
  novaDespesaReducer,
  makeInitialWizardState,
  canSaveBasket,
  sobraCents,
  totalFonteCents,
  type WizardState,
} from './useNovaDespesaWizard';

// Compra-fonte de R$ 15.000,00 = 1.500.000 centavos (valor 15000 × qtd 1).
function baseState(): WizardState {
  const s = makeInitialWizardState('PLANEJAR');
  return novaDespesaReducer(s, {
    type: 'SET_DRAFT',
    patch: { tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: '15000', quantidade: '1' },
  });
}

function firstId(state: WizardState): string {
  return state.basket[0].id;
}

describe('alocação do cesto', () => {
  it('total = 1.500.000 centavos', () => {
    expect(totalFonteCents(baseState().draft)).toBe(1_500_000);
  });

  it('cesto vazio → sobra igual ao total e canSave=false', () => {
    const s = baseState();
    expect(sobraCents(s)).toBe(1_500_000);
    expect(canSaveBasket(s)).toBe(false);
  });

  it('sobra ≠ 0 (5.000 de 15.000) → canSave=false', () => {
    let s = baseState();
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    s = novaDespesaReducer(s, { type: 'BASKET_SET_ALLOC', id: firstId(s), cents: 500_000 });
    expect(sobraCents(s)).toBe(1_000_000);
    expect(canSaveBasket(s)).toBe(false);
  });

  it('existente 5.000 + nova 10.000 = 15.000 → canSave=true', () => {
    let s = baseState();
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    const idA = firstId(s);
    s = novaDespesaReducer(s, {
      type: 'BASKET_ADD_NEW',
      draft: { targetProjectId: 'p2', tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: '10000' },
    });
    const idB = s.basket[1].id;
    s = novaDespesaReducer(s, { type: 'BASKET_SET_ALLOC', id: idA, cents: 500_000 });
    s = novaDespesaReducer(s, { type: 'BASKET_SET_ALLOC', id: idB, cents: 1_000_000 });
    expect(sobraCents(s)).toBe(0);
    expect(canSaveBasket(s)).toBe(true);
  });

  it('alloc <= 0 em alguma linha → canSave=false mesmo com sobra 0', () => {
    let s = baseState();
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    const idA = firstId(s);
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't2' } });
    const idB = s.basket[1].id;
    s = novaDespesaReducer(s, { type: 'BASKET_SET_ALLOC', id: idA, cents: 1_500_000 });
    s = novaDespesaReducer(s, { type: 'BASKET_SET_ALLOC', id: idB, cents: 0 });
    expect(sobraCents(s)).toBe(0);
    expect(canSaveBasket(s)).toBe(false);
  });

  it('over-alloc (16.000) → sobra negativa e canSave=false', () => {
    let s = baseState();
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    s = novaDespesaReducer(s, { type: 'BASKET_SET_ALLOC', id: firstId(s), cents: 1_600_000 });
    expect(sobraCents(s)).toBe(-100_000);
    expect(canSaveBasket(s)).toBe(false);
  });

  it('BASKET_FILL_REMAINING preenche exatamente a sobra', () => {
    let s = baseState();
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    const idA = firstId(s);
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't2' } });
    const idB = s.basket[1].id;
    s = novaDespesaReducer(s, { type: 'BASKET_SET_ALLOC', id: idA, cents: 400_000 });
    s = novaDespesaReducer(s, { type: 'BASKET_FILL_REMAINING', id: idB });
    expect(s.basket[1].allocation).toBe(1_100_000);
    expect(sobraCents(s)).toBe(0);
    expect(canSaveBasket(s)).toBe(true);
  });

  it('BASKET_REMOVE retira a linha', () => {
    let s = baseState();
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    const idA = firstId(s);
    s = novaDespesaReducer(s, { type: 'BASKET_REMOVE', id: idA });
    expect(s.basket).toHaveLength(0);
  });
});
