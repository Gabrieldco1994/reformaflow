import { describe, it, expect } from 'vitest';
import { spendTree } from './spend-tree';
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

describe('spendTree', () => {
  it('quebra origem → tipo de despesa, ordenado por valor desc', () => {
    const tree = spendTree([
      entry({ cardLast4: '1234', categoria: 'Moradia', valor: 300 }),
      entry({ cardLast4: '1234', categoria: 'Lazer', valor: 100 }),
      entry({ cardLast4: '1234', categoria: 'Moradia', valor: 200 }),
      entry({ bankLast4: '3636', categoria: 'Alimentação', valor: 700 }),
    ]);
    // total = 300+100+200+700 = 1300
    expect(tree.total).toBe(1300);
    // origens ordenadas por total: conta 3636 (700) > cartão 1234 (600)
    expect(tree.origins.map((o) => `${o.kind}:${o.last4}`)).toEqual(['account:3636', 'card:1234']);
    const cartao = tree.origins.find((o) => o.last4 === '1234')!;
    expect(cartao.total).toBe(600);
    // tipos do cartão: Moradia (500) antes de Lazer (100)
    expect(cartao.tipos).toEqual([
      { tipo: 'Moradia', valor: 500 },
      { tipo: 'Lazer', valor: 100 },
    ]);
  });

  it('ignora recebimentos e entradas sem origem', () => {
    const tree = spendTree([
      entry({ tipo: 'RECEBIMENTO', bankLast4: '3636', valor: 9000 }),
      entry({ valor: 500 }), // sem origem
      entry({ cardLast4: '1234', valor: 250 }),
    ]);
    expect(tree.total).toBe(250);
    expect(tree.origins).toHaveLength(1);
  });

  it('respeita neutro por eixo (mesma regra do spendByOrigin)', () => {
    const entries = [
      entry({ cardLast4: '7259', categoria: 'Compras', isNeutral: false, valor: 200000 }),
      entry({
        cardLast4: '7259',
        bankLast4: null,
        categoria: 'Pagamento de fatura',
        isNeutral: true,
        tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
        valor: 559783,
      }),
    ];
    // caixa: mantém o neutro cobrado no cartão (cartão paga cartão)
    const caixa = spendTree(entries, { keepCardSettlement: true });
    expect(caixa.origins[0]!.total).toBe(200000 + 559783);
    // competência: exclui o neutro → só o consumo
    const comp = spendTree(entries);
    expect(comp.origins[0]!.total).toBe(200000);
    expect(comp.origins[0]!.tipos).toEqual([{ tipo: 'Compras', valor: 200000 }]);
  });

  it('escopo PESSOAL deduplica espelho cross-project', () => {
    const entries = [
      entry({ cardLast4: '7259', projectId: 'pessoal', projectType: 'PESSOAL', isEspelho: true, valor: 741534 }),
      entry({ cardLast4: '7259', projectId: 'reforma', projectType: 'REFORMA', valor: 741533 }),
      entry({ cardLast4: '7259', projectId: 'pessoal', projectType: 'PESSOAL', valor: 345027 }),
    ];
    const tree = spendTree(entries, { keepCardSettlement: true, pessoalProjectId: 'pessoal' });
    expect(tree.origins[0]!.total).toBe(741534 + 345027);
  });

  it('tipo nulo/vazio cai em "Outros"', () => {
    const tree = spendTree([entry({ cardLast4: '1234', categoria: null, valor: 90 })]);
    expect(tree.origins[0]!.tipos).toEqual([{ tipo: 'Outros', valor: 90 }]);
  });

  it("modo 'real' (padrão) conta só realizado (PAGO/EM_CAIXA); ignora PLANEJADO", () => {
    const entries = [
      entry({ cardLast4: '1234', status: 'PAGO', valor: 300 }),
      entry({ cardLast4: '1234', status: 'PLANEJADO', valor: 700 }),
      entry({ bankLast4: '3636', status: 'EM_CAIXA', valor: 50 }),
    ];
    const real = spendTree(entries);
    expect(real.total).toBe(350); // 300 (PAGO) + 50 (EM_CAIXA)
    expect(real.origins.find((o) => o.last4 === '1234')!.total).toBe(300);
  });

  it("modo 'realPlus' soma realizado + planejado", () => {
    const entries = [
      entry({ cardLast4: '1234', status: 'PAGO', valor: 300 }),
      entry({ cardLast4: '1234', status: 'PLANEJADO', valor: 700 }),
    ];
    const plus = spendTree(entries, { statusMode: 'realPlus' });
    expect(plus.total).toBe(1000);
    expect(plus.origins[0]!.total).toBe(1000);
  });
});
