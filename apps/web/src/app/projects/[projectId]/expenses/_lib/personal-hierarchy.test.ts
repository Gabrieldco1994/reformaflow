import { describe, it, expect } from 'vitest';
import type { Expense } from '@/types';
import {
  splitPersonalExpenseBase,
  toCaixaBase,
  toDisplayBase,
  groupPersonalExpenses,
} from './personal-hierarchy';
import { groupExpensesByMes } from './grouping-by-month';

function makeExpense(patch: Partial<Expense> & { id: string }): Expense {
  return {
    tipoDespesa: 'OUTROS',
    valor: 0,
    quantidade: 1,
    valorTotal: 0,
    formaPagamento: 'A_VISTA',
    status: 'PLANEJADO',
    ...patch,
  } as Expense;
}

const targetQuinzenal = makeExpense({
  id: 'reforma-infra',
  tipoDespesa: 'MAO_DE_OBRA',
  valorTotal: 8_000_000,
  formaPagamento: 'QUINZENAL',
  quantidadeParcela: 10,
  dataInicioParcela: '2026-01-05',
  paidParcelas: '[0,1]',
  status: 'PLANEJADO',
  cardLast4: null,
  bankLast4: null,
  project: { id: 'reforma', name: 'REFORMA', type: 'REFORMA' },
});

const espelho0 = makeExpense({
  id: 'esp-0', valorTotal: 800_000, formaPagamento: 'PIX', status: 'PAGO',
  bankLast4: '3636', linkedExpenseId: 'reforma-infra', dataPagamento: '2026-01-05',
});
const espelho1 = makeExpense({
  id: 'esp-1', valorTotal: 800_000, formaPagamento: 'PIX', status: 'PAGO',
  bankLast4: '3636', linkedExpenseId: 'reforma-infra', dataPagamento: '2026-01-20',
});

describe('splitPersonalExpenseBase — classificação por forma do alvo', () => {
  it('(a) quinzenal foreign com 2 espelhos: registra parceladoTargetId, mantém alvo em mutationsBase', () => {
    const r = splitPersonalExpenseBase([espelho0, espelho1], [targetQuinzenal]);
    expect(r.parceladoTargetIds.has('reforma-infra')).toBe(true);
    expect(r.singleTargetIds.has('reforma-infra')).toBe(false);
    expect(r.mutationsBase.some((e) => e.id === 'reforma-infra')).toBe(true);
    expect(r.mutationsBase.filter((e) => e.linkedExpenseId === 'reforma-infra')).toHaveLength(2);
  });

  it('(b) à-vista foreign com espelho: alvo em singleTargetIds e FORA do mutationsBase (dedup legado)', () => {
    const alvoAvista = makeExpense({
      id: 'foreign-avista', valorTotal: 500_000, formaPagamento: 'A_VISTA',
      bankLast4: null, project: { id: 'reforma', name: 'REFORMA', type: 'REFORMA' },
    });
    const espAvista = makeExpense({
      id: 'esp-avista', valorTotal: 500_000, formaPagamento: 'PIX', status: 'PAGO',
      bankLast4: '3636', linkedExpenseId: 'foreign-avista',
    });
    const r = splitPersonalExpenseBase([espAvista], [alvoAvista]);
    expect(r.singleTargetIds.has('foreign-avista')).toBe(true);
    expect(r.parceladoTargetIds.has('foreign-avista')).toBe(false);
    expect(r.mutationsBase.some((e) => e.id === 'foreign-avista')).toBe(false);
    expect(r.mutationsBase.some((e) => e.id === 'esp-avista')).toBe(true);
  });

  it('(c) foreign parcelada SEM espelho: alvo preservado, nenhum id classificado', () => {
    const r = splitPersonalExpenseBase([], [targetQuinzenal]);
    expect(r.parceladoTargetIds.size).toBe(0);
    expect(r.singleTargetIds.size).toBe(0);
    expect(r.mutationsBase.some((e) => e.id === 'reforma-infra')).toBe(true);
  });

  it('espelho cujo alvo está ausente do cross (fora do limit): tratado como single/legado', () => {
    const espOrfao = makeExpense({
      id: 'esp-orf', bankLast4: '3636', status: 'PAGO', linkedExpenseId: 'nao-existe',
    });
    const r = splitPersonalExpenseBase([espOrfao], []);
    expect(r.singleTargetIds.has('nao-existe')).toBe(true);
    expect(r.parceladoTargetIds.size).toBe(0);
  });
});

