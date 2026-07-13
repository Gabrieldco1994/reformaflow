'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownUp, CreditCard, LayoutList, PieChart, Pencil, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { DespesaModal } from './DespesaModal';
import { QuitarParcelaModal } from './QuitarParcelaModal';
import { ReceitaModal, type ReceitaEditing } from './ReceitaModal';
import type { ResumoQuickFilterKey } from './ResumoCards';
import type {
  AccountViewEntrada,
  AccountViewMovimentacao,
  AccountViewResponse,
  AccountViewSaida,
} from '../_types';

type Tab = 'saidas' | 'entradas' | 'tudo';
type StatusFilter = 'todos' | 'pago' | 'apagar';
type SortDir = 'desc' | 'asc';
type ViewMode = 'lista' | 'categoria';

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Extrai { dia, mes } de uma data ISO/‑string, em UTC, para o badge do avatar. */
function dateParts(value: string): { dia: string; mes: string } {
  const part = (value ?? '').slice(0, 10);
  const [, m, d] = part.split('-');
  const mi = parseInt(m ?? '', 10);
  return {
    dia: (d ?? '').padStart(2, '0') || '--',
    mes: mi >= 1 && mi <= 12 ? MESES_ABREV[mi - 1]! : '',
  };
}

export function MovimentacoesSection({
  data,
  projectId,
  originFilter,
  onClearOrigin,
  onPayInvoice,
  summaryQuickFilter,
  onClearSummaryQuickFilter,
}: {
  data: AccountViewResponse;
  projectId: string;
  originFilter: string | null;
  onClearOrigin: () => void;
  onPayInvoice: (cardLast4: string) => void;
  summaryQuickFilter: ResumoQuickFilterKey | null;
  onClearSummaryQuickFilter: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('saidas');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos');
  const [catFilter, setCatFilter] = useState<string>('todas');
  const [projetoFilter, setProjetoFilter] = useState<string>('todos');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [viewMode, setViewMode] = useState<ViewMode>('lista');
  const [editExpenseId, setEditExpenseId] = useState<string | null>(null);
  const [editReceita, setEditReceita] = useState<ReceitaEditing | null>(null);
  const [quitarTarget, setQuitarTarget] = useState<{
    foreignExpenseId: string;
    parcelaIndex: number;
    valorSugerido: number;
    descricao: string;
    dataSugerida: string;
  } | null>(null);

  useEffect(() => {
    if (!summaryQuickFilter) return;

    setSearch('');
    setCatFilter('todas');
    setProjetoFilter('todos');
    setSortDir('desc');

    if (summaryQuickFilter === 'entrouMes') {
      setTab('entradas');
      setStatusFilter('todos');
      return;
    }
    if (summaryQuickFilter === 'saiuMes') {
      setTab('saidas');
      setStatusFilter('pago');
      return;
    }
    if (summaryQuickFilter === 'faltaPagarMes') {
      setTab('saidas');
      setStatusFilter('apagar');
    }
  }, [summaryQuickFilter]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
    queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
    queryClient.invalidateQueries({ queryKey: ['receipts', projectId] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
    queryClient.invalidateQueries({ queryKey: ['cash-flow', projectId] });
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

  const removeReceita = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/receipts/${id}`),
    onSuccess: () => {
      toast.success('Recebimento excluído');
      invalidate();
    },
    onError: (e: Error) => toast.error(`Erro ao excluir: ${e.message}`),
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
  const projetoAtivo = projetoFilter !== 'todos' && projetoFilter !== projectId;

  const merged = useMemo<AccountViewMovimentacao[]>(() => {
    let saidas: AccountViewSaida[] = data.saidas;
    if (activeIsCard) {
      saidas = [
        ...data.saidas.filter((s) => !(s.isInvoice && s.cardLast4 === originFilter)),
        ...data.comprasCartao.filter((c) => c.cardLast4 === originFilter),
      ];
    } else if (projetoAtivo) {
      // Filtrando por projeto: as compras de cartão desse projeto estão recolhidas
      // dentro da fatura. Expande todas as compras (substituindo as faturas) para
      // que o rótulo de origem e o filtro funcionem.
      saidas = [...data.saidas.filter((s) => !s.isInvoice), ...data.comprasCartao];
    }
    const list: AccountViewMovimentacao[] = [...saidas, ...data.entradas];
    return list.sort((a, b) => b.data.localeCompare(a.data));
  }, [data.saidas, data.entradas, data.comprasCartao, activeIsCard, projetoAtivo, originFilter]);

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
    for (const m of [...data.saidas, ...data.comprasCartao]) {
      if (m.projetoOrigem && m.projetoOrigem.type !== 'PESSOAL') {
        set.set(m.projetoOrigem.id, m.projetoOrigem.name);
      }
    }
    return Array.from(set.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data.saidas, data.comprasCartao]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = merged.filter((m) => {
      if (summaryQuickFilter === 'entrouMes' && m.kind !== 'entrada') return false;
      if (summaryQuickFilter === 'saiuMes' && (m.kind !== 'saida' || !m.realizado)) return false;
      if (summaryQuickFilter === 'faltaPagarMes' && (m.kind !== 'saida' || m.realizado)) return false;

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
  }, [
    merged,
    tab,
    originFilter,
    statusFilter,
    catFilter,
    projetoFilter,
    sortDir,
    search,
    projectId,
    summaryQuickFilter,
  ]);

  const summaryQuickFilterLabel =
    summaryQuickFilter === 'entrouMes'
      ? 'Entrou no mês'
      : summaryQuickFilter === 'saiuMes'
        ? 'Saiu no mês'
        : summaryQuickFilter === 'faltaPagarMes'
          ? 'Ainda falta pagar'
          : null;

  const totalSaidas = filtered
    .filter((m): m is AccountViewSaida => m.kind === 'saida')
    .reduce((s, m) => s + m.valor, 0);
  const totalEntradas = filtered
    .filter((m): m is AccountViewEntrada => m.kind === 'entrada')
    .reduce((s, m) => s + m.valor, 0);

  // Agrupa as saídas visíveis por categoria (tipo de despesa) para a visão resumida.
  const porCategoria = useMemo(() => {
    const map = new Map<string, { label: string; total: number; count: number; tipo: string | null }>();
    for (const m of filtered) {
      if (m.kind !== 'saida') continue;
      const key = m.isInvoice ? '__fatura__' : m.tipoDespesa || '__sem__';
      const label = m.isInvoice ? 'Fatura de cartão' : tipoLabel(m.tipoDespesa) || 'Sem categoria';
      const tipo = m.isInvoice ? null : m.tipoDespesa || null;
      const cur = map.get(key) ?? { label, total: 0, count: 0, tipo };
      cur.total += m.valor;
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [filtered]);
  const categoriaShown = viewMode === 'categoria' && tab !== 'entradas';

  const openEditExpense = (item: AccountViewSaida) => {
    if (item.id) setEditExpenseId(item.id);
  };
  const openEditReceita = (item: AccountViewEntrada) => {
    if (item.id) {
      setEditReceita({ id: item.id, valor: item.valor, data: item.data, tipo: item.tipo, status: item.status });
    }
  };

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'saidas', label: 'Saídas' },
    { key: 'entradas', label: 'Entradas' },
    { key: 'tudo', label: 'Tudo' },
  ];

  return (
    <section className="rounded-3xl border border-lifeone-hairline bg-lifeone-card p-3 shadow-lifeone-card xl:p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
            Movimentações do mês
          </p>
          <h2
            className="mt-0.5 text-lg font-bold text-lifeone-ink font-geist not-italic"
            style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal' }}
          >
            Tudo que mexeu na conta
          </h2>
        </div>
        <div className="text-right text-[11px] leading-tight">
          <p className="font-semibold text-[#1E924A]">+ {formatCurrency(totalEntradas / 100)}</p>
          <p className="font-semibold text-lifeone-ink-2">− {formatCurrency(totalSaidas / 100)}</p>
        </div>
      </div>

      {/* Segmented Saídas | Entradas | Tudo */}
      <div className="mb-3 inline-flex w-full rounded-2xl bg-lifeone-sidebar p-1 sm:w-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              if (summaryQuickFilter) onClearSummaryQuickFilter();
              setTab(t.key);
            }}
            className={`h-9 flex-1 rounded-xl px-4 text-sm font-semibold transition sm:flex-none ${
              tab === t.key
                ? 'bg-lifeone-card text-lifeone-ink shadow-sm'
                : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Indicador de filtro de origem ativo (vem dos cards acima) */}
      {originFilter && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-[#E6EFFE] px-3 py-2 text-[12px] text-lifeone-blue">
          <span className="font-semibold">Filtrando por {originLabel(activeIsCard ? originFilter : null, activeIsCard ? null : originFilter)}</span>
          {activeIsCard && (
            <span className="text-lifeone-blue">· compras da fatura</span>
          )}
          <button
            type="button"
            onClick={onClearOrigin}
            className="ml-auto font-semibold text-lifeone-blue hover:text-[#0857C4]"
          >
            limpar
          </button>
        </div>
      )}

      {summaryQuickFilterLabel && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-[#E3F6EA] px-3 py-2 text-[12px] text-[#1E924A]">
          <span className="font-semibold">Filtro rápido: {summaryQuickFilterLabel}</span>
          <button
            type="button"
            onClick={onClearSummaryQuickFilter}
            className="ml-auto font-semibold text-[#1E924A] hover:text-[#14672F]"
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
          className="h-10 min-w-[180px] flex-1 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
        />
        {tab !== 'entradas' && catOptions.length > 0 && (
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="h-10 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink outline-none focus:border-lifeone-blue"
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
            className="h-10 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink outline-none focus:border-lifeone-blue"
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
          className="flex h-10 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink transition hover:border-lifeone-blue"
          title="Ordenar por data"
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          {sortDir === 'desc' ? 'Mais recentes' : 'Mais antigas'}
        </button>
        {tab !== 'entradas' && (
          <div className="inline-flex h-10 rounded-xl bg-lifeone-sidebar p-1">
            <button
              type="button"
              onClick={() => setViewMode('lista')}
              className={`flex items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition ${
                viewMode === 'lista' ? 'bg-lifeone-card text-lifeone-ink shadow-sm' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
              }`}
              title="Ver lançamentos"
            >
              <LayoutList className="h-3.5 w-3.5" />
              Lista
            </button>
            <button
              type="button"
              onClick={() => setViewMode('categoria')}
              className={`flex items-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition ${
                viewMode === 'categoria' ? 'bg-lifeone-card text-lifeone-ink shadow-sm' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
              }`}
              title="Ver por categoria"
            >
              <PieChart className="h-3.5 w-3.5" />
              Categorias
            </button>
          </div>
        )}
        <div className="flex gap-1.5">
          <FilterPill
            active={statusFilter === 'todos'}
            onClick={() => {
              if (summaryQuickFilter) onClearSummaryQuickFilter();
              setStatusFilter('todos');
            }}
          >
            todos
          </FilterPill>
          <FilterPill
            active={statusFilter === 'pago'}
            onClick={() => {
              if (summaryQuickFilter) onClearSummaryQuickFilter();
              setStatusFilter('pago');
            }}
          >
            pago
          </FilterPill>
          <FilterPill
            active={statusFilter === 'apagar'}
            onClick={() => {
              if (summaryQuickFilter) onClearSummaryQuickFilter();
              setStatusFilter('apagar');
            }}
          >
            a pagar
          </FilterPill>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-lifeone-hairline bg-lifeone-card p-8 text-center text-sm text-lifeone-ink-3">
          Nenhuma movimentação com esses filtros.
        </div>
      ) : categoriaShown ? (
        <div className="divide-y divide-lifeone-hairline overflow-hidden rounded-2xl border border-lifeone-hairline bg-lifeone-card">
          {porCategoria.map((c) => (
            <button
              key={c.label}
              type="button"
              disabled={!c.tipo}
              onClick={() => {
                if (!c.tipo) return;
                setCatFilter(c.tipo);
                setViewMode('lista');
              }}
              className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition ${
                c.tipo ? 'hover:bg-lifeone-sidebar' : 'cursor-default'
              }`}
              title={c.tipo ? 'Ver lançamentos desta categoria' : undefined}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-lifeone-ink">
                {c.label}
                <span className="ml-2 text-[11px] text-lifeone-ink-3">
                  {c.count} lançamento{c.count === 1 ? '' : 's'}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums font-geist text-lifeone-ink">
                {formatCurrency(c.total / 100)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const isEntrada = item.kind === 'entrada';

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
              origem,
            ]
              .filter(Boolean)
              .join(' · ');

            const realizado = item.kind === 'saida' ? item.realizado : true;
            const badge = isEntrada
              ? { txt: 'Recebido', cls: 'bg-[#E3F6EA] text-[#1E924A]' }
              : realizado
                ? { txt: 'Paga', cls: 'bg-[#E3F6EA] text-[#1E924A]' }
                : { txt: 'A pagar', cls: 'bg-[#FBEBDC] text-[#B5803A]' };

            const isInvoiceRow = !isEntrada && item.kind === 'saida' && item.isInvoice;
            const canToggle = !isEntrada && item.kind === 'saida' && item.editavel && !item.isInvoice;
            const canEditInvoicePayment =
              !isEntrada &&
              item.kind === 'saida' &&
              item.isInvoice &&
              item.editavel &&
              !!item.id;
            // Parcela cross-project ainda PENDENTE: não é editável nem toggl-ável;
            // precisa ser QUITADA (gera espelho + concilia) para não sumir da Visão Conta.
            const isPendingForeignParcela =
              item.kind === 'saida' &&
              !item.isInvoice &&
              !item.realizado &&
              item.parcelaIndex != null &&
              !!item.foreignExpenseId;
            // Saída editável (despesa PESSOAL) ou entrada (recebimento) → abre modal completo.
            const canEdit = canToggle || canEditInvoicePayment || (isEntrada && !!item.id);
            const projOrigem =
              item.kind === 'saida' && item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL'
                ? item.projetoOrigem
                : null;

            return (
              <div
                key={`${item.kind}-${item.id ?? `${item.descricao}-${item.data}-${item.valor}`}`}
                className="rounded-2xl border border-lifeone-hairline bg-lifeone-card transition-colors hover:border-lifeone-blue hover:shadow-lifeone-card"
              >
                <div className="group flex items-center gap-3 px-3 py-2.5 md:px-4 md:py-3">
                  <span
                    className={`flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-full leading-none md:h-10 md:w-10 ${
                      isEntrada
                        ? 'bg-[#E3F6EA] text-[#1E924A]'
                        : isInvoiceRow
                          ? 'bg-[#EFE6FA] text-[#7A3FC2]'
                          : 'bg-[#E6EFFE] text-lifeone-blue'
                    }`}
                  >
                    {isInvoiceRow ? (
                      <CreditCard className="h-4 w-4" />
                    ) : (
                      <>
                        <span className="text-sm font-bold tabular-nums font-geist">{dateParts(item.data).dia}</span>
                        <span className="text-[8px] font-semibold uppercase tracking-wide opacity-70">
                          {dateParts(item.data).mes}
                        </span>
                      </>
                    )}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      if (!canEdit) return;
                      if (item.kind === 'saida') openEditExpense(item);
                      else if (item.kind === 'entrada') openEditReceita(item);
                    }}
                    className="min-w-0 flex-1 text-left"
                    title={canEdit ? 'Editar' : undefined}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-lifeone-ink">{titulo}</span>
                      {projOrigem && (
                        <span className="shrink-0 rounded-full bg-[#E6EFFE] px-2 py-0.5 text-[10px] font-semibold text-lifeone-blue">
                          {projOrigem.name}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-lifeone-ink-3">{meta}</div>
                  </button>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={`text-sm font-semibold tabular-nums font-geist ${
                        isEntrada ? 'text-[#1E924A]' : 'text-lifeone-ink'
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
                    ) : isPendingForeignParcela ? (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (item.kind === 'saida' && item.foreignExpenseId && item.parcelaIndex != null) {
                            setQuitarTarget({
                              foreignExpenseId: item.foreignExpenseId,
                              parcelaIndex: item.parcelaIndex,
                              valorSugerido: item.valor,
                              descricao: item.descricao,
                              dataSugerida: item.data.slice(0, 10),
                            });
                          }
                        }}
                        className="rounded-full bg-lifeone-blue px-2.5 py-0.5 text-[10px] font-semibold text-white transition hover:brightness-95"
                        title="Quitar parcela pela conta pessoal"
                      >
                        Quitar
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

                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label="Editar"
                        onClick={() => {
                          if (item.kind === 'saida') openEditExpense(item);
                          else if (item.kind === 'entrada') openEditReceita(item);
                        }}
                        className="rounded-lg p-1.5 text-lifeone-ink-4 transition-colors hover:bg-[#E6EFFE] hover:text-lifeone-blue"
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="Excluir"
                        onClick={() => {
                          if (!item.id) return;
                          if (item.kind === 'saida') {
                            if (confirm('Excluir lançamento?')) removeExpense.mutate(item.id);
                          } else if (item.kind === 'entrada') {
                            if (confirm('Excluir recebimento?')) removeReceita.mutate(item.id);
                          }
                        }}
                        className="rounded-lg p-1.5 text-lifeone-ink-4 transition-colors hover:bg-[#FCEBE9] hover:text-[#D92D20]"
                        title="Excluir"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <DespesaModal
        open={editExpenseId != null}
        onClose={() => setEditExpenseId(null)}
        projectId={projectId}
        editExpenseId={editExpenseId}
      />
      <ReceitaModal
        open={editReceita != null}
        onClose={() => setEditReceita(null)}
        projectId={projectId}
        editing={editReceita}
      />
      {quitarTarget && (
        <QuitarParcelaModal
          projectId={projectId}
          foreignExpenseId={quitarTarget.foreignExpenseId}
          parcelaIndex={quitarTarget.parcelaIndex}
          valorSugerido={quitarTarget.valorSugerido}
          descricao={quitarTarget.descricao}
          dataSugerida={quitarTarget.dataSugerida}
          onClose={() => setQuitarTarget(null)}
          onDone={() => setQuitarTarget(null)}
        />
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
        active ? 'bg-lifeone-ink text-[#FFFFFF]' : 'bg-lifeone-sidebar text-lifeone-ink-3 hover:bg-lifeone-hairline'
      }`}
    >
      {children}
    </button>
  );
}
