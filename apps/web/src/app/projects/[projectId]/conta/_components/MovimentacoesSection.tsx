'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, CreditCard, Landmark, Pencil, Trash2, Undo2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { entryMeta, movementMeta } from '../_lib';
import type {
  AccountViewConta,
  AccountViewEntrada,
  AccountViewMovimentacao,
  AccountViewResponse,
  AccountViewSaida,
} from '../_types';

type Tab = 'tudo' | 'saidas' | 'entradas';
type StatusFilter = 'todos' | 'pago' | 'apagar';

function centsToInput(v: number) {
  return (v / 100).toFixed(2);
}

function OriginBadge({ cardLast4, bankLast4 }: { cardLast4: string | null; bankLast4: string | null }) {
  if (cardLast4) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
        <CreditCard className="h-3 w-3" /> ••{cardLast4}
      </span>
    );
  }
  if (bankLast4) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
        <Landmark className="h-3 w-3" /> ••{bankLast4}
      </span>
    );
  }
  return null;
}

export function MovimentacoesSection({
  data,
  projectId,
  onPayInvoice,
}: {
  data: AccountViewResponse;
  projectId: string;
  onPayInvoice: (cardLast4: string) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('saidas');
  const [search, setSearch] = useState('');
  const [cardFilter, setCardFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValor, setEditValor] = useState('');
  const [editData, setEditData] = useState('');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
    queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
  };

  const toggleStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'PAGO' | 'PLANEJADO' }) =>
      api.patch(`/projects/${projectId}/expenses/${id}`, { status }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Erro ao alterar status: ${e.message}`),
  });

  const removeExpense = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/expenses/${id}`),
    onSuccess: () => {
      toast.success('Lançamento excluído');
      invalidate();
    },
    onError: (e: Error) => toast.error(`Erro ao excluir: ${e.message}`),
  });

  const quickUpdate = useMutation({
    mutationFn: ({ id, valorTotal, dataPagamento }: { id: string; valorTotal: number; dataPagamento: string }) =>
      api.patch(`/projects/${projectId}/expenses/${id}`, { valor: valorTotal, dataPagamento }),
    onSuccess: () => {
      toast.success('Lançamento atualizado');
      setEditingId(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(`Erro ao salvar: ${e.message}`),
  });

  const cartaoOptions = data.cartoes.map((c) => ({ last4: c.last4, nome: c.nickname }));
  const contaOptions: AccountViewConta[] = data.contas ?? [];

  const merged = useMemo<AccountViewMovimentacao[]>(() => {
    const list: AccountViewMovimentacao[] = [...data.saidas, ...data.entradas];
    return list.sort((a, b) => b.data.localeCompare(a.data));
  }, [data.saidas, data.entradas]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return merged.filter((m) => {
      if (tab === 'saidas' && m.kind !== 'saida') return false;
      if (tab === 'entradas' && m.kind !== 'entrada') return false;

      if (cardFilter) {
        const last4 = m.kind === 'saida' ? m.cardLast4 ?? m.bankLast4 : m.bankLast4;
        if (last4 !== cardFilter) return false;
      }

      if (statusFilter !== 'todos') {
        const realizado = m.kind === 'saida' ? m.realizado : true;
        if (statusFilter === 'pago' && !realizado) return false;
        if (statusFilter === 'apagar' && realizado) return false;
      }

      if (q && !m.descricao.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [merged, tab, cardFilter, statusFilter, search]);

  const totalSaidas = filtered
    .filter((m): m is AccountViewSaida => m.kind === 'saida')
    .reduce((s, m) => s + m.valor, 0);
  const totalEntradas = filtered
    .filter((m): m is AccountViewEntrada => m.kind === 'entrada')
    .reduce((s, m) => s + m.valor, 0);

  const startEdit = (item: AccountViewSaida) => {
    setEditingId(item.id);
    setEditValor(centsToInput(item.valor));
    setEditData(item.data.slice(0, 10));
  };

  const filterChips: Array<{ key: string; label: string; last4: string }> = [
    ...cartaoOptions.map((c) => ({ key: `card-${c.last4}`, label: `${c.nome} ••${c.last4}`, last4: c.last4 })),
    ...contaOptions.map((c) => ({ key: `bank-${c.last4}`, label: `${c.nome} ••${c.last4}`, last4: c.last4 })),
  ];

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-3 shadow-sm xl:p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Movimentações do mês
          </p>
          <h2 className="mt-0.5 text-lg font-bold text-slate-950">Tudo que mexeu na conta</h2>
        </div>
        <div className="text-right text-[11px] leading-tight">
          <p className="font-semibold text-emerald-700">+ {formatCurrency(totalEntradas / 100)}</p>
          <p className="font-semibold text-slate-700">− {formatCurrency(totalSaidas / 100)}</p>
        </div>
      </div>

      <div className="mb-3 inline-flex w-full rounded-xl bg-slate-100 p-1 sm:w-auto">
        {(['saidas', 'entradas', 'tudo'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`h-9 flex-1 rounded-lg px-4 text-sm font-semibold capitalize transition sm:flex-none ${
              tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t === 'tudo' ? 'Tudo' : t === 'saidas' ? 'Saídas' : 'Entradas'}
          </button>
        ))}
      </div>

      <div className="mb-3 space-y-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por descrição…"
          className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none focus:border-slate-300"
        />
        <div className="flex flex-wrap gap-1.5">
          <FilterPill active={statusFilter === 'todos'} onClick={() => setStatusFilter('todos')}>
            todos
          </FilterPill>
          <FilterPill active={statusFilter === 'pago'} onClick={() => setStatusFilter('pago')}>
            pago
          </FilterPill>
          <FilterPill active={statusFilter === 'apagar'} onClick={() => setStatusFilter('apagar')}>
            a pagar
          </FilterPill>
          <span className="mx-1 self-center text-slate-300">|</span>
          <FilterPill active={cardFilter === null} onClick={() => setCardFilter(null)}>
            todas origens
          </FilterPill>
          {filterChips.map((chip) => (
            <FilterPill
              key={chip.key}
              active={cardFilter === chip.last4}
              onClick={() => setCardFilter((prev) => (prev === chip.last4 ? null : chip.last4))}
            >
              {chip.label}
            </FilterPill>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-500">
          Nenhuma movimentação com esses filtros.
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((item) => {
            const isEntrada = item.kind === 'entrada';
            const meta = isEntrada ? entryMeta(item.tipo) : movementMeta(item.forma);
            const Icon = meta.icon;
            const editing = !isEntrada && editingId != null && item.kind === 'saida' && item.id === editingId;

            return (
              <div
                key={`${item.kind}-${item.id ?? `${item.descricao}-${item.data}-${item.valor}`}`}
                className="rounded-2xl border border-slate-100 px-3 py-2.5"
              >
                <div className="flex min-h-11 items-center gap-3">
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
                      isEntrada ? 'bg-emerald-100 text-emerald-700' : (meta as { iconClass?: string }).iconClass ?? 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {!isEntrada && item.kind === 'saida' && !item.isInvoice
                        ? tipoLabel(item.tipoDespesa) || item.descricao
                        : item.descricao}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                      <span>{formatDateBR(item.data)}</span>
                      {item.kind === 'saida' ? (
                        <OriginBadge cardLast4={item.cardLast4} bankLast4={item.bankLast4} />
                      ) : (
                        <OriginBadge cardLast4={null} bankLast4={item.bankLast4} />
                      )}
                      {!isEntrada && item.kind === 'saida' && (
                        <span
                          className={`rounded-full px-2 py-0.5 font-semibold ${
                            item.realizado ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {item.realizado ? 'pago' : 'a pagar'}
                        </span>
                      )}
                    </div>
                  </div>

                  <p
                    className={`shrink-0 text-right text-sm font-bold ${
                      isEntrada ? 'text-emerald-700' : 'text-slate-950'
                    }`}
                  >
                    {isEntrada ? '+' : '−'} {formatCurrency(item.valor / 100)}
                  </p>
                </div>

                {!isEntrada && item.kind === 'saida' && (
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    {item.isInvoice ? (
                      !item.realizado && item.cardLast4 ? (
                        <button
                          type="button"
                          onClick={() => onPayInvoice(item.cardLast4!)}
                          className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-[11px] font-semibold text-white transition hover:bg-emerald-700"
                        >
                          <Check className="h-3.5 w-3.5" /> Pagar fatura
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400">fatura — gerida pelo cartão</span>
                      )
                    ) : editing ? (
                      <div className="flex w-full items-center gap-1.5">
                        <input
                          type="number"
                          step="0.01"
                          value={editValor}
                          onChange={(e) => setEditValor(e.target.value)}
                          className="h-8 w-24 rounded-lg border border-slate-200 px-2 text-xs"
                        />
                        <input
                          type="date"
                          value={editData}
                          onChange={(e) => setEditData(e.target.value)}
                          className="h-8 flex-1 rounded-lg border border-slate-200 px-2 text-xs"
                        />
                        <button
                          type="button"
                          aria-label="Salvar"
                          onClick={() =>
                            item.id &&
                            quickUpdate.mutate({
                              id: item.id,
                              valorTotal: Math.round(parseFloat(editValor || '0') * 100),
                              dataPagamento: editData,
                            })
                          }
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancelar"
                          onClick={() => setEditingId(null)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      item.editavel && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              item.id &&
                              toggleStatus.mutate({
                                id: item.id,
                                status: item.realizado ? 'PLANEJADO' : 'PAGO',
                              })
                            }
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50"
                          >
                            {item.realizado ? <Undo2 className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                            {item.realizado ? 'desfazer' : 'marcar pago'}
                          </button>
                          <button
                            type="button"
                            aria-label="Editar"
                            onClick={() => startEdit(item)}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Excluir"
                            onClick={() => item.id && removeExpense.mutate(item.id)}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 rounded-full px-3 text-[11px] font-semibold transition ${
        active ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      }`}
    >
      {children}
    </button>
  );
}
