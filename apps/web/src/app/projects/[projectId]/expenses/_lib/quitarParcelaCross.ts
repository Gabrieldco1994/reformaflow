import { buildInstallments, isSinglePaymentForm } from '@reformaflow/domain';
import type { ExpenseFormData } from '@/types';
import type { AccountViewSaida } from '../../conta/_types';

/**
 * Helpers puros da quitação de parcela cross-project no PESSOAL.
 *
 * Regra-raiz: uma parcela de despesa de OUTRO projeto, quando quitada pela conta
 * pessoal, NUNCA pode ser marcada como paga "no vazio" — isso a faz sumir da
 * Visão Conta. Ela precisa gerar um MOVIMENTO real (espelho no PESSOAL) que é
 * então conciliado com a parcela-alvo. Estas funções montam esse fluxo em duas
 * etapas testáveis, sem depender de React.
 */

/** Uma parcela cross-project ainda PENDENTE, extraída da Visão Conta. */
export interface PendingForeignParcela {
  /** Id da despesa-alvo (no projeto de origem). */
  foreignExpenseId: string;
  /** Índice 0-based da parcela dentro da despesa-alvo. */
  parcelaIndex: number;
  /** Valor da parcela em centavos. */
  valor: number;
  descricao: string;
  /** Data sugerida (ISO) da ocorrência da parcela. */
  data: string;
  projetoOrigem: { id: string; name: string; type: string } | null;
}

/**
 * Parseia o id sintético "<foreignExpenseId>#<parcelaIndex>" emitido pelo
 * backend para parcelas cross-project pendentes (ex.: "cmow625abc#3").
 * Retorna `null` se não houver "#" ou se o índice não for inteiro >= 0.
 */
export function parseForeignParcelaId(
  id: string,
): { foreignExpenseId: string; parcelaIndex: number } | null {
  if (!id) return null;
  const hash = id.lastIndexOf('#');
  if (hash <= 0 || hash === id.length - 1) return null;
  const foreignExpenseId = id.slice(0, hash);
  const raw = id.slice(hash + 1);
  // Índice deve ser um inteiro não-negativo puro (sem sinal, sem decimais).
  if (!/^\d+$/.test(raw)) return null;
  const parcelaIndex = Number(raw);
  if (!Number.isInteger(parcelaIndex) || parcelaIndex < 0) return null;
  return { foreignExpenseId, parcelaIndex };
}

/**
 * Extrai da lista de saídas da Visão Conta apenas as parcelas cross-project
 * ainda PENDENTES: têm `foreignExpenseId`, `parcelaIndex != null` e
 * `realizado === false`. Ignora saídas normais e parcelas já realizadas.
 */
export function expandPendingForeignParcelas(
  saidas: AccountViewSaida[],
): PendingForeignParcela[] {
  const out: PendingForeignParcela[] = [];
  for (const s of saidas) {
    if (!s.foreignExpenseId) continue;
    if (s.parcelaIndex == null) continue;
    if (s.realizado) continue;
    out.push({
      foreignExpenseId: s.foreignExpenseId,
      parcelaIndex: s.parcelaIndex,
      valor: s.valor,
      descricao: s.descricao,
      data: s.data,
      projetoOrigem: s.projetoOrigem,
    });
  }
  return out;
}

/** Meio de pagamento do espelho: conta bancária ou cartão. */
export type QuitacaoMeio =
  | { kind: 'bank'; bankAccountId: string; forma?: 'A_VISTA' | 'PIX' }
  | { kind: 'card'; cardId: string };

/** Converte `paidParcelas` (JSON string ou array) num Set de índices pagos. */
export function parsePaidParcelaSet(
  paidParcelas: string | number[] | null | undefined,
): Set<number> {
  if (Array.isArray(paidParcelas)) {
    return new Set(paidParcelas.filter((n) => Number.isInteger(n) && n >= 0));
  }
  if (typeof paidParcelas === 'string' && paidParcelas.trim()) {
    try {
      const parsed = JSON.parse(paidParcelas);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((n) => Number.isInteger(n) && n >= 0));
      }
    } catch {
      /* ignore JSON inválido */
    }
  }
  return new Set<number>();
}

/** Uma despesa-alvo (de outro projeto) selecionável para quitação no wizard. */
export interface QuitacaoTargetExpense {
  id: string;
  titulo?: string | null;
  fornecedor?: string | null;
  tipoDespesa: string;
  valorTotal: number;
  formaPagamento?: string | null;
  dataPagamento?: string | null;
  dataInicioParcela?: string | null;
  quantidadeParcela?: number | null;
  paidParcelas?: string | number[] | null;
}

export interface ParcelaQuitacaoSuggestion {
  parcelaIndex: number;
  /** Valor SUGERIDO da parcela (centavos) — total para pagamento único. */
  valorSugerido: number;
  /** Data ISO (YYYY-MM-DD) da parcela sugerida. */
  dataSugerida: string;
}

/**
 * Sugere qual parcela quitar ao escolher uma despesa cross-project no wizard.
 *
 * - Pagamento único → índice 0, valor = valorTotal.
 * - Parcelada/quinzenal → PRIMEIRA parcela ainda não paga (`paidParcelas`),
 *   valor = valor da própria parcela (nunca o total), data = vencimento dela.
 *
 * Isso evita dois bugs: re-liquidar uma parcela já paga (índice 0 fixo) e
 * sugerir o valor total (ex.: R$80.000) em vez do da parcela (R$8.000).
 */
