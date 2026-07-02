import { describe, it, expect } from 'vitest';
import { spendByOrigin } from './spend-by-origin';
import type { MonthlyEntry } from '../_types';

function entry(patch: Partial<MonthlyEntry>): MonthlyEntry {
  return {
    id: Math.random().toString(36).slice(2),
    data: '2026-07-10',
    tipo: 'DESPESA',
    status: 'PAGO',
    valor: 0,
    categoria: 'Material',
    categoriaCodigo: 'MATERIAL_CONSTRUCAO',
    subcategoria: null,
    formaPagamento: 'A_VISTA',
    projectId: 'p1',
    projectName: 'P',
    projectType: 'PESSOAL',
    ...patch,
  };
}

describe('spendByOrigin', () => {
  it('soma despesas por cartão (cardLast4)', () => {
    const { cards } = spendByOrigin([
      entry({ cardLast4: '1234', valor: 100 }),
      entry({ cardLast4: '1234', valor: 250 }),
      entry({ cardLast4: '5678', valor: 40 }),
    ]);
    expect(cards.get('1234')).toBe(350);
    expect(cards.get('5678')).toBe(40);
  });

  it('soma despesas por conta (bankLast4)', () => {
    const { accounts } = spendByOrigin([
      entry({ bankLast4: '3636', valor: 500 }),
      entry({ bankLast4: '3636', valor: 200 }),
    ]);
    expect(accounts.get('3636')).toBe(700);
  });

  it('ignora recebimentos (tipo RECEBIMENTO)', () => {
    const { cards, accounts } = spendByOrigin([
      entry({ tipo: 'RECEBIMENTO', bankLast4: '3636', valor: 9000 }),
      entry({ tipo: 'RECEBIMENTO', cardLast4: '1234', valor: 100 }),
    ]);
    expect(accounts.size).toBe(0);
    expect(cards.size).toBe(0);
  });

  it('exclui neutros (ex.: pagamento de fatura) para não dobrar gasto', () => {
    const { accounts } = spendByOrigin([
      entry({ bankLast4: '3636', categoriaCodigo: 'PAGAMENTO_FATURA_CARTAO', valor: 5000 }),
      entry({ bankLast4: '3636', categoriaCodigo: 'MATERIAL_CONSTRUCAO', valor: 300 }),
    ]);
    expect(accounts.get('3636')).toBe(300);
  });

  it('prioriza cartão quando ambos presentes (compra no cartão)', () => {
    const { cards, accounts } = spendByOrigin([
      entry({ cardLast4: '1234', bankLast4: '3636', valor: 80 }),
    ]);
    expect(cards.get('1234')).toBe(80);
    expect(accounts.size).toBe(0);
  });

  it('entradas sem origem (manual) não contam', () => {
    const { cards, accounts } = spendByOrigin([entry({ valor: 999 })]);
    expect(cards.size).toBe(0);
    expect(accounts.size).toBe(0);
  });
});