describe('toCaixaBase / toDisplayBase — separação sem quebrar caixa (invariantes I e III)', () => {
  const { mutationsBase, parceladoTargetIds } =
    splitPersonalExpenseBase([espelho0, espelho1], [targetQuinzenal]);
  const filtered = mutationsBase;

  it('caixa: mantém os 2 espelhos e REMOVE o alvo MANUAL (não polui Conta Real)', () => {
    const caixa = toCaixaBase(filtered, parceladoTargetIds);
    expect(caixa.some((e) => e.id === 'reforma-infra')).toBe(false);
    expect(caixa.filter((e) => e.linkedExpenseId === 'reforma-infra')).toHaveLength(2);
  });

  it('display: mantém o alvo canônico e REMOVE os 2 espelhos parcelado', () => {
    const display = toDisplayBase(filtered, parceladoTargetIds);
    expect(display.some((e) => e.id === 'reforma-infra')).toBe(true);
    expect(display.filter((e) => e.linkedExpenseId === 'reforma-infra')).toHaveLength(0);
  });

  it('edge (i): espelho de CARTÃO do alvo parcelado também é escondido do display', () => {
    const espCartao = makeExpense({
      id: 'esp-card', valorTotal: 800_000, formaPagamento: 'PIX', status: 'PAGO',
      cardLast4: '1234', linkedExpenseId: 'reforma-infra',
    });
    const s = splitPersonalExpenseBase([espelho0, espCartao], [targetQuinzenal]);
    const display = toDisplayBase(s.mutationsBase, s.parceladoTargetIds);
    expect(display.some((e) => e.id === 'esp-card')).toBe(false);
    expect(display.some((e) => e.id === 'reforma-infra')).toBe(true);
  });
});

describe('groupPersonalExpenses sobre displayBase — sem dupla contagem (invariante III)', () => {
  it('(d) grupo REFORMA reflete o alvo (80k, 1 item) e NÃO os espelhos', () => {
    const { mutationsBase, parceladoTargetIds } =
      splitPersonalExpenseBase([espelho0, espelho1], [targetQuinzenal]);
    const display = toDisplayBase(mutationsBase, parceladoTargetIds);
    const groups = groupPersonalExpenses(display, new Map(), 'Pessoal', 'pessoal');
    const reforma = groups.find((g) => g.projectKey === 'reforma');
    expect(reforma).toBeDefined();
    expect(reforma!.itens).toHaveLength(1);
    expect(reforma!.itens[0].id).toBe('reforma-infra');
    expect(reforma!.totalPago + reforma!.totalPlanejado).toBe(8_000_000);
    expect(reforma!.itens.some((e) => e.linkedExpenseId === 'reforma-infra')).toBe(false);
  });
});

describe('groupExpensesByMes sobre displayBase — Visão Mensal sem dobrar o espelho', () => {
  it('(e) mês de início soma só as parcelas do alvo (16k), não alvo+espelhos (32k)', () => {
    const { mutationsBase, parceladoTargetIds } =
      splitPersonalExpenseBase([espelho0, espelho1], [targetQuinzenal]);
    const display = toDisplayBase(mutationsBase, parceladoTargetIds);
    const meses = groupExpensesByMes(display);
    // dataInicioParcela 2026-01-05 → idx0 (05/01) + idx1 (20/01) caem em jan.
    const jan = meses.find((m) => m.mesKey === '2026-01');
    expect(jan).toBeDefined();
    expect(jan!.total).toBe(1_600_000); // 2 × 8k — NÃO 3.2M (alvo + espelhos)
    // Ano inteiro: as 10 parcelas somam 80k, sem os 16k dos espelhos duplicados.
    const somaAno = meses.reduce((s, m) => s + m.total, 0);
    expect(somaAno).toBe(8_000_000);
  });

  it('(f) base CRUA (alvo + espelhos) dobraria o mês — comprova o bug evitado', () => {
    const { mutationsBase } = splitPersonalExpenseBase([espelho0, espelho1], [targetQuinzenal]);
    const meses = groupExpensesByMes(mutationsBase); // sem toDisplayBase → contém os dois
    const jan = meses.find((m) => m.mesKey === '2026-01');
    expect(jan!.total).toBe(3_200_000); // 16k (alvo) + 16k (espelhos) = dupla contagem
  });
});
