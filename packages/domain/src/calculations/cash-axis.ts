import { isNeutralExpenseType } from '../enums';
import { caixaMonthForCardPurchase } from './card-cash-month';

/**
 * Construção do EIXO DE CAIXA (vencimento) das saídas, para o cockpit PESSOAL.
 *
 * Diferente da competência (data da compra), o eixo de caixa responde "quando
 * o dinheiro VAI SAIR": compras de cartão são remapeadas para o mês de
 * vencimento da fatura (via `caixaMonthForCardPurchase`); débitos de conta
 * permanecem na competência.
 *
 * Invariantes (não quebrar — ver §0 do plano):
 * - Categorias neutras (PAGAMENTO_FATURA_CARTAO, MOVIMENTACAO_INTERNA) NÃO
 *   entram no eixo de caixa: a fatura projetada já representa essa saída e
 *   contá-las dobraria o valor.
 * - Não reescreve nenhuma data gravada — apenas deriva o ano-mês de caixa.
 *
 * Escopo: somente SAÍDAS (tipo DESPESA). Recebimentos são tratados em outra
 * camada (eixo de entradas), fora desta função.
 *
 * IMPORTANTE: `categoria` deve ser o CÓDIGO bruto do tipo de despesa (ex.:
 * 'PAGAMENTO_FATURA_CARTAO'), não o rótulo traduzido, para a detecção de
 * neutralidade funcionar.
 */

export interface CardConfig {
  /** Últimos 4 dígitos do cartão (chave de junção com a entry). */
  last4: string;
  closingDay: number | null;
  dueDay: number | null;
}

export interface CashAxisEntry {
  tipo: 'DESPESA' | 'RECEBIMENTO' | string;
  /** Código bruto do tipo de despesa (não o rótulo). */
  categoria?: string | null;
  /** Valor em centavos. */
  valor: number;
  data: Date | string;
  /** Últimos 4 dígitos do cartão de origem; null/undefined = débito de conta. */
  cardLast4?: string | null;
  /** Rótulo "k/n" quando parcelado (para o tooltip). */
  parcela?: string | null;
  /** Descrição/merchant (para o tooltip). */
  subcategoria?: string | null;
}

export interface CashAxisMonth {
  faturaCartao: number;
  debitos: number;
  total: number;
}

export interface CashAxisCardItem {
  descricao: string;
  parcela: string | null;
  valor: number;
}

export interface CashAxisCardDetail {
  mes: string;
  cardLast4: string;
  valor: number;
  itens: CashAxisCardItem[];
}

export interface CashAxisResult {
  /** Ano-mês de caixa → composição da saída. */
  porMes: Record<string, CashAxisMonth>;
  /** Detalhamento por cartão/mês para tooltips ("qual fatura"). */
  detalhePorCartao: CashAxisCardDetail[];
}

function competenciaMonth(data: Date | string): string {
  const d = data instanceof Date ? data : new Date(data);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function buildCashAxis(
  entries: CashAxisEntry[],
  cards: CardConfig[],
): CashAxisResult {
  const cardByLast4 = new Map<string, CardConfig>();
  for (const c of cards) cardByLast4.set(c.last4, c);

  const porMes: Record<string, CashAxisMonth> = {};
  const detailByKey = new Map<string, CashAxisCardDetail>();

  const ensureMonth = (mes: string): CashAxisMonth => {
    let bucket = porMes[mes];
    if (!bucket) {
      bucket = { faturaCartao: 0, debitos: 0, total: 0 };
      porMes[mes] = bucket;
    }
    return bucket;
  };

  for (const e of entries) {
    if (e.tipo !== 'DESPESA') continue; // eixo de saídas
    if (isNeutralExpenseType(e.categoria)) continue; // neutras não entram

    const isCard = !!e.cardLast4;
    if (isCard) {
      const card = cardByLast4.get(e.cardLast4 as string);
      const mes = caixaMonthForCardPurchase(
        e.data,
        card?.closingDay ?? null,
        card?.dueDay ?? null,
      );
      const bucket = ensureMonth(mes);
      bucket.faturaCartao += e.valor;
      bucket.total += e.valor;

      const key = `${mes}__${e.cardLast4}`;
      let detail = detailByKey.get(key);
      if (!detail) {
        detail = { mes, cardLast4: e.cardLast4 as string, valor: 0, itens: [] };
        detailByKey.set(key, detail);
      }
      detail.valor += e.valor;
      detail.itens.push({
        descricao: e.subcategoria ?? '',
        parcela: e.parcela ?? null,
        valor: e.valor,
      });
    } else {
      const mes = competenciaMonth(e.data);
      const bucket = ensureMonth(mes);
      bucket.debitos += e.valor;
      bucket.total += e.valor;
    }
  }

  return { porMes, detalhePorCartao: Array.from(detailByKey.values()) };
}
