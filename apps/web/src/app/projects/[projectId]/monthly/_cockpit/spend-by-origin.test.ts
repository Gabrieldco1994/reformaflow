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

  it('exclui neutro pago PELA CONTA (liquidação de fatura) em ambos os eixos', () => {
    // neutro-na-conta: isNeutral + bankLast4 → nunca conta (compras já contaram na fatura)
    const liquidacaoConta = entry({
      bankLast4: '3636',
      isNeutral: true,
      tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
      valor: 5000,
    });
    const consumoConta = entry({ bankLast4: '3636', isNeutral: false, valor: 300 });
    // competência (padrão)
    expect(spendByOrigin([liquidacaoConta, consumoConta]).accounts.get('3636')).toBe(300);
    // caixa
    const caixa = spendByOrigin([liquidacaoConta, consumoConta], { keepCardSettlement: true });
    expect(caixa.accounts.get('3636')).toBe(300);
    expect(caixa.accounts.size).toBe(1);
  });

  it('eixo caixa MANTÉM neutro cobrado NO CARTÃO (cartão paga cartão)', () => {
    const entries = [
      entry({ cardLast4: '7259', isNeutral: false, valor: 200000 }),
      entry({ cardLast4: '7259', isNeutral: false, valor: 143530 }),
      entry({ cardLast4: '7259', bankLast4: null, isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO', valor: 559783 }),
      entry({ cardLast4: '7259', bankLast4: null, isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO', valor: 664442 }),
    ];
    // Vai sair (caixa): soma tudo = R$ 15.677,55 (bate com a fatura da Visão Conta)
    expect(spendByOrigin(entries, { keepCardSettlement: true }).cards.get('7259')).toBe(1567755);
  });

  it('eixo competência (Gastei) EXCLUI neutro no cartão — só consumo real', () => {
    const entries = [
      entry({ cardLast4: '7259', isNeutral: false, valor: 200000 }),
      entry({ cardLast4: '7259', isNeutral: false, valor: 143530 }),
      entry({ cardLast4: '7259', bankLast4: null, isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO', valor: 559783 }),
      entry({ cardLast4: '7259', bankLast4: null, isNeutral: true, tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO', valor: 664442 }),
    ];
    // Gastei: só o consumo não-neutro = R$ 3.435,30
    expect(spendByOrigin(entries).cards.get('7259')).toBe(343530);
  });

  it('neutro com bankLast4 é excluído mesmo tendo cardLast4 (regra ancora em bankLast4)', () => {
    const both = entry({ cardLast4: '7259', bankLast4: '3636', isNeutral: true, valor: 999 });
    const caixa = spendByOrigin([both], { keepCardSettlement: true });
    expect(caixa.cards.size).toBe(0);
    expect(caixa.accounts.size).toBe(0);
    const comp = spendByOrigin([both]);
    expect(comp.cards.size).toBe(0);
    expect(comp.accounts.size).toBe(0);
  });

  it('não regride cartões sem cartão-paga-cartão (consumo puro)', () => {
    const entries = [
      entry({ cardLast4: '4444', isNeutral: false, valor: 442034 }), // Nubank
      entry({ cardLast4: '8888', isNeutral: false, valor: 733384 }), // Personalite
    ];
    for (const opts of [{}, { keepCardSettlement: true }]) {
      const { cards } = spendByOrigin(entries, opts);
      expect(cards.get('4444')).toBe(442034);
      expect(cards.get('8888')).toBe(733384);
    }
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
