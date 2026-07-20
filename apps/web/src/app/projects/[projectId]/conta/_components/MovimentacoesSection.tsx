'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDownUp, CreditCard, Filter, Layers, LayoutList, PieChart, X } from 'lucide-react';
import { isConsumptionNeutralExpenseType, isNeutralReceiptType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { getExpenseIcon } from '@/lib/expense-icons';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import type { Expense } from '@/types';
import { DespesaModal } from './DespesaModal';
import { MovimentacaoRow, type QuitarTarget } from './MovimentacaoRow';
import { QuitarParcelaModal } from './QuitarParcelaModal';
import { ReceitaModal, type ReceitaEditing } from './ReceitaModal';
import { PorProjetoCategoriaView } from './PorProjetoCategoriaView';
import { RatearCompraModal } from '../../expenses/_components/RatearCompraModal';
import { BulkLinkModal } from '../../expenses/_components/BulkLinkModal';
import { invalidateExpenseQueries } from '../../expenses/_hooks/useExpenseMutations';
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
type ViewMode = 'lista' | 'categoria' | 'projeto';

// Movimento "neutro" = transferência interna / resgate / aporte (investimento,
// pagamento da casa). Some da LISTA de movimentações da Conta para não poluir a
// leitura de entradas/saídas reais — mas continua no caixa real dos KPIs (cards
// Entrou/Caixa hoje vêm dos agregados do backend; invariante "neutro é caixa").
// As faturas de cartão (PAGAMENTO_FATURA_CARTAO / isInvoice) NÃO são escondidas:
// é na Conta que se paga a fatura.
function isNeutralMovimentacao(m: AccountViewMovimentacao): boolean {
  if (m.kind === 'entrada') return isNeutralReceiptType(m.tipo);
  if (m.isInvoice) return false;
  return m.tipoDespesa !== 'PAGAMENTO_FATURA_CARTAO' && isConsumptionNeutralExpenseType(m.tipoDespesa);
}

// Saída sem cartão nem conta bancária → pseudo-origem Carteira (D5 do plano).
function isCarteiraItem(m: AccountViewMovimentacao): boolean {
  return m.kind === 'saida' && !m.isInvoice && !m.cardLast4 && !m.bankLast4;
}

export function MovimentacoesSection({
  data,
  projectId,
  originFilter,
  onClearOrigin,
  onPayInvoice,
  onAdjustInvoice,
  onSettleWithResidual,
  summaryQuickFilter,
  onClearSummaryQuickFilter,
}: {
  data: AccountViewResponse;
  projectId: string;
  originFilter: string | null;
  onClearOrigin: () => void;
  onPayInvoice: (cardLast4: string) => void;
  onAdjustInvoice: (cardLast4: string) => void;
  onSettleWithResidual: (cardLast4: string) => void;
  summaryQuickFilter: ResumoQuickFilterKey | null;
  onClearSummaryQuickFilter: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('tudo');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('todos');
  const [catFilter, setCatFilter] = useState<string>('todas');
  const [projetoFilter, setProjetoFilter] = useState<string>('todos');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [viewMode, setViewMode] = useState<ViewMode>('lista');
  const [semContaFilter, setSemContaFilter] = useState(false);
  // Faturas expandidas inline (por cardLast4): revela as compras do cartão na Lista.
  const [expandedCards, setExpandedCards] = useState<Set<string>>(() => new Set());
  const toggleCard = (last4: string) =>
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(last4)) next.delete(last4);
      else next.add(last4);
      return next;
    });
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [editExpenseId, setEditExpenseId] = useState<string | null>(null);
  const [editReceita, setEditReceita] = useState<ReceitaEditing | null>(null);
  const [quitarTarget, setQuitarTarget] = useState<QuitarTarget | null>(null);
  // Ratear/Vincular por linha: guarda o id da compra e a ação; a despesa completa
  // é buscada sob demanda (os modais precisam do objeto Expense, ex. valorTotal).
  const [actionExpenseId, setActionExpenseId] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<'ratear' | 'vincular' | null>(null);

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

  // Espelho do toggle de saída: recebimento previsto ↔ em caixa.
  const toggleReceiptStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'EM_CAIXA' | 'PREVISTO' }) =>
      api.patch(`/projects/${projectId}/receipts/${id}`, { status }),
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

  // Despesa completa da compra escolhida para ratear/vincular (RatearCompraModal
  // precisa do valorTotal; BulkLinkModal recebe o Expense como fonte pré-selecionada).
  const { data: actionExpense = null } = useQuery<Expense | null>({
    queryKey: ['expense', projectId, actionExpenseId],
    queryFn: () => api.get(`/projects/${projectId}/expenses/${actionExpenseId}`),
    enabled: actionExpenseId != null,
  });

  // Rateio: distribui UMA compra (fonte, PESSOAL) entre N planejadas de outro
  // projeto. Não toca no motor backend — só reusa os endpoints (mesma wiring do
  // DespesaModal). A soma das alocações fecha o total da compra (invariante).
  const ratearMutation = useMutation({
    mutationFn: ({ sourceId, allocations }: { sourceId: string; allocations: { targetExpenseId: string; allocation: number }[] }) =>
      api.post(`/projects/${projectId}/expenses/${sourceId}/ratear`, { allocations }),
    onSuccess: (_d, vars) => {
      invalidateExpenseQueries(queryClient, projectId);
      invalidate();
      toast.success(`Compra rateada em ${vars.allocations.length} ${vars.allocations.length === 1 ? 'planejada' : 'planejadas'}`);
    },
    onError: (e: Error) => toast.error(`Erro ao ratear compra: ${e.message}`),
  });

  const desratearMutation = useMutation({
    mutationFn: ({ sourceId }: { sourceId: string }) =>
      api.delete(`/projects/${projectId}/expenses/${sourceId}/ratear`),
    onSuccess: () => {
      invalidateExpenseQueries(queryClient, projectId);
      invalidate();
      toast.success('Rateio desfeito');
    },
    onError: (e: Error) => toast.error(`Erro ao desfazer rateio: ${e.message}`),
  });

  const closeAction = () => {
    setActionExpenseId(null);
    setActionKind(null);
  };

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
  const catAtiva = catFilter !== 'todas';

  const merged = useMemo<AccountViewMovimentacao[]>(() => {
    let saidas: AccountViewSaida[] = data.saidas;
    if (activeIsCard) {
      saidas = [
        ...data.saidas.filter((s) => !(s.isInvoice && s.cardLast4 === originFilter)),
        ...data.comprasCartao.filter((c) => c.cardLast4 === originFilter),
      ];
    } else if (projetoAtivo || catAtiva) {
      // Filtrando por projeto OU categoria: as compras de cartão estão recolhidas
      // dentro da fatura (que não tem projeto/categoria). Expande todas as compras
      // (substituindo as faturas) para que o filtro e o rótulo de origem funcionem.
      saidas = [...data.saidas.filter((s) => !s.isInvoice), ...data.comprasCartao];
    }
    const list: AccountViewMovimentacao[] = [...saidas, ...data.entradas].filter(
      (m) => !isNeutralMovimentacao(m),
    );
    return list.sort((a, b) => b.data.localeCompare(a.data));
  }, [data.saidas, data.entradas, data.comprasCartao, activeIsCard, projetoAtivo, catAtiva, originFilter]);

  // Compras de cartão agrupadas por cartão — usadas para expandir a fatura inline.
  const comprasByCard = useMemo(() => {
    const m = new Map<string, AccountViewSaida[]>();
    for (const c of data.comprasCartao) {
      if (!c.cardLast4) continue;
      const arr = m.get(c.cardLast4) ?? [];
      arr.push(c);
      m.set(c.cardLast4, arr);
    }
    return m;
  }, [data.comprasCartao]);

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

  // Predicado de filtros de conteúdo (tudo menos a aba). Reusado pela Lista e pela
  // visão Por projeto/categoria para não divergir a lógica.
  const passesContentFilters = useCallback(
    (m: AccountViewMovimentacao): boolean => {
      if (summaryQuickFilter === 'entrouMes' && (m.kind !== 'entrada' || m.status !== 'EM_CAIXA'))
        return false;
      if (summaryQuickFilter === 'saiuMes' && (m.kind !== 'saida' || !m.realizado)) return false;
      if (summaryQuickFilter === 'faltaPagarMes' && (m.kind !== 'saida' || m.realizado)) return false;

      if (semContaFilter) {
        if (!isCarteiraItem(m)) return false;
      }

      if (originFilter) {
        const last4 = m.kind === 'saida' ? m.cardLast4 ?? m.bankLast4 : m.bankLast4;
        if (last4 !== originFilter) return false;
      }

      if (statusFilter !== 'todos') {
        const realizado = m.kind === 'saida' ? m.realizado : m.status === 'EM_CAIXA';
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

      const q = search.trim().toLowerCase();
      if (q && !m.descricao.toLowerCase().includes(q)) return false;
      return true;
    },
    [summaryQuickFilter, semContaFilter, originFilter, statusFilter, catFilter, projetoFilter, search, projectId],
  );

  const filtered = useMemo(() => {
    const result = merged.filter((m) => {
      if (tab === 'saidas' && m.kind !== 'saida') return false;
      if (tab === 'entradas' && m.kind !== 'entrada') return false;
      return passesContentFilters(m);
    });
    // merged já está desc por data (mesmo comparador) e filter preserva a ordem;
    // só re-ordena quando o usuário pede asc.
    if (sortDir === 'desc') return result;
    return result.sort((a, b) => a.data.localeCompare(b.data));
  }, [merged, tab, sortDir, passesContentFilters]);

  const summaryQuickFilterLabel =
    summaryQuickFilter === 'entrouMes'
      ? 'Entrou no mês'
      : summaryQuickFilter === 'saiuMes'
        ? 'Saiu no mês'
        : summaryQuickFilter === 'faltaPagarMes'
          ? 'Ainda falta pagar'
          : null;

  const { totalSaidas, totalEntradasRecebido, totalEntradasPrevisto } = useMemo(() => {
    let saidas = 0;
    let recebido = 0;
    let previsto = 0;
    for (const m of filtered) {
      if (m.kind === 'saida') saidas += m.valor;
      else if (m.status === 'EM_CAIXA') recebido += m.valor;
      else if (m.status === 'PREVISTO') previsto += m.valor;
    }
    return { totalSaidas: saidas, totalEntradasRecebido: recebido, totalEntradasPrevisto: previsto };
  }, [filtered]);

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
  const projetoShown = viewMode === 'projeto' && tab !== 'entradas';

  // Base da visão Por projeto/categoria: saídas com as compras de cartão SEMPRE
  // expandidas (a fatura agregada não tem projeto/categoria). Aplica os mesmos
  // filtros de conteúdo da Lista, exceto a aba (esta visão é só de saídas).
  const porProjetoFiltered = useMemo(() => {
    if (!projetoShown) return [];
    const base = [...data.saidas.filter((s) => !s.isInvoice), ...data.comprasCartao].filter(
      (s) => !isNeutralMovimentacao(s),
    );
    return base.filter((s) => passesContentFilters(s));
  }, [projetoShown, data.saidas, data.comprasCartao, passesContentFilters]);

  // Drill da visão Por projeto/categoria → abre a Lista já filtrada.
  const drillProjetoCategoria = (projKey: string, tipo: string | null) => {
    setProjetoFilter(projKey);
    if (tipo) setCatFilter(tipo);
    setViewMode('lista');
  };

  const openEditExpense = (item: AccountViewSaida) => {
    if (item.id) setEditExpenseId(item.id);
  };
  const openEditReceita = (item: AccountViewEntrada) => {
    if (item.id) {
      setEditReceita({ id: item.id, valor: item.valor, data: item.data, tipo: item.tipo, status: item.status, descricao: item.descricaoRaw ?? '' });
    }
  };
  const openRatear = (item: AccountViewSaida) => {
    if (item.id) {
      setActionExpenseId(item.id);
      setActionKind('ratear');
    }
  };
  const openVincular = (item: AccountViewSaida) => {
    if (item.id) {
      setActionExpenseId(item.id);
      setActionKind('vincular');
    }
  };

  const rowKey = (m: AccountViewMovimentacao) =>
    `${m.kind}-${m.id ?? `${m.descricao}-${m.data}-${m.valor}`}`;

  const renderRow = (
    item: AccountViewMovimentacao,
    expand?: { expandable: boolean; expanded: boolean; onToggleExpand: () => void },
  ) => (
    <MovimentacaoRow
      key={rowKey(item)}
      item={item}
      originLabel={originLabel}
      onEditExpense={openEditExpense}
      onEditReceita={openEditReceita}
      onToggleExpense={(id, realizado) =>
        toggleStatus.mutate({ id, status: realizado ? 'PLANEJADO' : 'PAGO' })
      }
      onToggleReceita={(id, nextStatus) => toggleReceiptStatus.mutate({ id, status: nextStatus })}
      onPayInvoice={onPayInvoice}
      onAdjustInvoice={onAdjustInvoice}
      onSettleWithResidual={onSettleWithResidual}
      onQuitar={setQuitarTarget}
      onRemoveExpense={(id) => removeExpense.mutate(id)}
      onRemoveReceita={(id) => removeReceita.mutate(id)}
      onRatear={openRatear}
      onVincular={openVincular}
      expandable={expand?.expandable}
      expanded={expand?.expanded}
      onToggleExpand={expand?.onToggleExpand}
    />
  );

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'saidas', label: 'Saídas' },
    { key: 'entradas', label: 'Entradas' },
    { key: 'tudo', label: 'Tudo' },
  ];

  // Nº de filtros de conteúdo ativos (categoria + projeto + sem conta) — badge do botão "Filtros".
  const activeFilterCount =
    (catFilter !== 'todas' ? 1 : 0) + (projetoFilter !== 'todos' ? 1 : 0) + (semContaFilter ? 1 : 0);

  // Qualquer filtro de conteúdo ativo (inclui busca, status, origem e filtro rápido) —
  // controla a visibilidade do botão "Limpar filtros".
  const anyFilterActive =
    search.trim() !== '' ||
    catFilter !== 'todas' ||
    projetoFilter !== 'todos' ||
    statusFilter !== 'todos' ||
    semContaFilter ||
    originFilter != null ||
    summaryQuickFilter != null;

  const clearAllFilters = () => {
    setSearch('');
    setCatFilter('todas');
    setProjetoFilter('todos');
    setStatusFilter('todos');
    setSemContaFilter(false);
    if (originFilter) onClearOrigin();
    if (summaryQuickFilter) onClearSummaryQuickFilter();
  };

  // Controles de categoria/projeto/ordenação/visão. Inline na toolbar (desktop) e
  // empilhados no sheet (mobile) — mesma lógica/estado, só muda a largura.
  const renderFilterControls = (stacked: boolean) => (
    <>
      {tab !== 'entradas' && catOptions.length > 0 && (
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className={`h-11 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink outline-none focus:border-lifeone-blue md:h-10 ${stacked ? 'w-full' : ''}`}
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
          className={`h-11 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink outline-none focus:border-lifeone-blue md:h-10 ${stacked ? 'w-full' : ''}`}
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
      {tab !== 'entradas' && (
        <button
          type="button"
          onClick={() => setSemContaFilter((v) => !v)}
          className={`flex h-11 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition md:h-10 ${
            semContaFilter
              ? 'border-lifeone-blue bg-[#E6EFFE] text-lifeone-blue'
              : 'border-lifeone-hairline bg-lifeone-card text-lifeone-ink hover:border-lifeone-blue'
          } ${stacked ? 'w-full justify-center' : ''}`}
          title="Mostrar apenas lançamentos sem conta vinculada"
        >
          Sem conta
        </button>
      )}
      <button
        type="button"
        onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
        className={`flex h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink transition hover:border-lifeone-blue md:h-10 ${stacked ? 'w-full justify-center' : ''}`}
        title="Ordenar por data"
      >
        <ArrowDownUp className="h-3.5 w-3.5" />
        {sortDir === 'desc' ? 'Mais recentes' : 'Mais antigas'}
      </button>
      {tab !== 'entradas' && (
        <div className={`inline-flex h-11 rounded-xl bg-lifeone-sidebar p-1 md:h-10 ${stacked ? 'w-full' : ''}`}>
          <button
            type="button"
            onClick={() => setViewMode('lista')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition ${
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
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition ${
              viewMode === 'categoria' ? 'bg-lifeone-card text-lifeone-ink shadow-sm' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
            }`}
            title="Ver por categoria"
          >
            <PieChart className="h-3.5 w-3.5" />
            Categorias
          </button>
          {/* "Por projeto" só no desktop (drill-down largo); no sheet mobile fica fora. */}
          {!stacked && (
            <button
              type="button"
              onClick={() => setViewMode('projeto')}
              className={`hidden flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition md:flex ${
                viewMode === 'projeto' ? 'bg-lifeone-card text-lifeone-ink shadow-sm' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
              }`}
              title="Ver por projeto e categoria"
            >
              <Layers className="h-3.5 w-3.5" />
              Projetos
            </button>
          )}
        </div>
      )}
      {anyFilterActive && (
        <button
          type="button"
          onClick={clearAllFilters}
          className={`flex h-11 items-center justify-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink-2 transition hover:border-red-300 hover:text-red-600 md:h-10 ${stacked ? 'w-full' : ''}`}
          title="Limpar todos os filtros"
        >
          <X className="h-3.5 w-3.5" />
          Limpar filtros
        </button>
      )}
    </>
  );

  const statusPills = (
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
        {tab === 'entradas' ? 'recebido' : 'pago'}
      </FilterPill>
      <FilterPill
        active={statusFilter === 'apagar'}
        onClick={() => {
          if (summaryQuickFilter) onClearSummaryQuickFilter();
          setStatusFilter('apagar');
        }}
      >
        {tab === 'entradas' ? 'previsto' : 'a pagar'}
      </FilterPill>
    </div>
  );

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
          <p className="font-semibold text-[#1E924A]">+ {formatCurrency(totalEntradasRecebido / 100)}</p>
          {totalEntradasPrevisto > 0 && (
            <p className="font-semibold text-[#B5803A]">
              ~ {formatCurrency(totalEntradasPrevisto / 100)} previsto
            </p>
          )}
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
          <span className="font-semibold">
            Filtrando por{' '}
            {originLabel(activeIsCard ? originFilter : null, activeIsCard ? null : originFilter) ??
              `••${originFilter}`}
          </span>
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

      {/* Busca + filtros: no mobile só busca + botão "Filtros" (controles no sheet). */}
      <div className="mb-3 mt-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por descrição…"
              className="h-11 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 pr-10 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue md:h-10"
            />
            {search !== '' && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-xl text-lifeone-ink-3 transition hover:text-lifeone-ink"
                title="Limpar busca"
                aria-label="Limpar busca"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setFilterSheetOpen(true)}
            className="relative flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink transition hover:border-lifeone-blue md:hidden"
          >
            <Filter className="h-4 w-4" />
            Filtros
            {activeFilterCount > 0 && (
              <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-lifeone-blue px-1 text-[11px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
          <div className="hidden flex-wrap items-center gap-2 md:flex">{renderFilterControls(false)}</div>
        </div>
        {statusPills}
      </div>

      {filterSheetOpen && (
        <Modal open={filterSheetOpen} onClose={() => setFilterSheetOpen(false)} title="Filtros" variant="sheet" size="sm">
          <div className="flex flex-col gap-3 pb-2">
            {renderFilterControls(true)}
            <Button type="button" onClick={() => setFilterSheetOpen(false)} className="mt-1 w-full">
              Aplicar
            </Button>
          </div>
        </Modal>
      )}

      {projetoShown ? (
        <PorProjetoCategoriaView
          items={porProjetoFiltered}
          selfProjectId={projectId}
          onDrill={drillProjetoCategoria}
        />
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-lifeone-hairline bg-lifeone-card p-8 text-center text-sm text-lifeone-ink-3">
          Nenhuma movimentação com esses filtros.
        </div>
      ) : categoriaShown ? (
        <div className="divide-y divide-lifeone-hairline overflow-hidden rounded-2xl border border-lifeone-hairline bg-lifeone-card">
          {porCategoria.map((c) => {
            const iconCfg = c.tipo
              ? getExpenseIcon(c.tipo)
              : { Icon: CreditCard, color: 'text-[#7A3FC2]', bgColor: 'bg-[#EFE6FA]' };
            const CatIcon = iconCfg.Icon;
            return (
              <button
                key={c.label}
                type="button"
                disabled={!c.tipo}
                onClick={() => {
                  if (!c.tipo) return;
                  setCatFilter(c.tipo);
                  setViewMode('lista');
                }}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
                  c.tipo ? 'hover:bg-lifeone-sidebar' : 'cursor-default'
                }`}
                title={c.tipo ? 'Ver lançamentos desta categoria' : undefined}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconCfg.bgColor} ${iconCfg.color}`}
                >
                  <CatIcon className="h-4 w-4" />
                </span>
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
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const card = item.kind === 'saida' && item.isInvoice ? item.cardLast4 : null;
            const compras = card ? comprasByCard.get(card) ?? [] : [];
            const isExpanded = card ? expandedCards.has(card) : false;
            const q = search.trim().toLowerCase();
            const nested =
              card && isExpanded
                ? q
                  ? compras.filter((c) => c.descricao.toLowerCase().includes(q))
                  : compras
                : [];
            if (nested.length === 0) {
              return renderRow(
                item,
                card && compras.length > 0
                  ? { expandable: true, expanded: isExpanded, onToggleExpand: () => toggleCard(card) }
                  : undefined,
              );
            }
            return (
              <div key={`grp-${rowKey(item)}`} className="space-y-2">
                {renderRow(item, {
                  expandable: true,
                  expanded: isExpanded,
                  onToggleExpand: () => toggleCard(card!),
                })}
                {/* Compras da fatura reveladas inline. Não entram nos totais do header
                    (a fatura já é o evento de caixa) — são só o detalhamento. */}
                <div className="ml-4 space-y-2 border-l-2 border-lifeone-hairline pl-2 md:ml-6 md:pl-3">
                  {nested.map((c) => renderRow(c))}
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
      {actionKind === 'ratear' && actionExpense && (
        <RatearCompraModal
          open
          onClose={closeAction}
          source={actionExpense}
          ownerProjectId={projectId}
          isPending={ratearMutation.isPending || desratearMutation.isPending}
          onSubmit={(allocations) =>
            ratearMutation.mutate({ sourceId: actionExpense.id, allocations }, { onSuccess: closeAction })
          }
          onDesratear={() =>
            desratearMutation.mutate({ sourceId: actionExpense.id }, { onSuccess: closeAction })
          }
        />
      )}
      {actionKind === 'vincular' && actionExpense && (
        <BulkLinkModal
          open
          onClose={closeAction}
          currentProjectId={projectId}
          preselectedSources={[actionExpense]}
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
