'use client';
import { useProject } from '@/contexts/project-context';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, ShoppingCart, ArrowDownWideNarrow, ArrowUpNarrowWide, SlidersHorizontal, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Expense, ExpenseFormData, ExpensesPage, Project } from '@/types';
import { toast } from 'sonner';

import { ExpenseType, isNeutralExpenseType, isSinglePaymentForm } from '@reformaflow/domain';
import { tipoLabel, formaLabel, catMaoLabel } from '@/lib/expense-options';
import {
  type InlineNewRow,
  makeEmptyNewRow,
  getExpenseOptions,
} from './_types';
import { useVoiceExpense } from './_hooks/useVoiceExpense';
import { useExpenseFilters } from './_hooks/useExpenseFilters';
import { useExpenseMutations } from './_hooks/useExpenseMutations';
import { ExpenseKpiCards } from './_components/ExpenseKpiCards';
import { ExpenseFiltersBar } from './_components/ExpenseFiltersBar';
import { VoiceExpenseModal } from './_components/VoiceExpenseModal';
import { ExpenseFormModal } from './_components/ExpenseFormModal';
import { RatearCompraModal } from './_components/RatearCompraModal';
import { PayOptionsModal } from './_components/PayOptionsModal';
import { NovaDespesaWizard } from './_components/NovaDespesaWizard';
import { RecorrenteWizard } from './_components/RecorrenteWizard';
import { QuickAddCard } from './_components/QuickAddCard';
import { CompráveisView } from './_components/CompraveisView';
import { MonthlyExpenseView } from './_components/MonthlyExpenseView';
import { BulkDateProvider, BulkDateToolbar } from './_components/BulkDateSelection';
import { CategoryExpenseView } from './_components/CategoryExpenseView';
import { UnifiedExpenseView } from './_components/UnifiedExpenseView';
import { ExpenseViewToggle, type ExpenseViewMode } from './_components/ExpenseViewToggle';
import { ExpenseEixoToggle, type ExpenseEixo } from './_components/ExpenseEixoToggle';
import { PersonalMonthHeader } from './_components/PersonalMonthHeader';
import { PersonalPeriodPicker } from './_components/PersonalPeriodPicker';
import { useAuth } from '@/contexts/auth-context';
import { PersonalExpenseKpis } from './_components/PersonalExpenseKpis';
import { CartoesStrip } from './_components/CartoesStrip';
import { OriginFilterStrip, originKeyOf } from './_components/OriginChips';
import { CategoriaGastoCards } from './_components/CategoriaGastoCards';
import { InsightsBanner, type BudgetAlert } from './_components/InsightsBanner';
import { ContaRealView } from './_components/ContaRealView';
import { usePersonalCashViews } from './_hooks/usePersonalCashViews';
import type { PersonalCardInfo } from './_components/PersonalExpenseCard';
import { upcomingContaRealMonths, type ContaRealCard } from './_lib/conta-real';
import { groupExpensesByMes, groupExpensesChrono, currentMonthKey, expandExpenseOccurrences } from './_lib/grouping-by-month';
import {
  type RemoteProjectMap,
  type PeriodFilter,
  inPeriod,
  listPeriods,
  currentPeriod,
  groupPersonalExpenses,
  splitPersonalExpenseBase,
  toCaixaBase,
  toDisplayBase,
} from './_lib/personal-hierarchy';
import ImportLauncher from './_components/ImportLauncher';
import { QuitarParcelaModal } from '../conta/_components/QuitarParcelaModal';
import { suggestParcelaQuitacao, suggestParcelaQuitacaoAt } from './_lib/quitarParcelaCross';

const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

// Fatia uma base de despesas pelo período selecionado (mês / ano todo / range),
// expandindo parcelas por competência. Extraído de `periodFilteredPersonal` para
// ser reutilizado nas DUAS bases (caixa × lista por projeto) sem divergir a lógica.
function sliceByPeriod(
  base: Expense[],
  period: PeriodFilter,
  periodYear: number,
  rangeStart: string,
  rangeEnd: string,
): Expense[] {
  // If a range is specified (both start and end), use it to filter occurrences
  if (rangeStart && rangeEnd) {
    const out: Expense[] = [];
    const startDate = new Date(`${rangeStart}-01`);
    const tmp = new Date(`${rangeEnd}-01`);
    // move to last day of end month
    const endDate = new Date(tmp.getFullYear(), tmp.getMonth() + 1, 0);
    for (const e of base) {
      const isInst =
        (e.formaPagamento === 'PARCELADO' || e.formaPagamento === 'QUINZENAL') &&
        (e.quantidadeParcela ?? 1) > 1;
      for (const occ of expandExpenseOccurrences(e, 'competencia')) {
        if (!occ.occDate) continue;
        const occDateObj = new Date(occ.occDate);
        if (occDateObj < startDate || occDateObj > endDate) continue;
        if (!isInst) {
          out.push(e);
        } else {
          out.push({
            ...e,
            valorTotal: occ.occValue,
            quantidadeParcela: 1,
            dataPagamento: occ.occDate,
            dataInicioParcela: undefined,
            status: occ.status,
          });
        }
      }
    }
    return out;
  }

  if (period === 'ALL') {
    return base.filter((e) => inPeriod(e, period, periodYear, 'competencia'));
  }

  // Mês específico: expande parcelas e mantém só a parcela do mês selecionado,
  // com valor, data e status próprios da parcela. IMPORTANTE: a data do slice é
  // ajustada para a data da ocorrência (dataPagamento) e o parcelamento é zerado,
  // senão a UnifiedExpenseView reagrupa pela data ORIGINAL (mês de início) e a
  // parcela "vaza" para o mês errado.
  const out: Expense[] = [];
  for (const e of base) {
    const isInst =
      (e.formaPagamento === 'PARCELADO' || e.formaPagamento === 'QUINZENAL') &&
      (e.quantidadeParcela ?? 1) > 1;
    for (const occ of expandExpenseOccurrences(e, 'competencia')) {
      if (!occ.occDate || occ.occDate.slice(0, 7) !== period) continue;
      if (!isInst) {
        out.push(e);
      } else {
        out.push({
          ...e,
          valorTotal: occ.occValue,
          quantidadeParcela: 1,
          dataPagamento: occ.occDate,
          dataInicioParcela: undefined,
          status: occ.status,
        });
      }
    }
  }
  return out;
}

