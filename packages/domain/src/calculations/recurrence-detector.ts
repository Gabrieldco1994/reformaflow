/**
 * Detector de despesas recorrentes a partir das despesas que já existem.
 *
 * Motivo de existir: o app materializa recorrência como N despesas independentes
 * (não há flag nem vínculo entre elas — `Expense.recorrente` tem 0 linhas em
 * produção). Logo, a única forma de mostrar "suas recorrências" sem obrigar o
 * usuário a recadastrar tudo é DERIVAR as séries dos lançamentos existentes.
 *
 * Uma série é identificada por `key` (merchant normalizado) e precisa:
 *  - aparecer em >= `minMeses` meses distintos (default 3);
 *  - ter cadência de ~1 ocorrência por mês (`n / meses <= maxPorMes`), o que
 *    separa assinatura de merchant frequente (Uber: 36 corridas em 6 meses);
 *  - não ser settlement (pagamento de fatura / movimentação interna).
 *
 * Só `NEUTRAL_EXPENSE_TYPES` (settlement) é excluído — NUNCA o superset
 * `CONSUMPTION_NEUTRAL_EXPENSE_TYPES`: aporte em INVESTIMENTOS e PAGAMENTO_CASA
 * são recorrências legítimas e saem do caixa de verdade. Usar o superset para
 * decidir visibilidade já causou dois bugs (PRs #322/#325).
 */

import { NEUTRAL_EXPENSE_TYPES } from '../enums';

export interface RecurrenceDetectorRow {
  id: string;
  /** Merchant normalizado (agrupador da série). */
  key: string;
  tipoDespesa: string;
  /** Valor em centavos. */
  valorTotal: number;
  /** Data da ocorrência (paga OU planejada — cadência não depende de pagamento). */
  data: Date;
}

export interface DetectedSeries {
  key: string;
  /** Rótulo exibível (título original mais recente, quando informado). */
  nome: string;
  tipoDespesa: string;
  valorCentsAtual: number;
  diaVencimento: number;
  frequencia: 'MENSAL';
  ocorrencias: number;
  meses: number;
  primeiraData: Date;
  ultimaData: Date;
  expenseIds: string[];
}

export interface DetectOptions {
  minMeses?: number;
  /** Teto de ocorrências por mês. Acima disso é merchant frequente, não série. */
  maxPorMes?: number;
}

const ym = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;

/** Valor/dia/tipo mais frequente do grupo (desempate: o mais recente). */
function moda<T>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

export function detectRecurringSeries(
  rows: RecurrenceDetectorRow[],
  options: DetectOptions = {},
): DetectedSeries[] {
  const { minMeses = 3, maxPorMes = 2 } = options;

  const groups = new Map<string, RecurrenceDetectorRow[]>();
  for (const row of rows) {
    if (!row.key) continue;
    if (NEUTRAL_EXPENSE_TYPES.has(row.tipoDespesa)) continue;
    const list = groups.get(row.key);
    if (list) list.push(row);
    else groups.set(row.key, [row]);
  }

  const out: DetectedSeries[] = [];

  for (const [key, list] of groups) {
    const meses = new Set(list.map((r) => ym(r.data))).size;
    if (meses < minMeses) continue;
    if (list.length / meses > maxPorMes) continue;

    const ordered = [...list].sort((a, b) => a.data.getTime() - b.data.getTime());
    const primeira = ordered[0];
    const ultima = ordered[ordered.length - 1];
    if (!primeira || !ultima) continue;

    out.push({
      key,
      nome: key,
      tipoDespesa: moda(ordered.map((r) => r.tipoDespesa), ultima.tipoDespesa),
      valorCentsAtual: ultima.valorTotal,
      diaVencimento: moda(ordered.map((r) => r.data.getUTCDate()), ultima.data.getUTCDate()),
      // ponytail: só MENSAL. Quinzenal/anual detectáveis pela mediana do gap
      // entre ocorrências — adicionar quando aparecer uma série assim de fato.
      frequencia: 'MENSAL',
      ocorrencias: ordered.length,
      meses,
      primeiraData: primeira.data,
      ultimaData: ultima.data,
      expenseIds: ordered.map((r) => r.id),
    });
  }

  return out.sort((a, b) => b.valorCentsAtual - a.valorCentsAtual);
}
