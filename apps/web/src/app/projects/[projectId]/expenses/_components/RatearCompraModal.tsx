'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { formatCurrency } from '@/lib/utils';
import type { Expense } from '@/types';
import { reaisToCents, centsToReais } from '../_lib/money';
import {
  useRateioDetalhe,
  type RateioDetalhe,
  type RateioDetalheItem,
} from '../_hooks/useRateioDetalhe';

/** Planejada-alvo (cross-project) retornada pela busca. */
interface CrossExpense {
  id: string;
  titulo?: string | null;
  fornecedor?: string | null;
  valorTotal: number; // centavos
  status: string;
  project?: { id: string; name: string; type: string } | null;
}

interface AllocRow {
  exp: CrossExpense;
  /** Valor alocado em reais (string editável). */
  reais: string;
}

function itemToAllocRow(item: RateioDetalheItem): AllocRow {
  return {
    exp: {
      id: item.targetExpenseId,
      titulo: item.titulo,
      fornecedor: item.fornecedor,
      valorTotal: item.plannedValorTotalCents ?? item.allocationCents,
      status: item.status,
      project: {
        id: item.projectId,
        name: item.projectName,
        type: item.projectType,
      },
    },
    reais: centsToReais(item.allocationCents),
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Compra a ratear (fonte, PESSOAL). */
  source: Expense;
  /** Projeto dono da fonte (para a busca cross-project). */
  ownerProjectId: string;
  onSubmit: (allocations: { targetExpenseId: string; allocation: number }[]) => void;
  onDesratear: () => void;
  isPending?: boolean;
}

export function RatearCompraModal({
  open,
  onClose,
  source,
  ownerProjectId,
  onSubmit,
  onDesratear,
  isPending,
}: Props) {
  const [rows, setRows] = useState<AllocRow[]>([]);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [editorDetail, setEditorDetail] = useState<RateioDetalhe>();
  const [editorSession, setEditorSession] = useState<string | null>(null);

  const sessionKey = `${ownerProjectId}:${source.id}`;
  const rateioQuery = useRateioDetalhe(ownerProjectId, source.id, { enabled: open });

  // Inicializa uma vez por compra/abertura. Atualizações da query durante a
  // sessão não podem apagar valores que a pessoa já editou localmente.
  useEffect(() => {
    if (!open) {
      setRows([]);
      setSearch('');
      setSearchOpen(false);
      setEditorDetail(undefined);
      setEditorSession(null);
      return;
    }

    if (
      !rateioQuery.data ||
      !rateioQuery.isSuccess ||
      rateioQuery.isFetching ||
      editorSession === sessionKey
    ) {
      return;
    }

    setRows(rateioQuery.data.rateado ? rateioQuery.data.items.map(itemToAllocRow) : []);
    setSearch('');
    setSearchOpen(false);
    setEditorDetail(rateioQuery.data);
    setEditorSession(sessionKey);
  }, [
    editorSession,
    open,
    rateioQuery.data,
    rateioQuery.isFetching,
    rateioQuery.isSuccess,
    sessionKey,
  ]);

  const editorReady = editorSession === sessionKey && editorDetail != null;
  const isLocked =
    editorDetail != null &&
    (editorDetail.hiddenTargetsCount > 0 || editorDetail.removedTargetsCount > 0);

  const totalCents = editorReady ? editorDetail.totalSourceCents : source.valorTotal;
  const allocatedCents = useMemo(
    () => rows.reduce((s, r) => s + reaisToCents(r.reais), 0),
    [rows],
  );
  const sobraCents = totalCents - allocatedCents;

  const { data: crossExpenses = [], isFetching } = useQuery<CrossExpense[]>({
    queryKey: ['cross-project-expenses', ownerProjectId, search],
    queryFn: () =>
      api.get(
        `/projects/${ownerProjectId}/expenses/cross-project?limit=20${
          search ? `&search=${encodeURIComponent(search)}` : ''
        }`,
      ),
    enabled: open && editorReady && !isLocked && searchOpen,
    staleTime: 20_000,
  });

  const available = useMemo(
    () => crossExpenses.filter((e) => !rows.some((r) => r.exp.id === e.id)),
    [crossExpenses, rows],
  );

  function addTarget(exp: CrossExpense) {
    if (isLocked) return;
    setRows((prev) => {
      if (prev.some((row) => row.exp.id === exp.id)) return prev;
      const prevAllocatedCents = prev.reduce((sum, row) => sum + reaisToCents(row.reais), 0);
      const suggested = Math.max(0, Math.min(totalCents - prevAllocatedCents, exp.valorTotal));
      return [...prev, { exp, reais: centsToReais(suggested) }];
    });
    setSearch('');
    setSearchOpen(false);
  }

  function updateReais(id: string, reais: string) {
    if (isLocked) return;
    setRows((prev) => prev.map((r) => (r.exp.id === id ? { ...r, reais } : r)));
  }

  function fillRemaining(id: string) {
    if (isLocked) return;
    setRows((prev) =>
      prev.map((r) => {
        if (r.exp.id !== id) return r;
        const otherAllocatedCents = prev.reduce(
          (sum, row) => sum + (row.exp.id === id ? 0 : reaisToCents(row.reais)),
          0,
        );
        const rest = totalCents - otherAllocatedCents;
        return { ...r, reais: centsToReais(Math.max(0, rest)) };
      }),
    );
  }

  function removeRow(id: string) {
    if (isLocked) return;
    setRows((prev) => prev.filter((r) => r.exp.id !== id));
  }

  const canSave =
    !isLocked &&
    rows.length > 0 &&
    sobraCents === 0 &&
    rows.every((r) => reaisToCents(r.reais) > 0);

  function handleSubmit() {
    if (!canSave) return;
    onSubmit(
      rows.map((r) => ({ targetExpenseId: r.exp.id, allocation: reaisToCents(r.reais) })),
    );
  }

  const sourceTitle = source.titulo || source.fornecedor || 'Compra';

  return (
    <Modal open={open} onClose={onClose} title="Ratear compra">
      <div className="space-y-4">
        <div className="rounded-xl border border-darc-linen bg-darc-cream/40 px-3 py-2.5">
          <p className="text-xs uppercase tracking-wide text-darc-velvet/50">Compra</p>
          <p className="font-semibold text-darc-velvet truncate">{sourceTitle}</p>
          <p className="text-sm text-darc-velvet/70">
            Total {formatCurrency(totalCents / 100)}
            {source.quantidadeParcela && source.quantidadeParcela > 1
              ? ` · ${source.quantidadeParcela}x`
              : ''}
          </p>
        </div>

        {!editorReady ? (
          rateioQuery.isError ? (
            <div className="space-y-1.5 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
              <p className="text-sm text-red-700">Erro ao carregar o rateio desta compra.</p>
              <button
                type="button"
                onClick={() => rateioQuery.refetch()}
                className="inline-flex min-h-[44px] items-center text-sm font-medium text-red-700 underline"
              >
                Tentar novamente
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-darc-linen bg-darc-cream/40 px-3 py-2.5 text-sm text-darc-velvet/60">
              Carregando rateio da compra…
            </div>
          )
        ) : (
          <>
            {isLocked && (
              <p
                role="alert"
                className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
              >
                Este rateio possui alocações ocultas ou removidas. Para evitar perda de dados, ele
                só pode ser desfeito por completo.
              </p>
            )}

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Distribuir entre planejadas de outro projeto
              </label>
              <Input
                aria-label="Distribuir entre planejadas de outro projeto"
                className="min-h-[44px]"
                placeholder="Buscar planejada por título ou fornecedor…"
                value={search}
                disabled={isLocked}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
              />
              {searchOpen && !isLocked && (
                <div className="mt-1 max-h-48 overflow-auto rounded border border-gray-200 bg-white text-sm shadow-sm">
                  {isFetching && <div className="px-3 py-2 text-gray-500">Buscando…</div>}
                  {!isFetching && available.length === 0 && (
                    <div className="px-3 py-2 text-gray-500">Nenhuma planejada disponível.</div>
                  )}
                  {available.map((exp) => (
                    <button
                      key={exp.id}
                      type="button"
                      className="block min-h-[44px] w-full px-3 py-1.5 text-left hover:bg-orange-50"
                      onClick={() => addTarget(exp)}
                    >
                      <div className="truncate font-medium text-gray-900">
                        {exp.titulo || exp.fornecedor || '—'}
                      </div>
                      <div className="text-xs text-gray-500">
                        {formatCurrency(exp.valorTotal / 100)} · {exp.status} ·{' '}
                        {exp.project?.name ?? '—'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {rows.length > 0 && (
              <div className="space-y-2">
                {rows.map((r) => (
                  <div
                    key={r.exp.id}
                    className="flex items-center gap-2 rounded-lg border border-darc-linen px-2 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-darc-velvet">
                        {r.exp.titulo || r.exp.fornecedor || '—'}
                      </div>
                      <div className="text-[11px] text-darc-velvet/50">
                        planejado {formatCurrency(r.exp.valorTotal / 100)} ·{' '}
                        {r.exp.project?.name ?? '—'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-darc-velvet/50">R$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`Valor alocado para ${r.exp.titulo || r.exp.fornecedor || 'planejada'}`}
                        className="min-h-[44px] w-24 rounded border border-gray-300 px-2 py-1 text-right text-sm tabular-nums focus:border-orange-400 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
                        value={r.reais}
                        disabled={isLocked}
                        onChange={(e) => updateReais(r.exp.id, e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      title="Preencher com a sobra"
                      aria-label={`Preencher com a sobra para ${r.exp.titulo || r.exp.fornecedor || 'planejada'}`}
                      disabled={isLocked}
                      onClick={() => fillRemaining(r.exp.id)}
                      className="min-h-[44px] rounded px-1.5 py-1 text-[11px] font-medium text-orange-700 hover:bg-orange-50 disabled:text-gray-400"
                    >
                      sobra
                    </button>
                    <button
                      type="button"
                      title="Remover"
                      aria-label={`Remover ${r.exp.titulo || r.exp.fornecedor || 'planejada'}`}
                      disabled={isLocked}
                      onClick={() => removeRow(r.exp.id)}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-darc-velvet/30 hover:bg-red-50 hover:text-red-500 disabled:text-gray-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 rounded-xl border border-darc-linen bg-white px-3 py-2 text-center">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Total</p>
                <p className="whitespace-nowrap text-sm font-semibold tabular-nums text-darc-velvet">
                  {formatCurrency(totalCents / 100)}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Rateado</p>
                <p className="whitespace-nowrap text-sm font-semibold tabular-nums text-darc-velvet">
                  {formatCurrency(allocatedCents / 100)}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Sobra</p>
                <p
                  className={`whitespace-nowrap text-sm font-semibold tabular-nums ${
                    sobraCents === 0
                      ? 'text-emerald-600'
                      : sobraCents < 0
                        ? 'text-red-600'
                        : 'text-amber-600'
                  }`}
                >
                  {formatCurrency(sobraCents / 100)}
                </p>
              </div>
            </div>

            {sobraCents !== 0 && rows.length > 0 && !isLocked && (
              <p className="flex items-center gap-1 text-xs text-amber-700">
                <X className="h-3.5 w-3.5" />
                A soma precisa fechar o total da compra (sobra zero) para salvar.
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              {editorDetail.rateado ? (
                <button
                  type="button"
                  onClick={onDesratear}
                  disabled={isPending}
                  className="min-h-[44px] text-xs text-darc-velvet/60 hover:text-red-600 hover:underline disabled:opacity-50"
                >
                  Desfazer rateio
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-[44px]"
                  onClick={onClose}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  className="min-h-[44px]"
                  onClick={handleSubmit}
                  disabled={!canSave || isPending}
                >
                  Salvar rateio
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