export function ExpensesView({ lockedEixo }: { lockedEixo?: ExpenseEixo } = {}) {
  const { projectId: PROJECT_ID, projectType } = useProject();
  const { user } = useAuth();
  const TIPO_DESPESA_OPTIONS = useMemo(() => getExpenseOptions(projectType), [projectType]);
  const showRooms = projectType === 'REFORMA';
  const showMaoDeObra = projectType === 'REFORMA';
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'despesas' | 'compraveis'>('despesas');
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<'PLANEJAR' | 'PAGA'>('PLANEJAR');
  const [recorrenteOpen, setRecorrenteOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [ratearSource, setRatearSource] = useState<Expense | null>(null);
  const [formStatus, setFormStatus] = useState<'PLANEJADO' | 'PAGO'>('PLANEJADO');
  const [tipoDespesa, setTipoDespesa] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('');
  const [valor, setValor] = useState('');
  const [quantidade, setQuantidade] = useState('1');
  const [formTitulo, setFormTitulo] = useState('');
  const [formFornecedor, setFormFornecedor] = useState('');
  const [formCategoriaMaoDeObra, setFormCategoriaMaoDeObra] = useState('');
  const [formDataPagamento, setFormDataPagamento] = useState('');
  const [formDataInicioParcela, setFormDataInicioParcela] = useState('');

  // Estado do bloco "Vínculos" do modal de despesa
  const [formVinculos, setFormVinculos] = useState<{ creditCardId: string; bankAccountId: string; linkedExpenseId: string; linkedParcelaIndex?: number | null }>({
    creditCardId: '',
    bankAccountId: '',
    linkedExpenseId: '',
    linkedParcelaIndex: null,
  });

  const defaultExpenseType = (TIPO_DESPESA_OPTIONS[0]?.value ?? ExpenseType.MATERIAL_CONSTRUCAO) as ExpenseType;

  // Inline new row
  const [showNewRow, setShowNewRow] = useState(false);
  const [newRow, setNewRow] = useState<InlineNewRow>(() => makeEmptyNewRow(defaultExpenseType));
  const [editingInlineId, setEditingInlineId] = useState<string | null>(null);
  const [editingInlineRow, setEditingInlineRow] = useState<InlineNewRow>(() => makeEmptyNewRow(defaultExpenseType));

  // Expand/collapse per expense (for parcelas detail)
  const [expandedExpenses, setExpandedExpenses] = useState<Set<string>>(new Set());
  // Expand/collapse per category
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  // View mode: por categoria (legado) ou por mês (nova UX igual recebimentos)
  const [viewMode, setViewMode] = useState<ExpenseViewMode>('category');
  // Mobile: controles (busca/filtros/visão/período) recolhidos atrás de "Filtrar".
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());
  // Direção de ordenação da visão "Geral" (extrato por data). Padrão: decrescente.
  const [generalSortDir, setGeneralSortDir] = useState<'asc' | 'desc'>('desc');
  // Eixo da tela (PESSOAL): competência (Gastos Controle, padrão) × caixa (Conta Real).
  // Quando `lockedEixo` é passado (rota dedicada), o eixo é fixo e o toggle some.
  const [eixoState, setEixoState] = useState<ExpenseEixo>(lockedEixo ?? 'competencia');
  const eixo = lockedEixo ?? eixoState;
  const setEixo = setEixoState;
  /** Filtro por origem (cartão/conta) do strip da visão Gastos Controle. */
  const [originFilter, setOriginFilter] = useState<string | null>(null);
  // Seleção múltipla para alterar data em bulk (visões Geral, Mês, Categoria).
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDate, setBulkDate] = useState('');
  const toggleBulkId = useCallback((id: string) => {
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exitBulkMode = useCallback(() => {
    setBulkSelectMode(false);
    setBulkSelectedIds(new Set());
    setBulkDate('');
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(`expenses:eixo:${PROJECT_ID}`);
    if (saved === 'competencia' || saved === 'caixa') setEixo(saved);
  }, [PROJECT_ID]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(`expenses:eixo:${PROJECT_ID}`, eixo);
  }, [eixo, PROJECT_ID]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = `expenses:viewMode:${PROJECT_ID}`;
    const saved = window.localStorage.getItem(key);
    if (saved === 'category' || saved === 'month' || saved === 'project' || saved === 'general') setViewMode(saved);
  }, [PROJECT_ID]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(`expenses:viewMode:${PROJECT_ID}`, viewMode);
  }, [viewMode, PROJECT_ID]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(`expenses:generalSort:${PROJECT_ID}`);
    if (saved === 'asc' || saved === 'desc') setGeneralSortDir(saved);
  }, [PROJECT_ID]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(`expenses:generalSort:${PROJECT_ID}`, generalSortDir);
  }, [generalSortDir, PROJECT_ID]);

  const { data: expensesPage, isLoading } = useQuery<ExpensesPage>({
    queryKey: ['expenses', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses?pageSize=2000`),
  });
  const expenses = expensesPage?.items ?? [];

  const { data: project } = useQuery<Project>({
    queryKey: ['project', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}`),
  });

  // Cross-project despesas (PESSOAL): full data com room+project, usado tanto
  // para mostrar como itens próprios quanto para resolver linkedExpenseId via remoteMap.
  const { data: crossProjectExpenses = [] } = useQuery<Expense[]>({
    queryKey: ['cross-project-expenses', PROJECT_ID, 'unified-view'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses/cross-project?limit=2000`),
    enabled: projectType === 'PESSOAL',
    staleTime: 60_000,
  });

  const remoteProjectMap = useMemo<RemoteProjectMap>(() => {
    const m = new Map();
    for (const e of crossProjectExpenses) {
      if (e.project) m.set(e.id, { id: e.project.id, name: e.project.name, type: e.project.type });
    }
    return m;
  }, [crossProjectExpenses]);

  // Lista consolidada para PESSOAL: despesas locais + despesas dos outros projetos.
  // Dedup do vínculo cross-project CLASSIFICADO PELA FORMA DO ALVO:
  // - alvo à-vista/ausente (single) → removido: o espelho é o registro canônico.
  // - alvo parcelado/quinzenal → mantido: é o registro canônico da despesa
  //   parcelada; os espelhos permanecem para alimentar a caixa.
  // `parceladoTargetIds` separa depois os dois mundos (caixa × lista por projeto).
  const { allExpensesPersonal, parceladoTargetIds } = useMemo<{
    allExpensesPersonal: Expense[];
    parceladoTargetIds: Set<string>;
  }>(() => {
    if (projectType !== 'PESSOAL') {
      return { allExpensesPersonal: expenses, parceladoTargetIds: new Set<string>() };
    }
    const split = splitPersonalExpenseBase(expenses, crossProjectExpenses);
    return {
      allExpensesPersonal: split.mutationsBase,
      parceladoTargetIds: split.parceladoTargetIds,
    };
  }, [projectType, expenses, crossProjectExpenses]);


  const { data: plannedExpenses = [] } = useQuery<Expense[]>({
    queryKey: ['expenses', PROJECT_ID, 'planned'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses/planned`),
    enabled: payModalOpen,
  });

  const roomOptions = useMemo(() =>
    (project?.rooms ?? []).map((r) => ({ value: r.id, label: r.name })),
    [project]
  );

  // ── Contexto do formulário de edição ───────────────────────────────
  // Na visão consolidada (PESSOAL) é possível editar despesas de OUTROS projetos.
  // O formulário precisa usar a config do projeto DONO da despesa (ex.: REFORMA tem
  // Ambiente e tipos próprios), senão salvar apaga ambiente/tipo.
  const editingProjectId = editing?.project?.id ?? PROJECT_ID;
  const editingProjectType = editing?.project?.type ?? projectType;
  const isCrossProjectEdit = !!editing?.project && editing.project.id !== PROJECT_ID;

  const { data: editingProject } = useQuery<Project>({
    queryKey: ['project', editingProjectId],
    queryFn: () => api.get(`/projects/${editingProjectId}`),
    enabled: isCrossProjectEdit,
  });

  const formShowRooms = editingProjectType === 'REFORMA';
  const formTipoOptions = useMemo(
    () => getExpenseOptions(editingProjectType),
    [editingProjectType],
  );
  const formRoomOptions = useMemo(() => {
    const src = isCrossProjectEdit ? editingProject : project;
    const opts = (src?.rooms ?? []).map((r) => ({ value: r.id, label: r.name }));
    // Garante que o ambiente atual da despesa apareça mesmo se a lista ainda não carregou.
    if (editing?.roomId && !opts.some((o) => o.value === editing.roomId)) {
      opts.unshift({ value: editing.roomId, label: editing.room?.name ?? 'Ambiente atual' });
    }
    return opts;
  }, [isCrossProjectEdit, editingProject, project, editing]);

  const {
    showFilters,
    setShowFilters,
    filters,
    updateFilter,
    clearFilters,
    searchText,
    setSearchText,
    filteredExpenses,
    hasActiveFilters,
    categorias,
  } = useExpenseFilters(allExpensesPersonal, showRooms);

  // Período (filtro mês específico / ano todo) — só usado quando PESSOAL
  const [periodYear] = useState<number>(() => new Date().getFullYear());
  const [period, setPeriod] = useState<PeriodFilter>(() => currentPeriod());
  // Range filter: start and end in format YYYY-MM (optional)
  const [rangeStart, setRangeStart] = useState<string>('');
  const [rangeEnd, setRangeEnd] = useState<string>('');

  const allPeriods = useMemo(
    () => projectType === 'PESSOAL' ? listPeriods(filteredExpenses, periodYear) : [],
    [projectType, filteredExpenses, periodYear],
  );
  const navigatePeriod = (delta: -1 | 1) => {
    if (period === 'ALL') return;
    const [yy, mm] = period.split('-').map(Number);
    const d = new Date(yy, mm - 1 + delta, 1);
    setPeriod(`${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`);
  };
  // Duas bases puras de `filteredExpenses` (só divergem quando PESSOAL, pois
  // `parceladoTargetIds` é vazio nos demais tipos):
  // - caixaFiltered: remove o ALVO parcelado (mantém espelhos) → Conta Real/KPIs.
  // - displayFiltered: remove os ESPELHOS parcelado (mantém o alvo) → lista por projeto.
  const caixaFiltered = useMemo<Expense[]>(
    () => (projectType === 'PESSOAL' ? toCaixaBase(filteredExpenses, parceladoTargetIds) : filteredExpenses),
    [projectType, filteredExpenses, parceladoTargetIds],
  );
  const displayFiltered = useMemo<Expense[]>(
    () => (projectType === 'PESSOAL' ? toDisplayBase(filteredExpenses, parceladoTargetIds) : filteredExpenses),
    [projectType, filteredExpenses, parceladoTargetIds],
  );

  const periodFilteredPersonal = useMemo<Expense[]>(() => {
    if (projectType !== 'PESSOAL') return caixaFiltered;
    return sliceByPeriod(caixaFiltered, period, periodYear, rangeStart, rangeEnd);
  }, [projectType, caixaFiltered, period, periodYear, rangeStart, rangeEnd]);

  const periodFilteredDisplay = useMemo<Expense[]>(() => {
    if (projectType !== 'PESSOAL') return displayFiltered;
    return sliceByPeriod(displayFiltered, period, periodYear, rangeStart, rangeEnd);
  }, [projectType, displayFiltered, period, periodYear, rangeStart, rangeEnd]);

  // KPIs (excluem tipos neutros — movimentação interna / pagto fatura).
  // Em PESSOAL respeitam o período selecionado (mês clicado / ano todo); nos demais
  // projetos periodFilteredPersonal === filteredExpenses. Calculado por ocorrência
  // para refletir pagamento parcial de parcelas/quinzenas.
  const { totalGeral, totalPlanejado, totalPago } = useMemo(() => {
    let geral = 0, planejado = 0, pago = 0;
    for (const e of periodFilteredPersonal) {
      if (isNeutralExpenseType(e.tipoDespesa)) continue;
      for (const occ of expandExpenseOccurrences(e, 'competencia')) {
        geral += occ.occValue;
        if (occ.status === 'PAGO') pago += occ.occValue;
        else planejado += occ.occValue;
      }
    }
    return { totalGeral: geral, totalPlanejado: planejado, totalPago: pago };
  }, [periodFilteredPersonal]);

  // Quebra por projeto (cockpit) — só faz sentido no Pessoal, que consolida vários projetos.
  // Respeita o período selecionado (mês clicado / ano todo).
  const kpiPerProject = useMemo(() => {
    if (projectType !== 'PESSOAL') return [];
    return groupPersonalExpenses(
      periodFilteredDisplay,
      remoteProjectMap,
      project?.name ?? 'Pessoal',
      PROJECT_ID,
    ).map((g) => ({
      key: g.projectKey,
      name: g.projectName,
      type: g.projectType,
      planejado: g.totalPlanejado,
      pago: g.totalPago,
      total: g.totalPlanejado + g.totalPago,
      count: g.itens.length,
    }));
  }, [projectType, periodFilteredDisplay, remoteProjectMap, project?.name, PROJECT_ID]);

  // Visão mensal — usa a base de DISPLAY (alvo canônico expandido por parcela),
  // NÃO a base crua: `filteredExpenses` contém o alvo parcelado E seus espelhos,
  // e como `groupExpensesByMes` expande ocorrências, somar os dois dobraria o mês
  // do espelho (ex.: quinzenal 80k → parcela idx0/idx1 em junho + os 2 PIX de 8k).
  // Nos demais projetos `displayFiltered === filteredExpenses`.
  const groupedByMes = useMemo(() => groupExpensesByMes(displayFiltered), [displayFiltered]);

  // PESSOAL — despesas do período após o filtro por origem (strip de cartões/conta).
  // Alimenta APENAS as listas (KPIs e o strip usam o conjunto sem filtro de origem,
  // para que todas as origens permaneçam visíveis e somáveis).
  const displayPersonal = useMemo<Expense[]>(
    () => originFilter ? periodFilteredDisplay.filter((e) => originKeyOf(e) === originFilter) : periodFilteredDisplay,
    [periodFilteredDisplay, originFilter],
  );

  // Gastos por categoria no mês (respeita o filtro de origem ativo).
  const categoriaCards = useMemo(() => {
    const m = new Map<string, { tipo: string; total: number; pago: number; planejado: number; count: number }>();
    for (const e of displayPersonal) {
      if (isNeutralExpenseType(e.tipoDespesa)) continue;
      let row = m.get(e.tipoDespesa);
      if (!row) {
        row = { tipo: e.tipoDespesa, total: 0, pago: 0, planejado: 0, count: 0 };
        m.set(e.tipoDespesa, row);
      }
      row.total += e.valorTotal;
      if (e.status === 'PAGO') row.pago += e.valorTotal;
      else row.planejado += e.valorTotal;
      row.count++;
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total);
  }, [displayPersonal]);


  // Visão "Geral" (extrato cronológico). Usa a MESMA base de dados da visão ativa
  // (PESSOAL respeita o período selecionado; demais usam o conjunto filtrado),
  // então o filtro de data é honrado igual às outras visões.
  const groupedGeneral = useMemo(
    () => groupExpensesChrono(projectType === 'PESSOAL' ? displayPersonal : filteredExpenses, generalSortDir),
    [projectType, displayPersonal, filteredExpenses, generalSortDir],
  );
  // IDs visíveis na lista ativa (para "selecionar tudo" no bulk de data).
  const bulkVisibleIds = useMemo(() => {
    const base = projectType === 'PESSOAL' ? displayPersonal : filteredExpenses;
    return new Set(base.map((e) => e.id));
  }, [projectType, displayPersonal, filteredExpenses]);
  const bulkAllSelected = bulkVisibleIds.size > 0 && bulkSelectedIds.size === bulkVisibleIds.size;
  const applyBulkDate = useCallback(() => {
    if (!bulkDate || bulkSelectedIds.size === 0) return;
    bulkDateMutation.mutate(
      { ids: Array.from(bulkSelectedIds), dataPagamento: bulkDate },
      { onSuccess: () => exitBulkMode() },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkDate, bulkSelectedIds, exitBulkMode]);
  const applyBulkPaid = useCallback(() => {
    if (bulkSelectedIds.size === 0) return;
    bulkPaidMutation.mutate(
      { ids: Array.from(bulkSelectedIds) },
      { onSuccess: () => exitBulkMode() },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkSelectedIds, exitBulkMode]);
  useEffect(() => {
    const cur = currentMonthKey();
    setCollapsedMonths(new Set(groupedByMes.filter((g) => g.mesKey !== cur).map((g) => g.mesKey)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedByMes.length]);

  const {
    invalidate,
    resolveOwnerProjectId,
    createMutation,
    updateMutation,
    deleteMutation,
    payMutation,
    toggleStatusMutation,
    toggleParcelaMutation,
    quickUpdateMutation,
    changeTipoMutation,
    bulkDateMutation,
    bulkPaidMutation,
    conciliarMutation,
    ratearMutation,
    desratearMutation,
  } = useExpenseMutations({
    projectId: PROJECT_ID,
    allExpensesPersonal,
    defaultExpenseType,
    closeFormModal,
    setShowNewRow,
    setNewRow,
    setPayModalOpen,
  });

  // ── Quitação cross-project via lista de despesas (Visão Projeto PESSOAL) ──
  // Uma despesa-alvo de OUTRO projeto exibida na lista consolidada do PESSOAL
  // NÃO pode ter o status alternado "no vazio" (setParcelaStatus no projeto dono):
  // isso a faz sumir da Visão Conta, pois não gera o espelho/movimento real.
  // Interceptamos o toggle e roteamos para o mesmo fluxo de quitação da Visão
  // Conta (cria espelho pago + concilia a parcela).
  const [quitarTarget, setQuitarTarget] = useState<null | {
    foreignExpenseId: string;
    parcelaIndex: number;
    valorSugerido: number;
    descricao: string;
    dataSugerida: string;
  }>(null);

  const ownerProjectIdOf = useCallback(
    (id: string): string => {
      const exp = allExpensesPersonal.find((e) => e.id === id);
      return exp?.project?.id ?? exp?.projectId ?? PROJECT_ID;
    },
    [allExpensesPersonal, PROJECT_ID],
  );

  const describeExpense = useCallback(
    (exp: Expense): string =>
      exp.titulo?.trim() || exp.fornecedor?.trim() || tipoLabel(exp.tipoDespesa),
    [],
  );

  const handleToggleStatus = useCallback(
    (id: string, status: 'PAGO' | 'PLANEJADO') => {
      const exp = allExpensesPersonal.find((e) => e.id === id);
      if (exp && ownerProjectIdOf(id) !== PROJECT_ID) {
        if (status === 'PAGO') {
          const sug = suggestParcelaQuitacao(exp);
          setQuitarTarget({ foreignExpenseId: id, ...sug, descricao: describeExpense(exp) });
        } else {
          toast.info('Para desfazer uma quitação cross-project, use a Visão Conta.');
        }
        return;
      }
      toggleStatusMutation.mutate({ id, status });
    },
    [allExpensesPersonal, ownerProjectIdOf, PROJECT_ID, describeExpense, toggleStatusMutation],
  );

  const handleToggleParcela = useCallback(
    (id: string, parcela: number, paid: boolean) => {
      const exp = allExpensesPersonal.find((e) => e.id === id);
      if (exp && ownerProjectIdOf(id) !== PROJECT_ID) {
        if (paid) {
          const sug = suggestParcelaQuitacaoAt(exp, parcela);
          setQuitarTarget({ foreignExpenseId: id, ...sug, descricao: describeExpense(exp) });
        } else {
          toast.info('Para desfazer uma quitação cross-project, use a Visão Conta.');
        }
        return;
      }
      toggleParcelaMutation.mutate({ id, parcela, paid });
    },
    [allExpensesPersonal, ownerProjectIdOf, PROJECT_ID, describeExpense, toggleParcelaMutation],
  );

  function closeFormModal() {
    setFormModalOpen(false);
    setEditing(null);
    setTipoDespesa('');
    setFormaPagamento('');
    setValor('');
    setQuantidade('1');
    setFormTitulo('');
    setFormFornecedor('');
    setFormCategoriaMaoDeObra('');
    setFormDataPagamento('');
    setFormDataInicioParcela('');
  }

  function openPayOptions() {
    setPayModalOpen(true);
  }

  function openEdit(expenseArg: Expense) {
    // Em PESSOAL com mês específico, a despesa pode vir "fatiada" (1 parcela);
    // resolve a original para editar valores/parcelas corretos.
    const expense = allExpensesPersonal.find((x) => x.id === expenseArg.id) ?? expenseArg;
    setShowNewRow(false);
    closeInlineEdit();
    setEditing(expense);
    setFormStatus(expense.status as 'PLANEJADO' | 'PAGO');
    setTipoDespesa(expense.tipoDespesa);
    setFormaPagamento(expense.formaPagamento);
    setValor(expense.valor ? (expense.valor / 100).toFixed(2) : '');
    setQuantidade(String(expense.quantidade ?? 1));
    setFormTitulo(expense.titulo ?? '');
    setFormFornecedor(expense.fornecedor ?? '');
    setFormCategoriaMaoDeObra(expense.categoriaMaoDeObra ?? '');
    setFormDataPagamento(expense.dataPagamento?.slice(0, 10) ?? '');
    setFormDataInicioParcela(expense.dataInicioParcela?.slice(0, 10) ?? '');
    setFormVinculos({
      creditCardId: '',
      bankAccountId: '',
      linkedExpenseId: expense.linkedExpenseId ?? '',
      linkedParcelaIndex: null,
    });
    setFormModalOpen(true);
  }

  /**
   * Ao vincular esta despesa a outra (cross-project), herda as características
   * da despesa alvo: tipo e categoria sobrescrevem; título/fornecedor só se vazios.
   */
  function handleLinkSelected(exp: {
    tipoDespesa?: string | null;
    categoriaMaoDeObra?: string | null;
    titulo?: string | null;
    fornecedor?: string | null;
    formaPagamento?: string | null;
    dataPagamento?: string | null;
    dataInicioParcela?: string | null;
  }) {
    if (exp.tipoDespesa) setTipoDespesa(exp.tipoDespesa);
    setFormCategoriaMaoDeObra(exp.categoriaMaoDeObra ?? '');
    setFormTitulo((prev) => prev || exp.titulo || '');
    setFormFornecedor((prev) => prev || exp.fornecedor || '');
    if (exp.formaPagamento) setFormaPagamento(exp.formaPagamento);
    const forma = exp.formaPagamento ?? formaPagamento;
    if (isSinglePaymentForm(forma)) {
      if (exp.dataPagamento) setFormDataPagamento(exp.dataPagamento.slice(0, 10));
    } else if (exp.dataInicioParcela) {
      setFormDataInicioParcela(exp.dataInicioParcela.slice(0, 10));
    }
  }

  function openInlineEdit(expense: Expense) {
    setShowNewRow(false);
    setEditingInlineId(expense.id);
    setEditingInlineRow({
      tipoDespesa: expense.tipoDespesa,
      categoriaMaoDeObra: expense.categoriaMaoDeObra ?? '',
      roomId: expense.roomId ?? '',
      valor: (expense.valor / 100).toFixed(2),
      quantidade: String(expense.quantidade ?? 1),
      titulo: expense.titulo ?? '',
      fornecedor: expense.fornecedor ?? '',
      formaPagamento: expense.formaPagamento,
      status: expense.status,
      dataPagamento: expense.dataPagamento?.slice(0, 10) ?? '',
      quantidadeParcela: expense.quantidadeParcela ? String(expense.quantidadeParcela) : '',
      dataInicioParcela: expense.dataInicioParcela?.slice(0, 10) ?? '',
    });
  }

  function closeInlineEdit() {
    setEditingInlineId(null);
    setEditingInlineRow(makeEmptyNewRow(defaultExpenseType));
  }

  function buildPayloadFromInlineRow(row: InlineNewRow, defaultDateIfMissing = false): ExpenseFormData {
    const fp = row.formaPagamento;
    const data: ExpenseFormData = {
      tipoDespesa: row.tipoDespesa,
      categoriaMaoDeObra: row.tipoDespesa === 'MAO_DE_OBRA' && row.categoriaMaoDeObra ? row.categoriaMaoDeObra : null,
      roomId: showRooms ? (row.roomId || null) : null,
      valor: parseFloat(row.valor),
      quantidade: parseInt(row.quantidade) || 1,
      titulo: row.titulo || null,
      fornecedor: row.fornecedor || null,
      formaPagamento: fp,
      status: row.status as 'PLANEJADO' | 'PAGO',
    };
    if (isSinglePaymentForm(fp)) {
      data.dataPagamento = row.dataPagamento || (defaultDateIfMissing ? new Date().toISOString().slice(0, 10) : null);
      data.quantidadeParcela = null;
      data.dataInicioParcela = null;
    } else if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
      data.quantidadeParcela = parseInt(row.quantidadeParcela) || 1;
      data.dataInicioParcela = row.dataInicioParcela || null;
      data.dataPagamento = null;
    }
    return data;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    // Campos opcionais: string vazia → null (sinaliza ao backend "limpar campo").
    // Mantém `null` no payload (em vez de undefined) para que Prisma seta NULL no banco.
    const nullable = (key: string) => {
      const v = form.get(key);
      if (v === null) return null;
      const trimmed = (v as string).trim();
      return trimmed === '' ? null : trimmed;
    };
    const data: ExpenseFormData = {
      tipoDespesa: form.get('tipoDespesa') as string,
      categoriaMaoDeObra: nullable('categoriaMaoDeObra'),
      roomId: formShowRooms ? nullable('roomId') : null,
      valor: Number(form.get('valor')),
      quantidade: Number(form.get('quantidade')),
      titulo: nullable('titulo'),
      fornecedor: nullable('fornecedor'),
      link: nullable('link'),
      imageUrl: nullable('imageUrl'),
      formaPagamento: form.get('formaPagamento') as string,
      status: formStatus,
    };
    // Data da compra (competência) — independe da forma de pagamento. Vazio = null.
    data.dataCompra = nullable('dataCompra');
    const fp = data.formaPagamento;
    if (isSinglePaymentForm(fp)) {
      data.dataPagamento = nullable('dataPagamento');
      data.quantidadeParcela = null;
      data.dataInicioParcela = null;
      const isRec = form.get('recorrente') === 'on';
      data.recorrente = isRec;
      const fim = nullable('recorrenciaFim'); // input month → 'YYYY-MM'
      data.recorrenciaFim = isRec && fim ? `${fim}-01` : null;
    } else if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
      const q = Number(form.get('quantidadeParcela'));
      data.quantidadeParcela = q > 0 ? q : null;
      data.dataInicioParcela = nullable('dataInicioParcela');
      data.dataPagamento = null;
      data.recorrente = false;
      data.recorrenciaFim = null;
    }
    // Vínculos (cards/contas/cross-project) — '' equivale a null pro backend
    data.creditCardId = formVinculos.creditCardId || null;
    data.bankAccountId = formVinculos.bankAccountId || null;
    const linkedId = formVinculos.linkedExpenseId || null;
    const parcelaIdx = formVinculos.linkedParcelaIndex;
    // Quando o usuário escolheu uma PARCELA específica do alvo, a conciliação
    // (Fase 6) cuida de setar o vínculo + liquidar a parcela — então não enviamos
    // linkedExpenseId no payload (evita set duplicado/simples).
    const useConciliacao = !!linkedId && parcelaIdx != null;
    data.linkedExpenseId = useConciliacao ? null : linkedId;

    const afterSave = (sourceId?: string) => {
      if (useConciliacao && linkedId && sourceId) {
        conciliarMutation.mutate({ sourceId, targetExpenseId: linkedId, parcelaIndex: parcelaIdx! });
      }
    };

    if (editing) {
      console.log('[expenses] PATCH', editing.id, data);
      updateMutation.mutate({ id: editing.id, data }, { onSuccess: () => afterSave(editing.id) });
    } else {
      console.log('[expenses] POST', data);
      createMutation.mutate(data, { onSuccess: (created) => afterSave((created as { id?: string } | undefined)?.id) });
    }
  }

  // Inline new row
  function handleInlineSubmit() {
    if (!newRow.valor || !newRow.tipoDespesa) return;
    const data = buildPayloadFromInlineRow(newRow, true);
    createMutation.mutate(data);
  }

  function handleInlineUpdateSubmit() {
    if (!editingInlineId || !editingInlineRow.valor || !editingInlineRow.tipoDespesa) return;
    const data = buildPayloadFromInlineRow(editingInlineRow);
    updateMutation.mutate(
      { id: editingInlineId, data },
      { onSuccess: () => closeInlineEdit() },
    );
  }

  function inlineKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleInlineSubmit();
    else if (e.key === 'Escape') setShowNewRow(false);
  }

  function inlineEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleInlineUpdateSubmit();
    else if (e.key === 'Escape') closeInlineEdit();
  }

  const valorTotal = useMemo(() => {
    const v = parseFloat(valor) || 0;
    const q = parseInt(quantidade) || 1;
    return v * q;
  }, [valor, quantidade]);

  // (moved to top of component)

  const toggleExpand = (id: string) => {
    setExpandedExpenses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCategory = (tipo: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(tipo)) next.delete(tipo);
      else next.add(tipo);
      return next;
    });
  };

  const COL_SPAN = showRooms ? 9 : 8;

  // ─── Lançamento por voz (hook isolado em _hooks/useVoiceExpense.ts) ───
  const allowedExpenseTypes = useMemo(
    () => TIPO_DESPESA_OPTIONS.map((o) => o.value as ExpenseType),
    [TIPO_DESPESA_OPTIONS],
  );

  // Cartões/contas/projetos do tenant — usados pela IA de voz para auto-vincular
  // ("no Itaú", "no 5868", "para a reforma").
  const { data: tenantCards = [] } = useQuery<
    Array<{ id: string; last4: string; nickname?: string | null; brand?: string | null; closingDay?: number | null; dueDay?: number | null }>
  >({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });
  const { data: tenantAccounts = [] } = useQuery<
    Array<{ id: string; last4?: string | null; nickname?: string | null; institution?: string | null }>
  >({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });
  const { data: tenantProjects = [] } = useQuery<Array<{ id: string; name: string; type: string }>>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
  });

  // Metas por categoria (PESSOAL) — para exibir limite/uso nos cards de categoria do mês.
  const budgetMes = projectType === 'PESSOAL' && period !== 'ALL' ? period : null;
  const { data: categoryBudgets = [] } = useQuery<Array<{ id: string; tipoDespesa: string; mes: string | null; valorLimiteCents: number }>>({
    queryKey: ['category-budgets', PROJECT_ID, budgetMes],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/category-budgets?mes=${budgetMes}`),
    enabled: !!budgetMes,
    staleTime: 30_000,
  });
  const limitsByTipo = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of categoryBudgets) m.set(b.tipoDespesa, b.valorLimiteCents);
    return m;
  }, [categoryBudgets]);

  // Alertas de orçamento (insights): categorias com meta que passaram de 80%.
  const budgetAlerts = useMemo(() => {
    if (projectType !== 'PESSOAL') return [] as BudgetAlert[];
    const out: BudgetAlert[] = [];
    for (const c of categoriaCards) {
      const limite = limitsByTipo.get(c.tipo);
      if (!limite || limite <= 0) continue;
      const pct = Math.round((c.total / limite) * 100);
      if (pct < 80) continue;
      out.push({
        tipo: c.tipo,
        label: tipoLabel(c.tipo),
        gastoCents: c.total,
        limiteCents: limite,
        pct,
        level: pct >= 100 ? 'danger' : 'warning',
      });
    }
    return out.sort((a, b) => b.pct - a.pct);
  }, [projectType, categoriaCards, limitsByTipo, tipoLabel]);

  const voice = useVoiceExpense({
    allowedExpenseTypes,
    defaultExpenseType,
    onCreate: (data, onSuccess) => createMutation.mutate(data, { onSuccess }),
    cards: tenantCards,
    accounts: tenantAccounts,
    projects: tenantProjects,
    currentProjectId: PROJECT_ID,
  });
  const {
    voiceModalOpen,
    voiceSupported,
    voiceListening,
    voiceTranscript,
    voiceError,
    voiceData,
    setVoiceData,
    voiceFornecedor,
    setVoiceFornecedor,
    voiceLinkedExpenseId,
    setVoiceLinkedExpenseId,
    voiceLinkedProject,
    openVoiceModal,
    closeVoiceModal,
    clearVoiceTranscript,
    startVoiceCapture,
    saveVoiceExpense,
  } = voice;

  // Cartões com fechamento/vencimento — para derivar a Conta Real (eixo caixa).
  const contaRealCards = useMemo<ContaRealCard[]>(
    () =>
      tenantCards.map((c) => ({
        last4: c.last4,
        label: `${c.nickname || c.brand || 'Cartão'} ••${c.last4}`,
        closingDay: c.closingDay ?? null,
        dueDay: c.dueDay ?? null,
      })),
    [tenantCards],
  );
  const cardInfoByLast4 = useMemo<Map<string, PersonalCardInfo>>(() => {
    const m = new Map<string, PersonalCardInfo>();
    for (const c of contaRealCards) {
      if (!c.last4 || m.has(c.last4)) continue;
      m.set(c.last4, { label: c.label, closingDay: c.closingDay, dueDay: c.dueDay });
    }
    return m;
  }, [contaRealCards]);

  const isPersonal = projectType === 'PESSOAL';
  const {
    gastosControleKpis,
    cartoesFormacao,
    contaRealMonths,
    selectedContaReal,
    contaRealAll,
  } = usePersonalCashViews({
    filteredExpenses: caixaFiltered,
    periodFilteredPersonal,
    cards: contaRealCards,
    period,
  });

  // Conta Real — agregação do período (mês selecionado ou ano todo).
  const contaRealMonthsToShow = period === 'ALL' ? contaRealAll : selectedContaReal ? [selectedContaReal] : [];
  const contaRealUpcomingMonths = useMemo(
    () => (period === 'ALL' ? [] : upcomingContaRealMonths(contaRealMonths, period, 6)),
    [contaRealMonths, period],
  );
  const contaRealKpis = useMemo(() => {
    const agg = contaRealMonthsToShow.reduce(
      (a, m) => {
        a.faturasVencendo += m.totalFaturas;
        a.debitos += m.totalDebitos;
        a.faltaSair += m.planejado;
        return a;
      },
      { faturasVencendo: 0, debitos: 0, faltaSair: 0 },
    );
    return agg;
  }, [contaRealMonthsToShow]);
  const faturasVencendoStrip = contaRealMonthsToShow.flatMap((m) => m.faturas);

  return (
    <div className="space-y-4">
      {/* Header with tabs */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          {isPersonal ? (
            <PersonalMonthHeader
              title={lockedEixo === 'caixa' ? 'Visão Conta' : 'Despesas'}
              userName={user?.name}
              period={period}
              onPrev={() => navigatePeriod(-1)}
              onNext={() => navigatePeriod(1)}
            />
          ) : (
            <h1 className="text-xl font-bold text-gray-900">{lockedEixo === 'caixa' ? 'Visão Conta' : 'Despesas'}</h1>
          )}
          {!isPersonal && lockedEixo !== 'caixa' && (
          <div className="inline-flex rounded-lg border border-gray-200 text-sm overflow-hidden">
            <button
              onClick={() => setActiveTab('despesas')}
              className={`px-4 py-1.5 transition-colors font-medium ${activeTab === 'despesas' ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >Despesas</button>
            {projectType === 'REFORMA' && (
              <button
                onClick={() => setActiveTab('compraveis')}
                className={`px-4 py-1.5 transition-colors font-medium border-l border-gray-200 flex items-center gap-1.5 ${activeTab === 'compraveis' ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              ><ShoppingCart className="w-3.5 h-3.5" /> Compráveis</button>
            )}
          </div>
          )}
        </div>
        {activeTab === 'despesas' && (
          <div className="flex flex-wrap gap-2 items-center">
            <Button onClick={openPayOptions}>
              <Plus className="w-4 h-4" /> Nova despesa
            </Button>
          </div>
        )}
      </div>

      {activeTab === 'compraveis' ? (
        <CompráveisView expenses={expenses} tipoLabel={tipoLabel} />
      ) : (
      <>

      {/* KPI Cards — cockpit financeiro */}
      {isPersonal ? (
        <div className="space-y-3">
          {!lockedEixo && <ExpenseEixoToggle eixo={eixo} onChange={setEixo} />}
          <PersonalExpenseKpis
            eixo={eixo}
            gastosControle={gastosControleKpis}
            contaReal={contaRealKpis}
          />
          {eixo === 'competencia' ? (
            <>
              <InsightsBanner alerts={budgetAlerts} />
              <OriginFilterStrip
                expenses={periodFilteredPersonal}
                selected={originFilter}
                onSelect={setOriginFilter}
              />
              <CategoriaGastoCards categorias={categoriaCards} tipoLabel={tipoLabel} limitsByTipo={limitsByTipo} />
            </>
          ) : (
            <CartoesStrip mode={eixo} cartoes={cartoesFormacao} faturas={faturasVencendoStrip} />
          )}
        </div>
      ) : (
        <ExpenseKpiCards
          projectType={projectType}
          filteredCount={periodFilteredPersonal.length}
          filteredPlanejadoCount={periodFilteredPersonal.filter((e) => e.status === 'PLANEJADO').length}
          filteredPagoCount={periodFilteredPersonal.filter((e) => e.status === 'PAGO').length}
          totalGeral={totalGeral}
          totalPlanejado={totalPlanejado}
          totalPago={totalPago}
          perProject={kpiPerProject}
        />
      )}

      {/* Mobile: botão que revela os controles (busca/filtros/visão/período).
          Mantém a lista na primeira dobra; no desktop os controles ficam inline. */}
      <button
        type="button"
        onClick={() => setMobileControlsOpen((v) => !v)}
        className="md:hidden flex w-full items-center justify-between rounded-xl border border-darc-linen bg-white px-4 py-2.5 text-sm font-semibold text-darc-velvet shadow-darc-soft"
      >
        <span className="truncate">
          {viewMode === 'category' ? 'Categoria' : viewMode === 'month' ? 'Mês' : viewMode === 'project' ? 'Por projeto' : 'Geral'}
          {projectType === 'PESSOAL' && /^\d{4}-\d{2}$/.test(String(period))
            ? ` · ${['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][parseInt(String(period).slice(5, 7), 10) - 1]}`
            : ''}
        </span>
        <span className="flex items-center gap-1.5 text-darc-velvet/60">
          <SlidersHorizontal className="w-4 h-4" />
          Filtrar
          <ChevronDown className={`w-4 h-4 transition-transform ${mobileControlsOpen ? 'rotate-180' : ''}`} />
        </span>
      </button>

      <div className={`${mobileControlsOpen ? 'block' : 'hidden'} md:block space-y-3`}>
        {/* Search + Filter bar */}
        <ExpenseFiltersBar
          searchText={searchText}
          onSearchTextChange={setSearchText}
          showFilters={showFilters}
          onToggleFilters={() => setShowFilters(!showFilters)}
          filters={filters}
          updateFilter={updateFilter}
          clearFilters={clearFilters}
          hasActiveFilters={hasActiveFilters}
          showRooms={showRooms}
          tipoDespesaOptions={TIPO_DESPESA_OPTIONS}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          onRangeStartChange={setRangeStart}
          onRangeEndChange={setRangeEnd}
        />

        {/* Toggle de visão (Categoria / Mês / Por projeto) — logo abaixo da busca */}
        {!(isPersonal && eixo === 'caixa') && (
          <div className="flex">
            <ExpenseViewToggle value={viewMode} onChange={setViewMode} showProject={projectType === 'PESSOAL'} />
          </div>
        )}

        {/* Período (PESSOAL) — dropdown de mês / ano todo (nav ◂ ▸ fica no header) */}
        {projectType === 'PESSOAL' && (
          <PersonalPeriodPicker
            period={period}
            periodYear={periodYear}
            allPeriods={allPeriods}
            onChange={setPeriod}
          />
        )}
      </div>

      {isLoading ? (
        <div className="space-y-4 animate-pulse">
          {/* KPIs skeleton (mesma altura do real ~76px) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="h-[76px] rounded-lg border border-orange-200 bg-orange-50" />
            <div className="h-[76px] rounded-lg border border-amber-200 bg-amber-50" />
            <div className="h-[76px] rounded-lg border border-green-200 bg-green-50" />
          </div>
          {/* Search bar skeleton */}
          <div className="h-[34px] rounded-lg bg-gray-100" />
          {/* Tabela skeleton */}
          <div className="h-[60vh] min-h-[400px] rounded-lg border border-gray-200 bg-white" />
        </div>
      ) : (
        <>
        {!(isPersonal && eixo === 'caixa') && (
          <BulkDateToolbar
            selectMode={bulkSelectMode}
            onEnter={() => setBulkSelectMode(true)}
            onExit={exitBulkMode}
            selectedCount={bulkSelectedIds.size}
            allSelected={bulkAllSelected}
            onToggleAll={() => setBulkSelectedIds(bulkAllSelected ? new Set() : new Set(bulkVisibleIds))}
            bulkDate={bulkDate}
            onBulkDateChange={setBulkDate}
            onApply={applyBulkDate}
            onMarkPaid={applyBulkPaid}
          />
        )}
        <BulkDateProvider value={{ selectMode: bulkSelectMode && !(isPersonal && eixo === 'caixa'), selectedIds: bulkSelectedIds, toggle: toggleBulkId }}>
        {isPersonal && eixo === 'caixa' ? (
          <ContaRealView
            months={contaRealMonthsToShow}
            upcomingMonths={contaRealUpcomingMonths}
            tipoLabel={tipoLabel}
            cardInfoByLast4={cardInfoByLast4}
            openEdit={openEdit}
            onDelete={(id) => deleteMutation.mutate(id)}
            onToggleStatus={handleToggleStatus}
          />
        ) : viewMode === 'general' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-darc-velvet/50">
                Extrato por data
              </span>
              <button
                type="button"
                onClick={() => setGeneralSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                title={generalSortDir === 'desc' ? 'Mais recentes primeiro (clique para inverter)' : 'Mais antigos primeiro (clique para inverter)'}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                {generalSortDir === 'desc' ? (
                  <><ArrowDownWideNarrow className="w-3.5 h-3.5" /> Mais recentes</>
                ) : (
                  <><ArrowUpNarrowWide className="w-3.5 h-3.5" /> Mais antigos</>
                )}
              </button>
            </div>
            <MonthlyExpenseView
              grouped={groupedGeneral}
              collapsedMonths={collapsedMonths}
              toggleMonth={(key) => {
                setCollapsedMonths((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              }}
              tipoLabel={tipoLabel}
              tipoOptions={TIPO_DESPESA_OPTIONS}
              openEdit={openEdit}
              onDelete={(id) => deleteMutation.mutate(id)}
              onToggleStatus={handleToggleStatus}
              onToggleParcela={handleToggleParcela}
              onChangeTipo={(id, tipoDespesa) => changeTipoMutation.mutate({ id, tipoDespesa })}
              onQuickUpdate={(id, valor, data) => {
                const exp = expenses.find((x) => x.id === id);
                const qty = exp?.quantidade ?? 1;
                quickUpdateMutation.mutate({ id, valorTotal: valor, dataPagamento: data, quantidade: qty });
              }}
              onQuickCreate={(d) => {
                createMutation.mutate({
                  tipoDespesa: d.tipoDespesa,
                  valor: d.valor,
                  quantidade: 1,
                  formaPagamento: 'A_VISTA',
                  dataPagamento: d.dataPagamento,
                  status: d.status,
                } as ExpenseFormData);
              }}
              emptyMsg="Nenhuma despesa no período."
            />
          </div>
        ) : projectType === 'PESSOAL' ? (
          <UnifiedExpenseView
            mode={viewMode}
            expenses={displayPersonal}
            remoteMap={remoteProjectMap}
            selfProjectId={PROJECT_ID}
            selfProjectName={project?.name ?? 'Pessoal'}
            tipoLabel={tipoLabel}
            openEdit={openEdit}
            onDelete={(id) => deleteMutation.mutate(id)}
            onToggleStatus={handleToggleStatus}
          />
        ) : viewMode === 'month' ? (
          <MonthlyExpenseView
            grouped={groupedByMes}
            collapsedMonths={collapsedMonths}
            toggleMonth={(key) => {
              setCollapsedMonths((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              });
            }}
            tipoLabel={tipoLabel}
            tipoOptions={TIPO_DESPESA_OPTIONS}
            openEdit={openEdit}
            onDelete={(id) => deleteMutation.mutate(id)}
            onToggleStatus={handleToggleStatus}
            onToggleParcela={handleToggleParcela}
            onChangeTipo={(id, tipoDespesa) => changeTipoMutation.mutate({ id, tipoDespesa })}
            onQuickUpdate={(id, valor, data) => {
              const exp = expenses.find((x) => x.id === id);
              const qty = exp?.quantidade ?? 1;
              quickUpdateMutation.mutate({ id, valorTotal: valor, dataPagamento: data, quantidade: qty });
            }}
            onQuickCreate={(d) => {
              createMutation.mutate({
                tipoDespesa: d.tipoDespesa,
                valor: d.valor,
                quantidade: 1,
                formaPagamento: 'A_VISTA',
                dataPagamento: d.dataPagamento,
                status: d.status,
              } as ExpenseFormData);
            }}
            emptyMsg="Nenhuma despesa cadastrada."
          />
        ) : (
        <CategoryExpenseView
          categorias={categorias}
          collapsedCategories={collapsedCategories}
          toggleCategory={toggleCategory}
          tipoLabel={tipoLabel}
          openEdit={openEdit}
          onDelete={(id) => deleteMutation.mutate(id)}
          onToggleStatus={handleToggleStatus}
          onQuickUpdate={(id, valor, data) => {
            const exp = expenses.find((x) => x.id === id);
            const qty = exp?.quantidade ?? 1;
            quickUpdateMutation.mutate({ id, valorTotal: valor, dataPagamento: data, quantidade: qty });
          }}
          onQuickCreate={(d) => {
            createMutation.mutate({
              tipoDespesa: d.tipoDespesa,
              valor: d.valor,
              quantidade: 1,
              formaPagamento: 'A_VISTA',
              dataPagamento: d.dataPagamento,
              status: d.status,
            } as ExpenseFormData);
          }}
          emptyMsg="Nenhuma despesa cadastrada."
        />
      )}
        </BulkDateProvider>

      {/* Botão para adicionar linha rápida (desktop apenas) — não aparece em REFORMA/category pois cada card de categoria tem seu próprio "+ Adicionar despesa rápida em <categoria>" */}
      {!showNewRow && !editingInlineId && !(projectType !== 'PESSOAL' && viewMode === 'category') && !(isPersonal && eixo === 'caixa') && (
        <button onClick={() => { closeInlineEdit(); setShowNewRow(true); }}
          className="hidden md:block w-full border-2 border-dashed border-gray-200 rounded-lg py-2 text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors">
          + Adicionar rápido (linha inline)
        </button>
      )}

      {/* Card de criação rápida — usado nas visões sem a tabela inline (Mês / Pessoal) */}
      {showNewRow && !(projectType !== 'PESSOAL' && viewMode === 'category') && (
        <QuickAddCard
          newRow={newRow}
          setNewRow={setNewRow}
          tipoDespesaOptions={TIPO_DESPESA_OPTIONS}
          showRooms={showRooms}
          roomOptions={roomOptions}
          onSubmit={handleInlineSubmit}
          onCancel={() => setShowNewRow(false)}
          inlineKeyDown={inlineKeyDown}
        />
      )}

      </>
      )}

      </>
      )}

      {/* FAB mobile — abre opções de adição. À ESQUERDA para não colidir com o
          Copiloto (canto inferior direito). Sobe acima da pílula no PESSOAL. */}
      {activeTab === 'despesas' && (
        <button
          type="button"
          onClick={openPayOptions}
          aria-label="Nova despesa"
          className={`md:hidden fixed left-4 z-30 h-14 w-14 rounded-full bg-orange-500 text-white shadow-darc-hero flex items-center justify-center active:scale-95 transition-transform ${isPersonal ? 'bottom-24' : 'bottom-20'}`}
        >
          <Plus className="w-6 h-6" />
        </button>
      )}

      <VoiceExpenseModal
        open={voiceModalOpen}
        onClose={closeVoiceModal}
        voiceSupported={voiceSupported}
        voiceListening={voiceListening}
        voiceTranscript={voiceTranscript}
        voiceError={voiceError}
        voiceData={voiceData}
        setVoiceData={setVoiceData}
        voiceFornecedor={voiceFornecedor}
        setVoiceFornecedor={setVoiceFornecedor}
        voiceLinkedExpenseId={voiceLinkedExpenseId}
        setVoiceLinkedExpenseId={setVoiceLinkedExpenseId}
        voiceLinkedProject={voiceLinkedProject}
        startVoiceCapture={startVoiceCapture}
        clearVoiceTranscript={clearVoiceTranscript}
        saveVoiceExpense={saveVoiceExpense}
        saveDisabled={!voiceData?.valor || createMutation.isPending}
        tipoDespesaOptions={TIPO_DESPESA_OPTIONS}
        cards={tenantCards}
        accounts={tenantAccounts}
        currentProjectId={PROJECT_ID}
      />

      {/* Pay Options Modal */}
      <PayOptionsModal
        open={payModalOpen}
        onClose={() => setPayModalOpen(false)}
        onOpenNewPaidForm={() => {
          setPayModalOpen(false);
          setEditing(null);
          setWizardMode('PAGA');
          setWizardOpen(true);
        }}
        onOpenPlanForm={() => {
          setPayModalOpen(false);
          setEditing(null);
          setWizardMode('PLANEJAR');
          setWizardOpen(true);
        }}
        onOpenRecorrenteForm={isPersonal ? () => {
          setPayModalOpen(false);
          setRecorrenteOpen(true);
        } : undefined}
        onOpenVoiceModal={() => {
          setPayModalOpen(false);
          openVoiceModal();
        }}
        importSlot={
          <ImportLauncher
            projectId={PROJECT_ID}
            onImported={() => {
              setPayModalOpen(false);
              queryClient.invalidateQueries({ queryKey: ['expenses', PROJECT_ID] });
              queryClient.invalidateQueries({ queryKey: ['cash-flow', PROJECT_ID] });
            }}
          />
        }
      />

      <NovaDespesaWizard
        open={wizardOpen}
        mode={wizardMode}
        projectId={PROJECT_ID}
        projectType={projectType}
        allowRecorrente={false}
        tipoOptions={formTipoOptions}
        roomOptions={formRoomOptions}
        showRooms={formShowRooms}
        plannedExpenses={plannedExpenses}
        onPay={(id) => payMutation.mutate(id)}
        payDisabled={payMutation.isPending}
        onClose={() => setWizardOpen(false)}
        onCreated={() => invalidate()}
      />

      <RecorrenteWizard
        open={recorrenteOpen}
        projectId={PROJECT_ID}
        tipoOptions={formTipoOptions}
        onClose={() => setRecorrenteOpen(false)}
        onCreated={() => invalidate()}
      />

      {/* Expense Form Modal */}
      <ExpenseFormModal
        open={formModalOpen}
        onClose={closeFormModal}
        onSubmit={handleSubmit}
        editing={editing}
        formStatus={formStatus}
        allowRecorrente={isPersonal}
        tipoDespesa={tipoDespesa}
        setTipoDespesa={setTipoDespesa}
        formaPagamento={formaPagamento}
        setFormaPagamento={setFormaPagamento}
        valor={valor}
        setValor={setValor}
        quantidade={quantidade}
        setQuantidade={setQuantidade}
        valorTotal={valorTotal}
        titulo={formTitulo}
        setTitulo={setFormTitulo}
        fornecedor={formFornecedor}
        setFornecedor={setFormFornecedor}
        categoriaMaoDeObra={formCategoriaMaoDeObra}
        setCategoriaMaoDeObra={setFormCategoriaMaoDeObra}
        dataPagamento={formDataPagamento}
        setDataPagamento={setFormDataPagamento}
        dataInicioParcela={formDataInicioParcela}
        setDataInicioParcela={setFormDataInicioParcela}
        formVinculos={formVinculos}
        setFormVinculos={setFormVinculos}
        onLinkSelected={handleLinkSelected}
        projectId={editingProjectId}
        showRooms={formShowRooms}
        tipoDespesaOptions={formTipoOptions}
        roomOptions={formRoomOptions}
        isPending={createMutation.isPending || updateMutation.isPending}
        linkedExpenseDraft={{
          titulo: formTitulo,
          fornecedor: formFornecedor,
          tipoDespesa,
          categoriaMaoDeObra: formCategoriaMaoDeObra,
          valor,
          quantidade,
          formaPagamento,
          status: formStatus,
        }}
        onRatear={
          editingProjectType === 'PESSOAL' && editing
            ? () => {
                setRatearSource(editing);
                closeFormModal();
              }
            : undefined
        }
      />

      {ratearSource && (
        <RatearCompraModal
          open={!!ratearSource}
          onClose={() => setRatearSource(null)}
          source={ratearSource}
          ownerProjectId={resolveOwnerProjectId(ratearSource.id)}
          isPending={ratearMutation.isPending || desratearMutation.isPending}
          onSubmit={(allocations) =>
            ratearMutation.mutate(
              { sourceId: ratearSource.id, allocations },
              { onSuccess: () => setRatearSource(null) },
            )
          }
          onDesratear={() =>
            desratearMutation.mutate(
              { sourceId: ratearSource.id },
              { onSuccess: () => setRatearSource(null) },
            )
          }
        />
      )}
      {quitarTarget && (
        <QuitarParcelaModal
          projectId={PROJECT_ID}
          foreignExpenseId={quitarTarget.foreignExpenseId}
          parcelaIndex={quitarTarget.parcelaIndex}
          valorSugerido={quitarTarget.valorSugerido}
          descricao={quitarTarget.descricao}
          dataSugerida={quitarTarget.dataSugerida}
          onClose={() => setQuitarTarget(null)}
          onDone={() => {
            setQuitarTarget(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}
