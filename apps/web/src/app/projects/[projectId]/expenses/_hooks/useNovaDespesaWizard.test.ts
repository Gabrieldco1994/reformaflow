import { describe, it, expect } from 'vitest';
import {
  novaDespesaReducer,
  makeInitialWizardState,
  type WizardState,
  type WizardDraft,
} from './useNovaDespesaWizard';

function start(mode: 'PLANEJAR' | 'PAGA' = 'PLANEJAR'): WizardState {
  return novaDespesaReducer(makeInitialWizardState(), { type: 'START', mode });
}

function setDraft(state: WizardState, patch: Partial<WizardDraft>): WizardState {
  return novaDespesaReducer(state, { type: 'SET_DRAFT', patch });
}

describe('novaDespesaReducer — START / RESET', () => {
  it('START vai para DADOS com cesto vazio', () => {
    const s = start();
    expect(s.step).toBe('DADOS');
    expect(s.basket).toEqual([]);
    expect(s.mode).toBe('PLANEJAR');
  });

  it('RESET zera draft e cesto preservando o mode', () => {
    let s = start('PAGA');
    s = setDraft(s, { tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: '100' });
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    s = novaDespesaReducer(s, { type: 'RESET' });
    expect(s.step).toBe('DADOS');
    expect(s.basket).toEqual([]);
    expect(s.draft.tipoDespesa).toBe('');
    expect(s.mode).toBe('PAGA');
  });
});

describe('novaDespesaReducer — NEXT em DADOS', () => {
  it('bloqueia com tipo vazio', () => {
    let s = setDraft(start(), { valor: '10', quantidade: '1' });
    s = novaDespesaReducer(s, { type: 'NEXT' });
    expect(s.step).toBe('DADOS');
  });

  it('bloqueia valor <= 0 e vazio', () => {
    for (const valor of ['0', '-1', '']) {
      let s = setDraft(start(), { tipoDespesa: 'MATERIAL_CONSTRUCAO', valor, quantidade: '1' });
      s = novaDespesaReducer(s, { type: 'NEXT' });
      expect(s.step).toBe('DADOS');
    }
  });

  it('bloqueia MAO_DE_OBRA sem categoria em REFORMA', () => {
    let s = setDraft(start(), { tipoDespesa: 'MAO_DE_OBRA', valor: '10', quantidade: '1' });
    s = novaDespesaReducer(s, { type: 'NEXT', isReforma: true });
    expect(s.step).toBe('DADOS');
  });

  it('permite MAO_DE_OBRA sem categoria fora de REFORMA', () => {
    let s = setDraft(start(), { tipoDespesa: 'MAO_DE_OBRA', valor: '10', quantidade: '1' });
    s = novaDespesaReducer(s, { type: 'NEXT', isReforma: false });
    expect(s.step).toBe('PAGAMENTO');
  });

  it('passa com tipo + valor=1 + qtd=1', () => {
    let s = setDraft(start(), { tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: '1', quantidade: '1' });
    s = novaDespesaReducer(s, { type: 'NEXT' });
    expect(s.step).toBe('PAGAMENTO');
  });
});

describe('novaDespesaReducer — NEXT em PAGAMENTO', () => {
  function atPagamento(mode: 'PLANEJAR' | 'PAGA', patch: Partial<WizardDraft>): WizardState {
    let s = setDraft(start(mode), {
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: '10',
      quantidade: '1',
      ...patch,
    });
    s = novaDespesaReducer(s, { type: 'NEXT' });
    return s; // agora em PAGAMENTO (se avançou)
  }

  it('PAGA + A_VISTA exige dataPagamento', () => {
    let s = atPagamento('PAGA', { formaPagamento: 'A_VISTA', dataPagamento: '' });
    expect(s.step).toBe('PAGAMENTO');
    s = novaDespesaReducer(s, { type: 'NEXT' });
    expect(s.step).toBe('PAGAMENTO'); // bloqueado

    s = novaDespesaReducer(s, { type: 'SET_DRAFT', patch: { dataPagamento: '2026-01-10' } });
    s = novaDespesaReducer(s, { type: 'NEXT' });
    expect(s.step).toBe('ACAO');
  });

  it('PARCELADO exige quantidadeParcela >= 1', () => {
    let s = atPagamento('PLANEJAR', { formaPagamento: 'PARCELADO', quantidadeParcela: '0' });
    s = novaDespesaReducer(s, { type: 'NEXT' });
    expect(s.step).toBe('PAGAMENTO'); // 0 falha

    s = novaDespesaReducer(s, { type: 'SET_DRAFT', patch: { quantidadeParcela: '1' } });
    s = novaDespesaReducer(s, { type: 'NEXT' });
    expect(s.step).toBe('ACAO'); // 1 passa
  });
});

