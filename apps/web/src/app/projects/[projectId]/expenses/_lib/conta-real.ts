import type { Expense, ExpenseStatus } from '@/types';
import { caixaMonthForCardPurchase, isNeutralExpenseType } from '@reformaflow/domain';
import { expandExpenseOccurrences, type Occurrence } from './grouping-by-month';

/**
 * Derivação da "Conta Real" (eixo de CAIXA) da tela de despesas do PESSOAL.
 *
 * Diferente da competência (data da compra), a Conta Real responde "o que SAI
 * da conta no mês": compras de cartão são remapeadas para o mês de VENCIMENTO
 * da fatura (via `caixaMonthForCardPurchase`) e agregadas por cartão/fatura;
 * débitos diretos da conta permanecem na competência.
 *
 * Invariantes (ver §0 do PLANO_COCKPIT_PESSOAL):
 * - Categorias neutras (PAGAMENTO_FATURA_CARTAO, MOVIMENTACAO_INTERNA) NÃO
 *   entram: a fatura projetada já representa a saída do cartão; contar as duas
 *   dobraria o valor.
 * - Não reescreve nenhuma data gravada — apenas deriva o ano-mês de vencimento.
 * - Parceladas são expandidas em ocorrências; cada parcela tem sua própria data
 *   de compra e, portanto, seu próprio mês de vencimento.
 */

export interface ContaRealCard {
  last4: string;
  label: string;
  closingDay: number | null;
  dueDay: number | null;
}

export interface FaturaItem {
  occKey: string;
  expenseId: string;
  descricao: string;
  parcela: string | null; // "k/n" quando parcelado
  valor: number; // centavos
  status: ExpenseStatus;
  data: string; // data da compra (competência), ISO
}

export interface FaturaCartao {
  cardLast4: string;
  label: string;
  mes: string; // 'YYYY-MM' de vencimento
  dueDay: number | null;
  valor: number;
  pago: number;
  planejado: number;
  itens: FaturaItem[];
}

export interface DebitoOcc {
  occ: Occurrence;
  valor: number;
  status: ExpenseStatus;
  data: string;
}

export interface ContaRealMonth {
  mes: string; // 'YYYY-MM' de vencimento/saída
  faturas: FaturaCartao[];
  debitos: DebitoOcc[];
  totalFaturas: number;
  totalDebitos: number;
  pago: number;
  planejado: number;
  total: number;
}

function competenciaMonth(dateIso: string): string {
  return dateIso.slice(0, 7);
}

/**
 * Constrói o eixo de caixa por mês de vencimento.
 * @returns Map 'YYYY-MM' → composição da saída (faturas + débitos).
 */
export function buildContaReal(
  expenses: Expense[],
  cards: ContaRealCard[],
): Map<string, ContaRealMonth> {
  const cardByLast4 = new Map<string, ContaRealCard>();
  for (const c of cards) cardByLast4.set(c.last4, c);

  const months = new Map<string, ContaRealMonth>();
  const faturaIndex = new Map<string, FaturaCartao>();

  const ensureMonth = (mes: string): ContaRealMonth => {
    let m = months.get(mes);
    if (!m) {
      m = {
        mes,
        faturas: [],
        debitos: [],
        totalFaturas: 0,
        totalDebitos: 0,
        pago: 0,
        planejado: 0,
        total: 0,
      };
      months.set(mes, m);
    }
    return m;
  };

  for (const e of expenses) {
    if (isNeutralExpenseType(e.tipoDespesa)) continue;
    for (const occ of expandExpenseOccurrences(e)) {
      if (!occ.occDate) continue;
      const status = occ.status as ExpenseStatus;

      if (e.cardLast4) {
        const card = cardByLast4.get(e.cardLast4) ?? null;
        const mes = caixaMonthForCardPurchase(
          occ.occDate,
          card?.closingDay ?? null,
          card?.dueDay ?? null,
        );
        const month = ensureMonth(mes);
        const fkey = `${mes}__${e.cardLast4}`;
        let fatura = faturaIndex.get(fkey);
        if (!fatura) {
          fatura = {
            cardLast4: e.cardLast4,
            label: card?.label ?? `Cartão ••${e.cardLast4}`,
            mes,
            dueDay: card?.dueDay ?? null,
            valor: 0,
            pago: 0,
            planejado: 0,
            itens: [],
          };
          faturaIndex.set(fkey, fatura);
          month.faturas.push(fatura);
        }
        fatura.valor += occ.occValue;
        if (status === 'PAGO') fatura.pago += occ.occValue;
        else fatura.planejado += occ.occValue;
        fatura.itens.push({
          occKey: occ.occKey,
          expenseId: e.id,
          descricao: e.titulo || e.fornecedor || '',
          parcela: occ.occTotalParcelas > 1 ? `${occ.occIndex}/${occ.occTotalParcelas}` : null,
          valor: occ.occValue,
          status,
          data: occ.occDate,
        });
        month.totalFaturas += occ.occValue;
        month.total += occ.occValue;
        if (status === 'PAGO') month.pago += occ.occValue;
        else month.planejado += occ.occValue;
      } else {
        const mes = competenciaMonth(occ.occDate);
        const month = ensureMonth(mes);
        month.debitos.push({ occ, valor: occ.occValue, status, data: occ.occDate });
        month.totalDebitos += occ.occValue;
        month.total += occ.occValue;
        if (status === 'PAGO') month.pago += occ.occValue;
        else month.planejado += occ.occValue;
      }
    }
  }

  for (const m of months.values()) {
    m.faturas.sort((a, b) => b.valor - a.valor);
    m.debitos.sort((a, b) => (a.data < b.data ? 1 : -1));
    for (const f of m.faturas) f.itens.sort((a, b) => (a.data < b.data ? 1 : -1));
  }
  return months;
}

/** Mês de caixa vazio (placeholder quando o mês selecionado não tem saídas). */
export function emptyContaRealMonth(mes: string): ContaRealMonth {
  return {
    mes,
    faturas: [],
    debitos: [],
    totalFaturas: 0,
    totalDebitos: 0,
    pago: 0,
    planejado: 0,
    total: 0,
  };
}
