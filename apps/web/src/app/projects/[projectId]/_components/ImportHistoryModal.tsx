'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Undo2, RotateCcw } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { api, ApiResponseError } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

export interface ImportRow {
  id: string;
  periodLabel: string;
  fileName: string | null;
  source: string;
  inserted: number;
  duplicated: number;
  totalAmountCents: number;
  createdAt: string;
  deletedAt: string | null;
}

/**
 * #569 PR2 (§4.2) — uma fatura tocada pelo lote. `SETTLED_BY_IMPORT` é o
 * ÚNICO estado em que a fatura foi de fato liquidada; todos os outros
 * significam "cartão identificado, mas nada foi quitado de verdade" —
 * jamais renderizar como "vinculado"/"quitado" fora desse estado.
 */
export interface ImportSettlementEntry {
  cardId: string | null;
  dueMonth: string | null;
  state: 'SETTLED_BY_IMPORT' | 'NO_SETTLEMENT' | 'OUTSIDE_SETTLEMENT_WINDOW' | 'LEGACY_NO_TRAIL' | 'DRIFT';
  hint?: 'ALREADY_PAID' | 'AMOUNT_MISMATCH' | 'NO_MATCH';
  payments: Array<{ paymentExpenseId: string; importId: string; parcelaCount: number }>;
}

interface ImportDetail {
  importId: string;
  periodLabel: string;
  fileName: string | null;
  createdAt: string;
  alreadyUndone: boolean;
  totalAmountCents: number;
  impact: {
    expenses: number;
    receipts?: number;
    cashFlowEntries: number;
    crossProjectLinks: number;
    invoiceLiquidations?: number;
    adoptedExpenses?: number;
  };
  irreversible?: {
    recurrencesPropagated: number;
    notRevertibleInvoiceLiquidations: number;
  };
  /**
   * #569 (hotfix fail-closed): `false` quando a trilha do lote não permite
   * reverter com segurança — motivo em `blockReason`. Ausente no contrato
   * antigo → tratado como permitido.
   */
  canUndo?: boolean;
  /** #569 PR2 — motivo específico do bloqueio: `LEGACY_OR_MIXED` | `TRAIL_VERSION_MISMATCH` | `INCOMPLETE_TRAIL`. */
  blockReason?: string | null;
  blocking?: {
    cardInvoicePayments: number;
  };
  /** #569 PR2 — faturas tocadas pelo lote (identificadas ou efetivamente liquidadas). */
  settlement?: ImportSettlementEntry[];
}

interface UndoResult {
  revertedInvoiceParcelas?: number;
  reopenedInvoices?: number;
}

/** #569 PR2 (§4.1) — motivo de bloqueio da PRÉVIA (`getImportDetail.blockReason`): sempre certeza de 409, botão fica desabilitado com o motivo real. */
const BLOCK_REASON_COPY: Record<string, string> = {
  LEGACY_OR_MIXED:
    'Esta importação contém um pagamento de fatura antigo, sem trilha registrada para desfazer com segurança. Ela permanece intacta.',
  TRAIL_VERSION_MISMATCH:
    'O registro deste pagamento usa uma versão de trilha que não reconhecemos mais — o desfazer foi bloqueado por segurança.',
  INCOMPLETE_TRAIL:
    'Uma ou mais parcelas ligadas a este pagamento foram alteradas por fora — o desfazer foi bloqueado para não reverter parcialmente.',
};

/** #569 PR2 (§4.1) — código de erro devolvido pelo `undoImport` no momento de confirmar (409), mapeado para copy amigável. Nunca mostrar o código bruto ao usuário. */
function undoErrorCopy(code: string): string {
  if (code === 'MANUAL_PAYMENT_OVERLAP') {
    return 'Já existe outro pagamento manual vinculado a esta mesma fatura — desfazer esta importação poderia confundir os dois. Ação bloqueada por segurança.';
  }
  if (code in BLOCK_REASON_COPY) return BLOCK_REASON_COPY[code]!;
  if (code.startsWith('DRIFT:')) {
    const reason = code.slice('DRIFT:'.length);
    const detail: Record<string, string> = {
      ENTRY_NOT_PAID: 'uma parcela não está mais marcada como paga',
      ENTRY_DELETED: 'uma parcela foi excluída',
      AMOUNT_CHANGED: 'o valor de uma parcela mudou',
      PARCELA_CHANGED: 'o parcelamento de uma parcela mudou',
      MANUAL_ADOPTION: 'uma parcela foi marcada como paga manualmente por outro caminho',
      RATEIO_MISMATCH: 'o rateio entre projetos desta compra mudou',
    };
    const what = detail[reason] ?? 'algo mudou nesta compra';
    return `Algo mudou nesta compra desde o pagamento (${what}) — o desfazer foi bloqueado para não corromper os dados. Ajuste manualmente se necessário.`;
  }
  return code;
}