export function suggestParcelaQuitacao(
  exp: QuitacaoTargetExpense,
  today: Date = new Date(),
): ParcelaQuitacaoSuggestion {
  const isoToday = today.toISOString().slice(0, 10);
  if (isSinglePaymentForm(exp.formaPagamento ?? '')) {
    return {
      parcelaIndex: 0,
      valorSugerido: exp.valorTotal,
      dataSugerida: (exp.dataPagamento ?? exp.dataInicioParcela ?? isoToday).slice(0, 10),
    };
  }
  const slices = buildInstallments({
    valorTotal: exp.valorTotal,
    formaPagamento: exp.formaPagamento as never,
    dataPagamento: exp.dataPagamento ? new Date(exp.dataPagamento) : null,
    quantidadeParcela: exp.quantidadeParcela ?? null,
    dataInicioParcela: exp.dataInicioParcela ? new Date(exp.dataInicioParcela) : null,
  });
  const n = Math.max(1, slices.length);
  const paid = parsePaidParcelaSet(exp.paidParcelas);
  let idx = 0;
  while (idx < n && paid.has(idx)) idx += 1;
  if (idx >= n) idx = n - 1; // todas pagas: última (idempotência do backend cobre)
  const slice = slices[idx];
  return {
    parcelaIndex: idx,
    valorSugerido: slice?.valor ?? exp.valorTotal,
    dataSugerida: (slice?.data instanceof Date
      ? slice.data.toISOString()
      : exp.dataInicioParcela ?? isoToday
    ).slice(0, 10),
  };
}

/**
 * Sugere a quitação de uma parcela ESPECÍFICA (índice explícito) de uma despesa
 * cross-project — usado quando o usuário alterna o status de uma parcela pontual
 * na lista da Visão Projeto PESSOAL (não a primeira pendente).
 *
 * - Pagamento único → índice 0, valor = valorTotal.
 * - Parcelada/quinzenal → valor/data da parcela pedida (clamp do índice ao range).
 */
export function suggestParcelaQuitacaoAt(
  exp: QuitacaoTargetExpense,
  parcelaIndex: number,
  today: Date = new Date(),
): ParcelaQuitacaoSuggestion {
  const isoToday = today.toISOString().slice(0, 10);
  if (isSinglePaymentForm(exp.formaPagamento ?? '')) {
    return {
      parcelaIndex: 0,
      valorSugerido: exp.valorTotal,
      dataSugerida: (exp.dataPagamento ?? exp.dataInicioParcela ?? isoToday).slice(0, 10),
    };
  }
  const slices = buildInstallments({
    valorTotal: exp.valorTotal,
    formaPagamento: exp.formaPagamento as never,
    dataPagamento: exp.dataPagamento ? new Date(exp.dataPagamento) : null,
    quantidadeParcela: exp.quantidadeParcela ?? null,
    dataInicioParcela: exp.dataInicioParcela ? new Date(exp.dataInicioParcela) : null,
  });
  const n = Math.max(1, slices.length);
  const idx = Math.min(Math.max(0, parcelaIndex), n - 1);
  const slice = slices[idx];
  return {
    parcelaIndex: idx,
    valorSugerido: slice?.valor ?? exp.valorTotal,
    dataSugerida: (slice?.data instanceof Date
      ? slice.data.toISOString()
      : exp.dataInicioParcela ?? isoToday
    ).slice(0, 10),
  };
}

export interface BuildEspelhoQuitacaoInput {
  descricao: string;
  /** Valor da parcela em CENTAVOS (como vem da Visão Conta). */
  valorCentavos: number;
  /** Data de pagamento (ISO YYYY-MM-DD). */
  dataPagamento: string;
  /** Tipo de despesa NÃO-neutro (não usar tipos neutros que não contam caixa). */
  tipoDespesa: string;
  meio: QuitacaoMeio;
}

/**
 * O espelho de quitação usa sempre uma forma de pagamento de PARCELA ÚNICA
 * (`A_VISTA` por padrão, `PIX` opcional para conta): ele representa UM
 * pagamento realizado hoje pela conta pessoal, não uma nova parcelação. O meio
 * (conta vs cartão) é discriminado pelos vínculos `bankAccountId`/`creditCardId`,
 * e não por um valor de `formaPagamento` — a domain `PaymentForm` não possui um
 * membro "cartão de crédito"; o cartão é identificado pelo `creditCardId`.
 *
 * `valor` é emitido em REAIS (o backend converte para centavos, cf.
 * expense.service), com `quantidade = 1`.
 */
export function buildEspelhoQuitacaoPayload(
  input: BuildEspelhoQuitacaoInput,
): ExpenseFormData {
  const { descricao, valorCentavos, dataPagamento, tipoDespesa, meio } = input;
  const formaPagamento = meio.kind === 'bank' ? meio.forma ?? 'A_VISTA' : 'A_VISTA';
  return {
    tipoDespesa,
    categoriaMaoDeObra: null,
    roomId: null,
    valor: valorCentavos / 100,
    quantidade: 1,
    titulo: descricao || null,
    fornecedor: null,
    link: null,
    imageUrl: null,
    formaPagamento,
    dataPagamento,
    dataCompra: dataPagamento,
    quantidadeParcela: null,
    dataInicioParcela: null,
    status: 'PAGO',
    recorrente: false,
    recorrenciaFim: null,
    creditCardId: meio.kind === 'card' ? meio.cardId : null,
    bankAccountId: meio.kind === 'bank' ? meio.bankAccountId : null,
    linkedExpenseId: null,
  };
}
