import { isSinglePaymentForm } from '@reformaflow/domain';
import type { ExpenseFormData } from '@/types';
import type { BasketRow, WizardDraft, WizardMode } from '../_hooks/useNovaDespesaWizard';
import type { NewTarget } from '../_types';

/** String vazia (após trim) → null; caso contrário o valor trimado. */
function nullable(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export interface BuildExpenseOpts {
  mode: WizardMode;
  allowRecorrente: boolean;
}

/**
 * Monta o `ExpenseFormData` da despesa-fonte a partir do rascunho do wizard,
 * replicando EXATAMENTE as regras de `ExpensesView.tsx handleSubmit`.
 * `status` deriva do `mode` (PAGA → PAGO, PLANEJAR → PLANEJADO).
 * NÃO inclui `linkedExpenseId` (rateio é tratado à parte via ratear-mixed).
 */
export function buildExpenseFormData(draft: WizardDraft, opts: BuildExpenseOpts): ExpenseFormData {
  const { mode, allowRecorrente } = opts;
  const fp = draft.formaPagamento;
  const data: ExpenseFormData = {
    tipoDespesa: draft.tipoDespesa,
    categoriaMaoDeObra:
      draft.tipoDespesa === 'MAO_DE_OBRA' && draft.categoriaMaoDeObra
        ? draft.categoriaMaoDeObra
        : null,
    roomId: nullable(draft.roomId),
    valor: Number(draft.valor),
    quantidade: Number(draft.quantidade),
    titulo: nullable(draft.titulo),
    fornecedor: nullable(draft.fornecedor),
    link: nullable(draft.link),
    imageUrl: nullable(draft.imageUrl),
    formaPagamento: fp,
    status: mode === 'PAGA' ? 'PAGO' : 'PLANEJADO',
  };

  // Data da compra (competência) — independe da forma de pagamento.
  data.dataCompra = nullable(draft.dataCompra);

  if (isSinglePaymentForm(fp)) {
    data.dataPagamento = nullable(draft.dataPagamento);
    data.quantidadeParcela = null;
    data.dataInicioParcela = null;
    const isRec = allowRecorrente && draft.recorrente;
    data.recorrente = isRec;
    const fim = nullable(draft.recorrenciaFim); // 'YYYY-MM'
    data.recorrenciaFim = isRec && fim ? `${fim}-01` : null;
  } else if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
    const q = Number(draft.quantidadeParcela);
    data.quantidadeParcela = q > 0 ? q : null;
    data.dataInicioParcela = nullable(draft.dataInicioParcela);
    data.dataPagamento = null;
    data.recorrente = false;
    data.recorrenciaFim = null;
  }

  data.creditCardId = draft.creditCardId || null;
  data.bankAccountId = draft.bankAccountId || null;
  return data;
}

export interface RatearMixedPayload {
  newTargets: NewTarget[];
  existing: { targetExpenseId: string; allocation: number }[];
}

/**
 * Converte o cesto em payload do endpoint `ratear-mixed`.
 * EXISTING → `existing` (id + allocation em centavos).
 * NEW → `newTargets` (valor em REAIS, allocation em centavos).
 */
export function buildRatearMixedPayload(basket: BasketRow[]): RatearMixedPayload {
  const existing: RatearMixedPayload['existing'] = [];
  const newTargets: NewTarget[] = [];

  for (const row of basket) {
    if (row.kind === 'EXISTING') {
      existing.push({ targetExpenseId: row.target.id, allocation: row.allocation });
    } else {
      const d = row.draft;
      newTargets.push({
        targetProjectId: d.targetProjectId,
        tipoDespesa: d.tipoDespesa ?? '',
        valor: Number(d.valor), // REAIS
        quantidade: Number(d.quantidade) || 1,
        titulo: d.titulo || undefined,
        fornecedor: d.fornecedor || undefined,
        categoriaMaoDeObra: d.categoriaMaoDeObra || undefined,
        roomId: d.roomId || undefined,
        formaPagamento: d.formaPagamento || undefined,
        status: d.status || undefined,
        allocation: row.allocation, // centavos
      });
    }
  }

  return { newTargets, existing };
}

/**
 * Atalho: quando o cesto tem exatamente 1 alvo EXISTENTE que recebe o valor
 * cheio da compra-fonte, basta um `POST /:id/link` simples em vez de ratear.
 * Retorna `{ targetExpenseId }` ou `null` quando não se aplica.
 */
export function detectSingleLinkShortcut(
  basket: BasketRow[],
  totalFonteCents: number,
): { targetExpenseId: string } | null {
  if (basket.length !== 1) return null;
  const row = basket[0];
  if (row.kind !== 'EXISTING') return null;
  if (row.allocation !== totalFonteCents) return null;
  return { targetExpenseId: row.target.id };
}