const SETTLEMENT_STATE_COPY: Record<ImportSettlementEntry['state'], { cls: string; text: (dueMonth: string) => string }> = {
  SETTLED_BY_IMPORT: {
    cls: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    text: (m) => `Fatura ${m} foi quitada por este pagamento — será reaberta se você desfizer.`,
  },
  NO_SETTLEMENT: {
    cls: 'border-gray-200 bg-gray-50 text-gray-600',
    text: (m) => `Cartão identificado (fatura ${m}), mas nenhuma fatura foi quitada por este pagamento.`,
  },
  OUTSIDE_SETTLEMENT_WINDOW: {
    cls: 'border-amber-300 bg-amber-50 text-amber-900',
    text: (m) =>
      `Fatura ${m} identificada, mas fora do prazo de liquidação automática — requer confirmação manual.`,
  },
  LEGACY_NO_TRAIL: {
    cls: 'border-gray-200 bg-gray-50 text-gray-600',
    text: (m) => `Fatura ${m} — pagamento antigo sem trilha registrada, não revertível automaticamente.`,
  },
  DRIFT: {
    cls: 'border-red-200 bg-red-50 text-red-700',
    text: (m) => `Fatura ${m} — algo mudou desde a liquidação; não pode ser desfeita automaticamente.`,
  },
};

function fmtDueMonth(dueMonth: string | null): string {
  if (!dueMonth) return 'sem vencimento identificado';
  const [year, month] = dueMonth.split('-').map(Number);
  if (!year || !month) return dueMonth;
  const nome = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `de ${nome[month - 1] ?? month}/${year}`;
}

