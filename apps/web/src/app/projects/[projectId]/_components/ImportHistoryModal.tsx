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
      await api.delete(`${basePath}/imports/${detail.importId}`);
      setDetail(null);
      await load();
      onUndone?.();
    } catch (e) {
      const msg = e instanceof ApiResponseError ? e.message
        : e instanceof Error ? e.message : 'Não foi possível desfazer a importação.';
      setError(msg);
    } finally {
      setUndoing(false);
    }
  }

  const irrev = detail?.irreversible;
  const hasIrreversible = !!irrev && (irrev.recurrencesPropagated > 0 || irrev.notRevertibleInvoiceLiquidations > 0);

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      {/* Passo 2: preview de impacto + confirmação */}
      {detail ? (
        <div className="space-y-4">
          <button
            onClick={() => setDetail(null)}
            className="text-sm text-gray-500 hover:text-gray-800"
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
          ) : (
            <>
              <p className="text-sm text-gray-600">Ao desfazer, serão revertidos:</p>
              <ul className="space-y-1 text-sm">
                <ImpactLine label="Despesas removidas" value={detail.impact.expenses} />
                {detail.impact.receipts != null && (
                  <ImpactLine label="Recebimentos removidos" value={detail.impact.receipts} />
                )}
                <ImpactLine label="Lançamentos de caixa removidos" value={detail.impact.cashFlowEntries} />
                <ImpactLine label="Vínculos entre projetos desfeitos" value={detail.impact.crossProjectLinks} />
                {detail.impact.invoiceLiquidations != null && detail.impact.invoiceLiquidations > 0 && (
                  <ImpactLine label="Faturas de cartão reabertas (voltam a planejado)" value={detail.impact.invoiceLiquidations} />
                )}
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
                    {!!irrev && irrev.notRevertibleInvoiceLiquidations > 0 && (
                      <li>
                        {irrev.notRevertibleInvoiceLiquidations} liquidação(ões) de fatura em cartão
                        sem dia de fechamento/vencimento — reabra manualmente se necessário.
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
                  className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
                  disabled={undoing}
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmUndo}
                  disabled={undoing}
                  className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
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
            projetos e faturas liquidadas são revertidos automaticamente.
          </p>

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
                      className="flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-60"
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

function ImpactLine({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-gray-600">{label}</span>
      <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">{value}</span>
    </li>
  );
}
