'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownCircle, ArrowUpCircle, Check, CreditCard, Landmark, Loader2, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { centsToReaisInput, currencyInputToNumber, maskCurrencyInput } from '@/lib/currency-input';
import type { NeutroItem } from '../_types';

function dateParts(iso: string): { dia: string; mes: string } {
  const d = new Date(iso);
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' })
    .format(d)
    .replace('.', '')
    .toUpperCase();
  return { dia, mes };
}

/**
 * Linha da visão Neutros. Permite editar o VALOR (inline) e EXCLUIR — as duas
 * ações batem nos endpoints reais de despesa/recebimento (PATCH/DELETE), que já
 * regeneram/limpam o cashflow. Ou seja: excluir aqui reflete na despesa/entrada.
 */
export function NeutroRow({
  item,
  projectId,
  onChanged,
}: {
  item: NeutroItem;
  projectId: string;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [valorReais, setValorReais] = useState(centsToReaisInput(item.valorTotal));

  const isEntrada = item.kind === 'entrada';
  const base = isEntrada ? 'receipts' : 'expenses';
  const { dia, mes } = dateParts(item.data);

  const invalidateAll = () => {
    for (const key of [
      ['neutros', projectId],
      ['monthly-overview', projectId],
      ['account-view', projectId],
      ['dre-overview', projectId],
      ['expenses', projectId],
      ['receipts', projectId],
      ['cash-flow', projectId],
      ['dashboard', projectId],
    ]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
    onChanged();
  };

  const updateMutation = useMutation({
    mutationFn: (novoValorReais: number) => {
      // Despesa com quantidade: o backend faz valorTotal = valor * quantidade, então
      // enviamos o valor UNITÁRIO (novoTotal / quantidade). Entrada: quantidade = 1.
      const qtd = item.quantidade > 0 ? item.quantidade : 1;
      const valorUnit = novoValorReais / qtd;
      return api.patch(`/projects/${projectId}/${base}/${item.id}`, { valor: valorUnit });
    },
    onSuccess: () => {
      toast.success('Valor atualizado');
      setEditing(false);
      invalidateAll();
    },
    onError: (e: Error) => toast.error(`Erro ao atualizar: ${e.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}/${base}/${item.id}`),
    onSuccess: () => {
      toast.success(isEntrada ? 'Recebimento excluído' : 'Despesa excluída');
      invalidateAll();
    },
    onError: (e: Error) => toast.error(`Erro ao excluir: ${e.message}`),
  });

  // "Tirar do neutro": reclassifica o tipo para OUTROS (não-neutro), fazendo o
  // lançamento voltar a ser contabilizado em todos os KPIs/DRE/relatórios. O
  // backend regenera o cashflow no update; DRE/relatórios filtram neutros em
  // tempo de leitura. O usuário pode recategorizar depois na visão de despesas/entradas.
  const unmarkMutation = useMutation({
    mutationFn: () => {
      const body = isEntrada ? { tipo: 'OUTROS' } : { tipoDespesa: 'OUTROS' };
      return api.patch(`/projects/${projectId}/${base}/${item.id}`, body);
    },
    onSuccess: () => {
      toast.success('Voltou a ser contabilizado (categoria: Outros)');
      invalidateAll();
    },
    onError: (e: Error) => toast.error(`Erro ao tirar do neutro: ${e.message}`),
  });

  const saving = updateMutation.isPending;
  const deleting = deleteMutation.isPending;
  const unmarking = unmarkMutation.isPending;

  function confirmEdit() {
    const parsed = currencyInputToNumber(valorReais);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Informe um valor maior que zero.');
      return;
    }
    updateMutation.mutate(parsed);
  }

  function handleDelete() {
    if (window.confirm(`Excluir "${item.descricao}" (${formatCurrency(item.valorTotal / 100)})? Isso remove a ${isEntrada ? 'entrada' : 'despesa'} de verdade.`)) {
      deleteMutation.mutate();
    }
  }

  function handleUnmark() {
    if (
      window.confirm(
        `Tirar "${item.descricao}" dos neutros? Ele volta a ser contabilizado em todos os KPIs, DRE e relatórios (categoria "Outros"). Você pode recategorizar depois na visão de ${isEntrada ? 'entradas' : 'despesas'}.`,
      )
    ) {
      unmarkMutation.mutate();
    }
  }

  const realizado = item.status === 'PAGO' || item.status === 'EM_CAIXA';

  return (
    <li className="flex items-center gap-3 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2.5">
      <span
        className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-full leading-none ${
          isEntrada ? 'bg-[#E3F6EA] text-[#1E924A]' : 'bg-[#FDECEC] text-[#D92D20]'
        }`}
      >
        <span className="text-sm font-bold tabular-nums">{dia}</span>
        <span className="text-[8px] font-semibold uppercase tracking-wide opacity-70">{mes}</span>
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {isEntrada ? (
            <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-[#1E924A]" />
          ) : (
            <ArrowDownCircle className="h-3.5 w-3.5 shrink-0 text-[#D92D20]" />
          )}
          <span className="truncate text-sm font-semibold text-lifeone-ink">{item.descricao}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-lifeone-ink-3">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium">{item.tipoLabel}</span>
          {item.cardLast4 ? (
            <span className="inline-flex items-center gap-1"><CreditCard className="h-3 w-3" /> ••{item.cardLast4}</span>
          ) : item.bankLast4 ? (
            <span className="inline-flex items-center gap-1"><Landmark className="h-3 w-3" /> conta ••{item.bankLast4}</span>
          ) : null}
          <span className={realizado ? 'text-[#1E924A]' : 'text-amber-600'}>
            {realizado ? 'realizado' : 'previsto'}
          </span>
          {!item.afetaCaixa && <span className="text-slate-400">· fora do caixa</span>}
        </div>
      </div>

      {editing ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-lifeone-hairline bg-white px-2">
            <span className="text-[11px] text-lifeone-ink-3">R$</span>
            <input
              type="text"
              inputMode="numeric"
              value={valorReais}
              autoFocus
              disabled={saving}
              onChange={(e) => setValorReais(maskCurrencyInput(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmEdit();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-24 bg-transparent py-1.5 text-right text-sm text-lifeone-ink outline-none"
            />
          </div>
          <button
            type="button"
            onClick={confirmEdit}
            disabled={saving}
            className="rounded-lg bg-lifeone-blue p-1.5 text-white transition hover:opacity-90 disabled:opacity-50"
            aria-label="Salvar"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => { setEditing(false); setValorReais(centsToReaisInput(item.valorTotal)); }}
            disabled={saving}
            className="rounded-lg border border-lifeone-hairline p-1.5 text-lifeone-ink-3 transition hover:bg-slate-50 disabled:opacity-50"
            aria-label="Cancelar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <div className="text-right">
            <p className={`text-sm font-bold tabular-nums ${isEntrada ? 'text-[#1E924A]' : 'text-lifeone-ink'}`}>
              {isEntrada ? '+' : '−'} {formatCurrency(item.valorTotal / 100)}
            </p>
            {item.quantidade > 1 && (
              <p className="text-[10px] text-lifeone-ink-4">{item.quantidade}× {formatCurrency(item.valorUnitario / 100)}</p>
            )}
          </div>
          <button
            type="button"
            onClick={handleUnmark}
            disabled={unmarking}
            className="rounded-lg p-1.5 text-lifeone-ink-4 transition hover:bg-[#E3F6EA] hover:text-[#1E924A] disabled:opacity-50"
            title="Tirar do neutro (voltar a contabilizar)"
            aria-label="Tirar do neutro"
          >
            {unmarking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg p-1.5 text-lifeone-ink-4 transition hover:bg-[#E6EFFE] hover:text-lifeone-blue"
            title="Editar valor"
            aria-label="Editar valor"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="rounded-lg p-1.5 text-lifeone-ink-4 transition hover:bg-[#FDECEC] hover:text-[#D92D20] disabled:opacity-50"
            title="Excluir"
            aria-label="Excluir"
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </button>
        </div>
      )}
    </li>
  );
}