interface Props {
  /** Ex.: `/projects/${projectId}/credit-cards/${cardId}` ou `.../bank-accounts/${accountId}`. */
  basePath: string;
  title: string;
  onClose: () => void;
  /** Chamado após um desfazer bem-sucedido, para o pai recarregar saldos. */
  onUndone?: () => void;
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function ImportHistoryModal({ basePath, title, onClose, onUndone }: Props) {
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoResult, setUndoResult] = useState<UndoResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<ImportRow[]>(`${basePath}/imports`);
      setImports(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível carregar o histórico.');
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  useEffect(() => { void load(); }, [load]);

  async function openDetail(row: ImportRow) {
    setDetailLoading(true);
    setError(null);
    try {
      const d = await api.get<ImportDetail>(`${basePath}/imports/${row.id}`);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível carregar o impacto.');
    } finally {
      setDetailLoading(false);
    }
  }

  async function confirmUndo() {
    if (!detail) return;
    setUndoing(true);
    setError(null);
    try {
      const result = await api.delete<UndoResult>(`${basePath}/imports/${detail.importId}`);
      setUndoResult(result ?? null);
      setDetail(null);
      await load();
      onUndone?.();
    } catch (e) {
      const rawCode = e instanceof ApiResponseError ? e.message
        : e instanceof Error ? e.message : 'Não foi possível desfazer a importação.';
      setError(undoErrorCopy(rawCode));
    } finally {
      setUndoing(false);
    }
  }

  const irrev = detail?.irreversible;
  const hasIrreversible = !!irrev && irrev.recurrencesPropagated > 0;
  // #569 PR2: `canUndo === false` reflete um motivo CERTO de 409
  // (`blockReason`: `LEGACY_OR_MIXED` | `TRAIL_VERSION_MISMATCH` |
  // `INCOMPLETE_TRAIL`) — nunca oferecer um botão ativo cujo único resultado
  // possível já é um bloqueio conhecido. `undefined` (contrato antigo) = permitido.
  const undoBlocked = detail?.canUndo === false && !detail?.alreadyUndone;
  const blockReasonText =
    (detail?.blockReason && BLOCK_REASON_COPY[detail.blockReason]) ||
    'Esta importação contém pagamento de fatura e não pode ser desfeita automaticamente sem risco de alterar outros pagamentos.';
  const settlement = detail?.settlement ?? [];

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      {/* Passo 2: preview de impacto + confirmação */}
      {detail ? (
        <div className="space-y-4">
          <button
            onClick={() => setDetail(null)}
            className="inline-flex min-h-11 items-center text-sm text-gray-500 hover:text-gray-800"
          >
            ← Voltar ao histórico
          </button>

          <div className="rounded-lg border border-darc-linen p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-darc-velvet truncate">
                  {detail.periodLabel}
                  {detail.fileName ? ` · ${detail.fileName}` : ''}
                </div>
                <div className="text-xs text-gray-500">{fmtDate(detail.createdAt)}</div>
              </div>
              <div className="shrink-0 whitespace-nowrap text-right font-geist text-[18px] font-bold tabular-nums">
                {formatCurrency(detail.totalAmountCents / 100)}
              </div>
            </div>
          </div>

          {detail.alreadyUndone ? (
            <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
              Esta importação já foi desfeita.
            </div>
          ) : undoBlocked ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" /> Não é possível desfazer automaticamente
                </div>
                <p className="mt-1">{blockReasonText}</p>
              </div>
              {settlement.length > 0 && <SettlementList entries={settlement} />}
              {error && (
                <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setDetail(null)}
                  className="inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
                >
                  Voltar ao histórico
                </button>
                {/* Ação visível mas inerte — o usuário vê que existe e por que não pode usá-la. */}
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title={blockReasonText}
                  className="flex min-h-11 items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white opacity-50 cursor-not-allowed"
                >
                  <Undo2 className="h-4 w-4" />
                  Desfazer importação
                </button>
              </div>
            </div>
          ) : (
            <>
              {settlement.length > 0 && <SettlementList entries={settlement} />}
              <p className="text-sm text-gray-600">Ao desfazer, serão revertidos:</p>
              <ul className="space-y-1 text-sm">
                <ImpactLine label="Despesas removidas" value={detail.impact.expenses} />
                {detail.impact.receipts != null && (
                  <ImpactLine label="Recebimentos removidos" value={detail.impact.receipts} />
                )}
                <ImpactLine label="Lançamentos de caixa removidos" value={detail.impact.cashFlowEntries} />
                <ImpactLine label="Vínculos entre projetos desfeitos" value={detail.impact.crossProjectLinks} />
                {detail.impact.adoptedExpenses != null && detail.impact.adoptedExpenses > 0 && (
                  <ImpactLine label="Parcelas de série (carimbo removido, não apagadas)" value={detail.impact.adoptedExpenses} />
                )}
              </ul>

              {hasIrreversible && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                    <AlertTriangle className="h-4 w-4" /> Efeitos que NÃO serão revertidos
                  </div>
                  <ul className="mt-1 space-y-1 text-sm text-amber-800">
                    {!!irrev && irrev.recurrencesPropagated > 0 && (
                      <li>
                        {irrev.recurrencesPropagated} recorrência(s) propagada(s) em Casa/Carro
                        continuam com os valores atualizados (não há histórico para restaurar).
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {error && (
                <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setDetail(null)}
                  className="inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
                  disabled={undoing}
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmUndo}
                  disabled={undoing}
                  className="flex min-h-11 items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  <Undo2 className="h-4 w-4" />
                  {undoing ? 'Desfazendo…' : 'Desfazer importação'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        /* Passo 1: histórico de importações */
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Desfaça uma importação para remover todos os lançamentos que ela criou. Vínculos entre
            projetos são revertidos automaticamente. Lotes com pagamento de fatura permanecem
            intactos por segurança.
          </p>

          {undoResult && ((undoResult.revertedInvoiceParcelas ?? 0) > 0 || (undoResult.reopenedInvoices ?? 0) > 0) && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
              Importação desfeita: {undoResult.revertedInvoiceParcelas} parcela(s) de fatura
              revertida(s), {undoResult.reopenedInvoices} fatura(s) reaberta(s).
              <button
                type="button"
                onClick={() => setUndoResult(null)}
                className="ml-2 font-semibold underline"
              >
                Ok
              </button>
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-sm text-gray-500">Carregando…</div>
          ) : error ? (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
          ) : imports.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500">Nenhuma importação registrada.</div>
          ) : (
            <ul className="divide-y divide-darc-linen rounded-lg border border-darc-linen">
              {imports.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-darc-velvet truncate">
                      {row.periodLabel}
                      {row.fileName ? ` · ${row.fileName}` : ''}
                    </div>
                    <div className="text-xs text-gray-500">
                      {fmtDate(row.createdAt)} · {row.inserted} lançamento(s)
                      {row.duplicated > 0 ? ` · ${row.duplicated} duplicado(s)` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="whitespace-nowrap text-right font-geist text-[15px] font-bold tabular-nums">
                      {formatCurrency(row.totalAmountCents / 100)}
                    </span>
                    <button
                      onClick={() => void openDetail(row)}
                      disabled={detailLoading}
                      aria-label={`Desfazer importação ${row.periodLabel}${
                        row.fileName ? ` · ${row.fileName}` : ''
                      } · ${fmtDate(row.createdAt)}`}
                      className="flex min-h-11 items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60"
                    >
                      <RotateCcw className="h-4 w-4" /> Desfazer
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * #569 PR2 — distingue "cartão identificado" de "fatura efetivamente
 * liquidada". `SETTLED_BY_IMPORT` é o único estado que afirma quitação;
 * todo o resto é honesto sobre não ter fechado fatura nenhuma.
 */
function SettlementList({ entries }: { entries: ImportSettlementEntry[] }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">Faturas identificadas neste lote:</p>
      <ul className="space-y-1.5">
        {entries.map((entry, idx) => {
          const copy = SETTLEMENT_STATE_COPY[entry.state];
          return (
            <li
              key={`${entry.cardId ?? 'sem-cartao'}-${entry.dueMonth ?? idx}`}
              className={`rounded-lg border p-2 text-sm ${copy.cls}`}
            >
              {copy.text(fmtDueMonth(entry.dueMonth))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ImpactLine({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-gray-600">{label}</span>
      <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">{value}</span>
    </li>
  );
}
