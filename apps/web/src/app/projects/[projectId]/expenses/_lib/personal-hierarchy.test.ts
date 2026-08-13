import { describe, it, expect } from 'vitest';
import type { Expense } from '@/types';
import {
  splitPersonalExpenseBase,
  toCaixaBase,
  toDisplayBase,
  groupPersonalExpenses,
  totalsOf,
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

// ─── Issue #428 follow-up: bug real "Telha Norte" — fonte PESSOAL rateada em
// N alvos REFORMA aparecia com total dobrado, pois `splitPersonalExpenseBase`
// reusava `linkedExpenseId` (dedup legado de UM alvo) para suprimir só o 1º
// alvo do rateio; os demais alvos permaneciam visíveis e somavam junto da
// fonte. Observado: fonte 1000 rateada em 3 alvos (400+350+250) exibia 1600
// (1000 + 350 + 250) — só o alvo de 400 (apontado por linkedExpenseId) era
// escondido. Correto: 1000 (só a fonte), TODOS os 3 alvos suprimidos.
describe('splitPersonalExpenseBase — rateio (RateioAllocation) suprime TODOS os alvos, não só o de linkedExpenseId', () => {
  const sourceTelhaNorte = makeExpense({
    id: 'src-telha-norte',
    titulo: 'Telha Norte',
    valorTotal: 100_000, // R$ 1.000
    formaPagamento: 'A_VISTA',
    status: 'PAGO',
    dataPagamento: '2026-06-10',
    bankLast4: '3636',
    linkedExpenseId: 'tgt-telha', // 1º alvo, setado pelo back (ratearSource)
  });
  const tgtTelha = makeExpense({
    id: 'tgt-telha', titulo: 'Telhas da reforma', valorTotal: 40_000,
    formaPagamento: 'A_VISTA', status: 'PAGO',
    project: { id: 'reforma', name: 'Reforma', type: 'REFORMA' },
  });
  const tgtPiso = makeExpense({
    id: 'tgt-piso', titulo: 'Piso da reforma', valorTotal: 35_000,
    formaPagamento: 'A_VISTA', status: 'PAGO',
    project: { id: 'reforma', name: 'Reforma', type: 'REFORMA' },
  });
  const tgtArgamassa = makeExpense({
    id: 'tgt-argamassa', titulo: 'Argamassa da reforma', valorTotal: 25_000,
    formaPagamento: 'A_VISTA', status: 'PAGO',
    project: { id: 'reforma', name: 'Reforma', type: 'REFORMA' },
  });

  it('1 alvo rateado: já funcionava por coincidência (single legado cobre o único alvo)', () => {
    const rateioTargetsBySource = new Map([['src-telha-norte', ['tgt-telha']]]);
    const r = splitPersonalExpenseBase(
      [sourceTelhaNorte],
      [tgtTelha],
      rateioTargetsBySource,
    );
    expect(r.rateioTargetIds.has('tgt-telha')).toBe(true);
    expect(r.mutationsBase.some((e) => e.id === 'tgt-telha')).toBe(false);
    const { pago } = totalsOf(r.mutationsBase);
    expect(pago).toBe(100_000); // só a fonte — 1000
  });

  it('BUG REAL: 3 alvos rateados — SEM o fix, 2 dos 3 alvos vazam e dobram o total (1600 em vez de 1000)', () => {
    // Reproduz o comportamento ANTIGO (pré-fix): chama sem `rateioTargetsBySource`,
    // simulando que o código só enxergava o vínculo `linkedExpenseId` (dedup legado).
    const rLegacyPath = splitPersonalExpenseBase(
      [sourceTelhaNorte],
      [tgtTelha, tgtPiso, tgtArgamassa],
      // sem terceiro argumento: só o path legado (linkedExpenseId) atua
    );
    // Confirma o bug: só tgt-telha é suprimido; piso e argamassa vazam.
    expect(rLegacyPath.mutationsBase.some((e) => e.id === 'tgt-telha')).toBe(false);
    expect(rLegacyPath.mutationsBase.some((e) => e.id === 'tgt-piso')).toBe(true);
    expect(rLegacyPath.mutationsBase.some((e) => e.id === 'tgt-argamassa')).toBe(true);
    const { pago: pagoBug } = totalsOf(rLegacyPath.mutationsBase);
    expect(pagoBug).toBe(160_000); // 1000 (fonte) + 350 (piso) + 250 (argamassa) = 1600 — O BUG

    // Com o fix: passando `rateioTargetsBySource` com TODOS os 3 alvos, nenhum
    // vaza e o total volta a ser só a fonte (1000).
    const rateioTargetsBySource = new Map([
      ['src-telha-norte', ['tgt-telha', 'tgt-piso', 'tgt-argamassa']],
    ]);
    const rFixed = splitPersonalExpenseBase(
      [sourceTelhaNorte],
      [tgtTelha, tgtPiso, tgtArgamassa],
      rateioTargetsBySource,
    );
    expect(rFixed.rateioTargetIds).toEqual(
      new Set(['tgt-telha', 'tgt-piso', 'tgt-argamassa']),
    );
    expect(rFixed.mutationsBase.some((e) => e.id === 'tgt-telha')).toBe(false);
    expect(rFixed.mutationsBase.some((e) => e.id === 'tgt-piso')).toBe(false);
    expect(rFixed.mutationsBase.some((e) => e.id === 'tgt-argamassa')).toBe(false);
    expect(rFixed.mutationsBase).toHaveLength(1);
    expect(rFixed.mutationsBase[0].id).toBe('src-telha-norte');
    const { pago } = totalsOf(rFixed.mutationsBase);
    expect(pago).toBe(100_000); // correto — 1000, a fonte conta uma única vez
  });

  it('não regride a quitação cross-project legítima (não-rateio): continua igual', () => {
    // Mesmo cenário do teste (b) já existente: espelho + alvo à-vista, SEM
    // rateio nenhum (rateioTargetsBySource vazio/ausente) — dedup legado intacto.
    const alvoAvista = makeExpense({
      id: 'foreign-avista', valorTotal: 500_000, formaPagamento: 'A_VISTA',
      bankLast4: null, project: { id: 'reforma', name: 'REFORMA', type: 'REFORMA' },
    });
    const espAvista = makeExpense({
      id: 'esp-avista', valorTotal: 500_000, formaPagamento: 'PIX', status: 'PAGO',
      bankLast4: '3636', linkedExpenseId: 'foreign-avista',
    });
    const r = splitPersonalExpenseBase([espAvista], [alvoAvista], new Map());
    expect(r.singleTargetIds.has('foreign-avista')).toBe(true);
    expect(r.rateioTargetIds.size).toBe(0);
    expect(r.mutationsBase.some((e) => e.id === 'foreign-avista')).toBe(false);
    expect(r.mutationsBase.some((e) => e.id === 'esp-avista')).toBe(true);
  });

  it('quinzenal foreign SEM rateio continua preservado em mutationsBase (regressão da suíte (a))', () => {
    const r = splitPersonalExpenseBase([espelho0, espelho1], [targetQuinzenal]);
    expect(r.rateioTargetIds.size).toBe(0);
    expect(r.parceladoTargetIds.has('reforma-infra')).toBe(true);
    expect(r.mutationsBase.some((e) => e.id === 'reforma-infra')).toBe(true);
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
