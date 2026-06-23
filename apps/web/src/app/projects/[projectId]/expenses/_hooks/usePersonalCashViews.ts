import { useMemo } from 'react';
import type { Expense } from '@/types';
import { isNeutralExpenseType } from '@reformaflow/domain';
import {
  buildContaReal,
  emptyContaRealMonth,
  type ContaRealCard,
  type ContaRealMonth,
} from '../_lib/conta-real';

export interface GastosControleKpis {
  /** Σ compras de cartão PAGAS do período. */
  noCartao: number;
  /** Σ débitos/à vista PAGOS direto da conta. */
  naConta: number;
  /** Σ status PLANEJADO (a confirmar). */
  aConfirmar: number;
}

export interface CartaoFormacao {
  last4: string;
  label: string;
  /** Σ lançado no período (fatura em formação). */
  lancado: number;
  pago: number;
  planejado: number;
  closingDay: number | null;
  dueDay: number | null;
  count: number;
}

interface Args {
  /** Despesas PESSOAL após busca/filtros, SEM o fatiamento por competência. */
  filteredExpenses: Expense[];
  /** Despesas PESSOAL já fatiadas pela parcela do período selecionado. */
  periodFilteredPersonal: Expense[];
  cards: ContaRealCard[];
  /** 'ALL' (ano todo) ou 'YYYY-MM'. */
  period: string;
}

/**
 * Deriva os dois eixos da tela de despesas do PESSOAL:
 * - **Gastos Controle** (competência): KPIs e strip "fatura em formação" a
 *   partir do período já fatiado.
 * - **Conta Real** (caixa): faturas por mês de vencimento + débitos, a partir
 *   do conjunto completo (remapeado por `caixaMonthForCardPurchase`).
 */
export function usePersonalCashViews({
  filteredExpenses,
  periodFilteredPersonal,
  cards,
  period,
}: Args) {
  // Gastos Controle — competência (period já fatiado por parcela: valorTotal = valor da ocorrência).
  const gastosControleKpis = useMemo<GastosControleKpis>(() => {
    let noCartao = 0;
    let naConta = 0;
    let aConfirmar = 0;
    for (const e of periodFilteredPersonal) {
      if (isNeutralExpenseType(e.tipoDespesa)) continue;
      const v = e.valorTotal;
      if (e.status === 'PLANEJADO') {
        aConfirmar += v;
      } else {
        // Apenas valores PAGOS vão para noCartao/naConta
        if (e.cardLast4) noCartao += v;
        else naConta += v;
      }
    }
    return { noCartao, naConta, aConfirmar };
  }, [periodFilteredPersonal]);

  const cartoesFormacao = useMemo<CartaoFormacao[]>(() => {
    const cardByLast4 = new Map(cards.map((c) => [c.last4, c] as const));
    const m = new Map<string, CartaoFormacao>();
    for (const e of periodFilteredPersonal) {
      if (isNeutralExpenseType(e.tipoDespesa) || !e.cardLast4) continue;
      let row = m.get(e.cardLast4);
      if (!row) {
        const c = cardByLast4.get(e.cardLast4);
        row = {
          last4: e.cardLast4,
          label: c?.label ?? `Cartão ••${e.cardLast4}`,
          lancado: 0,
          pago: 0,
          planejado: 0,
          closingDay: c?.closingDay ?? null,
          dueDay: c?.dueDay ?? null,
          count: 0,
        };
        m.set(e.cardLast4, row);
      }
      row.lancado += e.valorTotal;
      if (e.status === 'PAGO') row.pago += e.valorTotal;
      else row.planejado += e.valorTotal;
      row.count++;
    }
    return Array.from(m.values()).sort((a, b) => b.lancado - a.lancado);
  }, [periodFilteredPersonal, cards]);

  // Conta Real — caixa (usa o conjunto completo, não o slice por competência).
  const contaRealMonths = useMemo(
    () => buildContaReal(filteredExpenses, cards),
    [filteredExpenses, cards],
  );

  const selectedContaReal = useMemo<ContaRealMonth | null>(() => {
    if (period === 'ALL') return null;
    return contaRealMonths.get(period) ?? emptyContaRealMonth(period);
  }, [contaRealMonths, period]);

  const contaRealAll = useMemo<ContaRealMonth[]>(
    () => Array.from(contaRealMonths.values()).sort((a, b) => (a.mes < b.mes ? 1 : -1)),
    [contaRealMonths],
  );

  return {
    gastosControleKpis,
    cartoesFormacao,
    contaRealMonths,
    selectedContaReal,
    contaRealAll,
  };
}