describe('novaDespesaReducer — BACK / GO_BASKET', () => {
  it('BACK preserva draft e cesto', () => {
    let s = setDraft(start(), {
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: '10',
      quantidade: '1',
      formaPagamento: 'A_VISTA',
    });
    s = novaDespesaReducer(s, { type: 'NEXT' }); // PAGAMENTO
    s = novaDespesaReducer(s, { type: 'BASKET_ADD_EXISTING', target: { id: 't1' } });
    s = novaDespesaReducer(s, { type: 'BACK' }); // volta p/ DADOS
    expect(s.step).toBe('DADOS');
    expect(s.draft.tipoDespesa).toBe('MATERIAL_CONSTRUCAO');
    expect(s.basket).toHaveLength(1);
  });

  it('GO_BASKET vai para CESTO sem perder draft', () => {
    let s = setDraft(start(), { tipoDespesa: 'MATERIAL_CONSTRUCAO', valor: '10' });
    s = novaDespesaReducer(s, { type: 'GO_BASKET' });
    expect(s.step).toBe('CESTO');
    expect(s.draft.tipoDespesa).toBe('MATERIAL_CONSTRUCAO');
  });
});

describe('novaDespesaReducer — APPLY_SUGGESTION / tipoDespesaTouched', () => {
  it('estado inicial começa com tipoDespesaTouched=false', () => {
    const s = start();
    expect(s.tipoDespesaTouched).toBe(false);
  });

  it('APPLY_SUGGESTION aplica tipoDespesa quando ainda não tocado', () => {
    let s = start();
    s = novaDespesaReducer(s, { type: 'APPLY_SUGGESTION', tipoDespesa: 'MAO_DE_OBRA' });
    expect(s.draft.tipoDespesa).toBe('MAO_DE_OBRA');
  });

  it('APPLY_SUGGESTION NÃO aplica quando já tocado (usuário mudou manualmente)', () => {
    let s = start();
    s = setDraft(s, { tipoDespesa: 'MATERIAL_CONSTRUCAO' }); // marca touched=true
    s = novaDespesaReducer(s, { type: 'APPLY_SUGGESTION', tipoDespesa: 'MAO_DE_OBRA' });
    expect(s.draft.tipoDespesa).toBe('MATERIAL_CONSTRUCAO');
  });

  it('SET_DRAFT com patch de tipoDespesa marca tipoDespesaTouched=true', () => {
    let s = start();
    expect(s.tipoDespesaTouched).toBe(false);
    s = setDraft(s, { tipoDespesa: 'MATERIAL_CONSTRUCAO' });
    expect(s.tipoDespesaTouched).toBe(true);
  });

  it('SET_DRAFT sem tipoDespesa no patch NÃO marca touched', () => {
    let s = start();
    s = setDraft(s, { valor: '100' });
    expect(s.tipoDespesaTouched).toBe(false);
  });

  it('RESET zera tipoDespesaTouched', () => {
    let s = start();
    s = setDraft(s, { tipoDespesa: 'MATERIAL_CONSTRUCAO' });
    expect(s.tipoDespesaTouched).toBe(true);
    s = novaDespesaReducer(s, { type: 'RESET' });
    expect(s.tipoDespesaTouched).toBe(false);
  });
});
