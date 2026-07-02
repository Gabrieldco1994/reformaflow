import { isSinglePaymentForm } from '@reformaflow/domain';
import type { ExpenseFormData } from '@/types';
import { buildExpenseFormData } from './wizardPayload';
import { makeEmptyWizardDraft } from '../_hooks/useNovaDespesaWizard';

/** Subconjunto de `ParsedVoiceExpense` necessário para montar o payload. */
export interface VoiceParsedLike {
  tipoDespesa: string;
  valor: number;
  formaPagamento: string;
  status: string; // 'PLANEJADO' | 'PAGO'
  dataReferencia: string;
  quantidadeParcela: number | null;
  titulo: string;
  creditCardId: string | null;
  bankAccountId: string | null;
}

const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Converte a despesa interpretada por voz no MESMO `ExpenseFormData` canônico da
 * jornada manual, reutilizando `buildExpenseFormData` (mesmas regras de forma,
 * parcela, status e competência). Só acrescenta o `linkedExpenseId` (vínculo
 * cross-project sugerido pela voz), que o builder base não inclui.
 *
 * Garante paridade voz ⇄ jornada: qualquer mudança de regra em
 * `buildExpenseFormData` reflete automaticamente no lançamento por voz.
 */
export function voiceParsedToFormData(
  parsed: VoiceParsedLike,
  opts: { fornecedor?: string; linkedExpenseId?: string; now?: Date } = {},
): ExpenseFormData {
  const now = opts.now ?? new Date();
  const single = isSinglePaymentForm(parsed.formaPagamento);
  const dref = parsed.dataReferencia || toIsoDate(now);
  const draft = {
    ...makeEmptyWizardDraft(),
    tipoDespesa: parsed.tipoDespesa,
    valor: String(parsed.valor),
    quantidade: '1',
    titulo: parsed.titulo || '',
    fornecedor: opts.fornecedor || '',
    formaPagamento: parsed.formaPagamento,
    dataPagamento: single ? dref : '',
    quantidadeParcela: single ? '' : String(parsed.quantidadeParcela || 1),
    dataInicioParcela: single ? '' : dref,
    creditCardId: parsed.creditCardId || '',
    bankAccountId: parsed.bankAccountId || '',
  };
  const mode = parsed.status === 'PAGO' ? 'PAGA' : 'PLANEJAR';
  return {
    ...buildExpenseFormData(draft, { mode, allowRecorrente: false }),
    linkedExpenseId: opts.linkedExpenseId || null,
  };
}
