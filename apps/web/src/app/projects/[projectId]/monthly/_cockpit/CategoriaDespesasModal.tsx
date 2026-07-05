'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CreditCard, Landmark, Pencil, Check, X, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { getExpenseOptions } from '../../expenses/_types';
import type { MonthlyEntry } from '../_types';
import { fmtMoneyExact, mesCurto } from './format';
import { despesasDaCategoriaAno } from './derive';

/**
 * Pop-up com as despesas consideradas para uma categoria no gráfico "Categorias
 * do ano". Já filtrado pela mesma base das barras (espelho/neutro fora) e pelo
 * modo Realizado / Realizado+planejado ativo no gráfico. Permite reclassificar o
 * tipo de despesa de cada lançamento (PATCH na Expense de origem).
 */
export default function CategoriaDespesasModal({
  categoria,
  entries,
  year,
  statusMode,
  onClose,
}: {
  categoria: string | null;
  entries: MonthlyEntry[];
  year: number;
  statusMode: 'real' | 'realPlus';
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [novoTipo, setNovoTipo] = useState<string>('');

  const itens = useMemo(
    () => (categoria ? despesasDaCategoriaAno(entries, year, categoria, statusMode) : []),
    [categoria, entries, year, statusMode],
  );
  const total = useMemo(() => itens.reduce((s, e) => s + e.valor, 0), [itens]);

  const mutation = useMutation({
    mutationFn: ({ projectId, expenseId, tipoDespesa }: { projectId: string; expenseId: string; tipoDespesa: string }) =>
      api.patch(`/projects/${projectId}/expenses/${expenseId}`, { tipoDespesa }),
    onSuccess: () => {
      toast.success('Tipo de despesa atualizado');
      // Recarrega o cockpit (entries) e a Visão Conta, que dependem do tipo.
      queryClient.invalidateQueries({ queryKey: ['monthly-overview'] });
      queryClient.invalidateQueries({ queryKey: ['account-view'] });
      queryClient.invalidateQueries({ queryKey: ['card-invoices-yearly'] });
      queryClient.invalidateQueries({ queryKey: ['origin-items-yearly'] });
      setEditingId(null);
      setNovoTipo('');
    },
    onError: (e: Error) => toast.error(`Erro ao atualizar: ${e.message}`),
  });

  function dataCurta(iso: string): string {
    const dia = iso.slice(8, 10);
    const m0 = parseInt(iso.slice(5, 7), 10) - 1;
    return `${dia} ${mesCurto(m0)}`;
  }

  function startEdit(e: MonthlyEntry) {
    setEditingId(e.id);
    setNovoTipo(e.tipoDespesaCodigo ?? '');
  }

  function confirmEdit(e: MonthlyEntry) {
    if (!e.expenseId || !novoTipo || novoTipo === e.tipoDespesaCodigo) {
      setEditingId(null);
      return;
    }
    mutation.mutate({ projectId: e.projectId, expenseId: e.expenseId, tipoDespesa: novoTipo });
  }

  return (
    <Modal open={!!categoria} onClose={onClose} title={categoria ?? ''} size="lg" variant="auto">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <span className="text-xs text-gray-500">
          {itens.length} lançamento{itens.length === 1 ? '' : 's'} · {year} ·{' '}
          {statusMode === 'real' ? 'só pagas' : 'pagas + planejadas'}
        </span>
        <span className="font-geist tabular-nums text-lg font-bold text-gray-900">{fmtMoneyExact(total)}</span>
      </div>

      {itens.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">Nenhuma despesa nesta categoria.</p>
      ) : (
        <ul className="space-y-1.5">
          {itens.map((e) => {
            const editing = editingId === e.id;
            const canEdit = !!e.expenseId;
            const saving = mutation.isPending && editing;
            const tipoOptions = getExpenseOptions(e.projectType || 'PESSOAL');
            return (
              <li
                key={e.id}
                className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
              >
                <span className="w-12 shrink-0 text-[11px] font-geist tabular-nums text-gray-500">
                  {dataCurta(e.data)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="truncate text-sm text-gray-900">
                      {e.subcategoria?.trim() || e.categoria || 'Despesa'}
                    </span>
                    {e.parcela && (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-geist tabular-nums text-gray-600">
                        {e.parcela}
                      </span>
                    )}
                    {e.projectType && e.projectType !== 'PESSOAL' && (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                        {e.projectName || e.projectType}
                      </span>
                    )}
                  </div>
                  {editing ? (
                    <div className="mt-1 flex items-center gap-1.5">
                      <select
                        value={novoTipo}
                        onChange={(ev) => setNovoTipo(ev.target.value)}
                        disabled={saving}
                        className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:ring-1 focus:ring-blue-300"
                      >
                        {tipoOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => confirmEdit(e)}
                        disabled={saving}
                        className="rounded-lg bg-blue-600 p-1.5 text-white transition hover:bg-blue-700 disabled:opacity-50"
                        aria-label="Salvar"
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditingId(null); setNovoTipo(''); }}
                        disabled={saving}
                        className="rounded-lg border border-gray-200 p-1.5 text-gray-500 transition hover:bg-gray-100 disabled:opacity-50"
                        aria-label="Cancelar"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-gray-500">
                      {e.cardLast4 ? (
                        <><CreditCard className="w-3 h-3" /> cartão ••{e.cardLast4}</>
                      ) : (
                        <><Landmark className="w-3 h-3" /> conta/débito</>
                      )}
                    </span>
                  )}
                </div>
                {!editing && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <div className="text-right">
                      <p className="font-geist tabular-nums text-sm font-semibold text-gray-900">
                        {fmtMoneyExact(e.valor)}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        {e.status === 'PAGO' || e.status === 'EM_CAIXA' ? 'pago' : 'previsto'}
                      </p>
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => startEdit(e)}
                        className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-200 hover:text-gray-700"
                        aria-label="Editar tipo de despesa"
                        title="Editar tipo de despesa"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
