'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownUp, Check, CreditCard, Pencil, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import type {
  AccountViewEntrada,
  AccountViewMovimentacao,
  AccountViewResponse,
  AccountViewSaida,
} from '../_types';

type Tab = 'saidas' | 'entradas' | 'tudo';
type StatusFilter = 'todos' | 'pago' | 'apagar';
type SortDir = 'desc' | 'asc';

function centsToInput(v: number) {
  return (v / 100).toFixed(2);
}

function initialOf(text: string) {
  return (text.trim()[0] || '?').toUpperCase();
}

export function MovimentacoesSection({
  data,
  projectId,
  originFilter,
  onClearOrigin,
  onPayInvoice,
}: {
  data: AccountViewResponse;
  projectId: string;
  originFilter: string | null;
  onClearOrigin: () => void;
  onPayInvoice: (cardLast4: string) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('saidas');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos');
  const [catFilter, setCatFilter] = useState<string>('todas');
  const [projetoFilter, setProjetoFilter] = useState<string>('todos');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
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

  const cardByLast4 = useMemo(
    () => new Map(data.cartoes.map((c) => [c.last4, c] as const)),
    [data.cartoes],
  );
  const contaByLast4 = useMemo(
    () => new Map((data.contas ?? []).map((c) => [c.last4, c] as const)),
    [data.contas],
  );

  const originLabel = (cardLast4: string | null, bankLast4: string | null) => {
    if (cardLast4) return cardByLast4.get(cardLast4)?.nickname ?? `Cartão ••${cardLast4}`;
    if (bankLast4) return contaByLast4.get(bankLast4)?.nome ?? `Conta ••${bankLast4}`;
    return null;
  };

  const activeIsCard = originFilter != null && cardByLast4.has(originFilter);

  const merged = useMemo<AccountViewMovimentacao[]>(() => {
    let saidas: AccountViewSaida[] = data.saidas;
    if (activeIsCard) {
      saidas = [
        ...data.saidas.filter((s) => !(s.isInvoice && s.cardLast4 === originFilter)),
        ...data.comprasCartao.filter((c) => c.cardLast4 === originFilter),
      ];
    }
    const list: AccountViewMovimentacao[] = [...saidas, ...data.entradas];
    return list.sort((a, b) => b.data.localeCompare(a.data));
  }, [data.saidas, data.entradas, data.comprasCartao, activeIsCard, originFilter]);

  const catOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const m of merged) {
      if (m.kind === 'saida' && !m.isInvoice && m.tipoDespesa) {
        set.set(m.tipoDespesa, tipoLabel(m.tipoDespesa));
      }
    }
    return Array.from(set.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [merged]);

  const projetoOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const m of merged) {
      if (m.kind === 'saida' && m.projetoOrigem && m.projetoOrigem.type !== 'PESSOAL') {
        set.set(m.projetoOrigem.id, m.projetoOrigem.name);
      }
    }
    return Array.from(set.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [merged]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = merged.filter((m) => {
      if (tab === 'saidas' && m.kind !== 'saida') return false;
      if (tab === 'entradas' && m.kind !== 'entrada') return false;

      if (originFilter) {
        const last4 = m.kind === 'saida' ? m.cardLast4 ?? m.bankLast4 : m.bankLast4;
        if (last4 !== originFilter) return false;
      }

      if (statusFilter !== 'todos') {
        const realizado = m.kind === 'saida' ? m.realizado : true;
        if (statusFilter === 'pago' && !realizado) return false;
        if (statusFilter === 'apagar' && realizado) return false;
      }

      if (catFilter !== 'todas') {
        if (m.kind !== 'saida' || m.isInvoice || m.tipoDespesa !== catFilter) return false;
      }

      if (projetoFilter !== 'todos') {
        const proj = m.kind === 'saida' ? m.projetoOrigem : null;
        const projId = proj && proj.type !== 'PESSOAL' ? proj.id : projectId;
        if (projId !== projetoFilter) return false;
      }

      if (q && !m.descricao.toLowerCase().includes(q)) return false;
      return true;
    });
    return result.sort((a, b) =>
      sortDir === 'desc' ? b.data.localeCompare(a.data) : a.data.localeCompare(b.data),
    );
  }, [merged, tab, originFilter, statusFilter, catFilter, projetoFilter, sortDir, search, projectId]);

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

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'saidas', label: 'Saídas' },
    { key: 'entradas', label: 'Entradas' },
    { key: 'tudo', label: 'Tudo' },
  ];

  return (
    <section className="rounded-3xl border border-darc-linen bg-white p-3 shadow-darc-soft xl:p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-darc-velvet/50">
            Movimentações do mês
          </p>
          <h2 className="mt-0.5 text-lg font-bold text-darc-velvet">Tudo que mexeu na conta</h2>
        </div>
        <div className="text-right text-[11px] leading-tight">
          <p className="font-semibold text-emerald-600">+ {formatCurrency(totalEntradas / 100)}</p>
          <p className="font-semibold text-darc-velvet/70">− {formatCurrency(totalSaidas / 100)}</p>
        </div>
      </div>

      {/* Segmented Saídas | Entradas | Tudo */}
      <div className="mb-3 inline-flex w-full rounded-2xl bg-darc-cream p-1 sm:w-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`h-9 flex-1 rounded-xl px-4 text-sm font-semibold transition sm:flex-none ${
              tab === t.key
                ? 'bg-white text-darc-velvet shadow-sm'
                : 'text-darc-velvet/50 hover:text-darc-velvet/80'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Indicador de filtro de origem ativo (vem dos cards acima) */}
      {originFilter && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-orange-50 px-3 py-2 text-[12px] text-orange-800">
          <span className="font-semibold">Filtrando por {originLabel(activeIsCard ? originFilter : null, activeIsCard ? null : originFilter)}</span>
          {activeIsCard && (
            <span className="text-orange-600">· compras da fatura</span>
          )}
          <button
            type="button"
            onClick={onClearOrigin}
            className="ml-auto font-semibold text-orange-700 hover:text-orange-900"
          >
            limpar
          </button>
        </div>
      )}

      {/* Busca + status */}
      <div className="mb-3 mt-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por descrição…"
          className="h-10 min-w-[180px] flex-1 rounded-xl border border-darc-linen bg-darc-off-white px-3 text-sm text-darc-velvet outline-none focus:border-orange-300"
        />
        {tab !== 'entradas' && catOptions.length > 0 && (
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="h-10 rounded-xl border border-darc-linen bg-darc-off-white px-3 text-sm font-medium text-darc-velvet outline-none focus:border-orange-300"
          >
            <option value="todas">Todas as categorias</option>
            {catOptions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        {projetoOptions.length > 0 && (
          <select
            value={projetoFilter}
            onChange={(e) => setProjetoFilter(e.target.value)}
            className="h-10 rounded-xl border border-darc-linen bg-darc-off-white px-3 text-sm font-medium text-darc-velvet outline-none focus:border-orange-300"
          >
            <option value="todos">Todos os projetos</option>
            <option value={projectId}>Pessoal</option>
            {projetoOptions.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          className="flex h-10 items-center gap-1.5 rounded-xl border border-darc-linen bg-darc-off-white px-3 text-sm font-medium text-darc-velvet transition hover:border-orange-300"
          title="Ordenar por data"
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          {sortDir === 'desc' ? 'Mais recentes' : 'Mais antigas'}
        </button>
        <div className="flex gap-1.5">
          <FilterPill active={statusFilter === 'todos'} onClick={() => setStatusFilter('todos')}>
            todos
          </FilterPill>
          <FilterPill active={statusFilter === 'pago'} onClick={() => setStatusFilter('pago')}>
            pago
          </FilterPill>
          <FilterPill active={statusFilter === 'apagar'} onClick={() => setStatusFilter('apagar')}>
            a pagar
          </FilterPill>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-darc-linen bg-darc-off-white p-8 text-center text-sm text-darc-velvet/50">
          Nenhuma movimentação com esses filtros.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const isEntrada = item.kind === 'entrada';
            const editing =
              !isEntrada && editingId != null && item.kind === 'saida' && item.id === editingId;

            const titulo =
              !isEntrada && item.kind === 'saida' && !item.isInvoice
                ? item.descricao || tipoLabel(item.tipoDespesa)
                : item.descricao;

            const origem =
              item.kind === 'saida'
                ? originLabel(item.cardLast4, item.bankLast4)
                : originLabel(null, item.bankLast4);

            const meta = [
              item.kind === 'saida' && !item.isInvoice ? tipoLabel(item.tipoDespesa) : null,
              formatDateBR(item.data).slice(0, 5),
              origem,
            ]
              .filter(Boolean)
              .join(' · ');

            const realizado = item.kind === 'saida' ? item.realizado : true;
            const badge = isEntrada
              ? { txt: 'Recebido', cls: 'bg-emerald-100 text-emerald-700' }
              : realizado
                ? { txt: 'Paga', cls: 'bg-emerald-100 text-emerald-700' }
                : { txt: 'A pagar', cls: 'bg-amber-100 text-amber-700' };

            const isInvoiceRow = !isEntrada && item.kind === 'saida' && item.isInvoice;
            const canToggle = !isEntrada && item.kind === 'saida' && item.editavel && !item.isInvoice;
            const canEdit = canToggle;
            const projOrigem =
              item.kind === 'saida' && item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL'
                ? item.projetoOrigem
                : null;

            return (
              <div
                key={`${item.kind}-${item.id ?? `${item.descricao}-${item.data}-${item.valor}`}`}
                className="rounded-2xl border border-darc-linen bg-white transition-colors hover:border-orange-200 hover:shadow-darc-soft"
              >
                <div className="group flex items-center gap-3 px-3 py-2.5 md:px-4 md:py-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold md:h-10 md:w-10 ${
                      isEntrada
                        ? 'bg-emerald-100 text-emerald-700'
                        : isInvoiceRow
                          ? 'bg-violet-100 text-violet-700'
                          : 'bg-orange-100 text-orange-700'
                    }`}
                  >
                    {isInvoiceRow ? <CreditCard className="h-4 w-4" /> : initialOf(titulo)}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      if (canEdit && item.kind === 'saida') startEdit(item);
                    }}
                    className="min-w-0 flex-1 text-left"
                    title={canEdit ? 'Editar' : undefined}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-darc-velvet">{titulo}</span>
                      {projOrigem && (
                        <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
                          {projOrigem.name}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-darc-velvet/50">{meta}</div>
                  </button>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={`text-sm font-semibold tabular-nums ${
                        isEntrada ? 'text-emerald-600' : 'text-darc-velvet'
                      }`}
                    >
                      {isEntrada ? '+' : '−'} {formatCurrency(item.valor / 100)}
                    </span>
                    {isInvoiceRow ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (item.kind === 'saida' && !item.realizado && item.cardLast4)
                            onPayInvoice(item.cardLast4);
                        }}
                        disabled={realizado || !(item.kind === 'saida' && item.cardLast4)}
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls} ${
                          !realizado ? 'cursor-pointer hover:brightness-95' : ''
                        }`}
                        title={!realizado ? 'Pagar fatura' : undefined}
                      >
                        {badge.txt}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (canToggle && item.kind === 'saida' && item.id)
                            toggleStatus.mutate({
                              id: item.id,
                              status: realizado ? 'PLANEJADO' : 'PAGO',
                            });
                        }}
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}
                        title={canToggle ? 'Alternar status' : undefined}
                      >
                        {badge.txt}
                      </button>
                    )}
                  </div>

                  {canEdit && item.kind === 'saida' && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label="Editar"
                        onClick={() => startEdit(item)}
                        className="rounded-lg p-1.5 text-darc-velvet/30 transition-colors hover:bg-orange-50 hover:text-orange-500"
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Excluir"
                        onClick={() => {
                          if (item.id && confirm('Excluir lançamento?')) removeExpense.mutate(item.id);
                        }}
                        className="rounded-lg p-1.5 text-darc-velvet/30 transition-colors hover:bg-red-50 hover:text-red-500"
                        title="Excluir"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>

                {editing && item.kind === 'saida' && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-darc-linen bg-darc-off-white px-3 py-2.5">
                    <label className="text-[10px] font-semibold text-darc-velvet/50">valor</label>
                    <input
                      type="number"
                      step="0.01"
                      value={editValor}
                      onChange={(e) => setEditValor(e.target.value)}
                      className="h-9 w-28 rounded-lg border border-darc-linen bg-white px-2 text-sm"
                    />
                    <label className="ml-1 text-[10px] font-semibold text-darc-velvet/50">data</label>
                    <input
                      type="date"
                      value={editData}
                      onChange={(e) => setEditData(e.target.value)}
                      className="h-9 flex-1 rounded-lg border border-darc-linen bg-white px-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        item.id &&
                        quickUpdate.mutate({
                          id: item.id,
                          valorTotal: Math.round(parseFloat(editValor || '0') * 100),
                          dataPagamento: editData,
                        })
                      }
                      className="flex h-9 items-center gap-1 rounded-lg bg-orange-500 px-3 text-xs font-semibold text-white hover:bg-orange-600"
                    >
                      <Check className="h-4 w-4" /> salvar
                    </button>
                    <button
                      type="button"
                      aria-label="Cancelar"
                      onClick={() => setEditingId(null)}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-darc-linen text-darc-velvet/50"
                    >
                      <X className="h-4 w-4" />
                    </button>
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
      className={`h-9 rounded-full px-3 text-[12px] font-semibold transition ${
        active ? 'bg-darc-velvet text-white' : 'bg-darc-cream text-darc-velvet/60 hover:bg-darc-linen'
      }`}
    >
      {children}
    </button>
  );
}
