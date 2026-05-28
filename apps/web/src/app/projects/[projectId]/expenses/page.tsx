'use client';
import { useProject } from '@/contexts/project-context';

import React, { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, CreditCard, ExternalLink, ShoppingCart, Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Expense, ExpenseFormData, ExpensesPage, Project } from '@/types';
import { toast } from 'sonner';

import { ExpenseType } from '@reformaflow/domain';
import { tipoLabel, formaLabel, catMaoLabel } from '@/lib/expense-options';
import {
  type InlineNewRow,
  makeEmptyNewRow,
  getExpenseOptions,
} from './_types';
import { useVoiceExpense } from './_hooks/useVoiceExpense';
import { useExpenseFilters } from './_hooks/useExpenseFilters';
import { ExpenseKpiCards } from './_components/ExpenseKpiCards';
import { ExpenseFiltersBar } from './_components/ExpenseFiltersBar';
import { VoiceExpenseModal } from './_components/VoiceExpenseModal';
import { ExpenseFormModal } from './_components/ExpenseFormModal';
import { PayOptionsModal } from './_components/PayOptionsModal';
import { ExpenseDesktopTable } from './_components/ExpenseDesktopTable';
import { CompráveisView } from './_components/CompraveisView';
import { OtherProjectsExpensesView } from './_components/OtherProjectsExpensesView';
import { MobileExpenseList } from './_components/MobileExpenseList';
import { MonthlyExpenseView } from './_components/MonthlyExpenseView';
import { PersonalHierarchicalView } from './_components/PersonalHierarchicalView';
import { ExpenseViewToggle, type ExpenseViewMode } from './_components/ExpenseViewToggle';
import { groupExpensesByMes, currentMonthKey } from './_lib/grouping-by-month';
import type { RemoteProjectMap } from './_lib/personal-hierarchy';
import ImportLauncher from './_components/ImportLauncher';

interface TenantProjectRef {
  id: string;
  name: string;
  type: string;
}

interface RecurringBillLite {
  valor: number;
  frequencia: string;
  status: string;
}

interface MaintenanceLogLite {
  custo?: number | null;
}

const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

export default function ExpensesPage() {
  const { projectId: PROJECT_ID, projectType } = useProject();
  const TIPO_DESPESA_OPTIONS = useMemo(() => getExpenseOptions(projectType), [projectType]);
  const showRooms = projectType === 'REFORMA';
  const showMaoDeObra = projectType === 'REFORMA';
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'despesas' | 'compraveis' | 'outros'>('despesas');
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [formStatus, setFormStatus] = useState<'PLANEJADO' | 'PAGO'>('PLANEJADO');
  const [tipoDespesa, setTipoDespesa] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('');
  const [valor, setValor] = useState('');
  const [quantidade, setQuantidade] = useState('1');

  // Estado do bloco "Vínculos" do modal de despesa
  const [formVinculos, setFormVinculos] = useState<{ creditCardId: string; bankAccountId: string; linkedExpenseId: string }>({
    creditCardId: '',
    bankAccountId: '',
    linkedExpenseId: '',
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
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = `expenses:viewMode:${PROJECT_ID}`;
    const saved = window.localStorage.getItem(key);
    if (saved === 'category' || saved === 'month') setViewMode(saved);
  }, [PROJECT_ID]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(`expenses:viewMode:${PROJECT_ID}`, viewMode);
  }, [viewMode, PROJECT_ID]);

  const { data: expensesPage, isLoading } = useQuery<ExpensesPage>({
    queryKey: ['expenses', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses?pageSize=500`),
  });
  const expenses = expensesPage?.items ?? [];

  const { data: project } = useQuery<Project>({
    queryKey: ['project', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}`),
  });

  const { data: tenantProjects = [] } = useQuery<TenantProjectRef[]>({
    queryKey: ['projects', 'tenant-index'],
    queryFn: () => api.get('/projects'),
    enabled: projectType === 'PESSOAL',
  });

  // Cross-project despesas (para resolver linkedExpenseId → projeto destino na visão "Por projeto")
  const { data: crossProjectExpenses = [] } = useQuery<
    Array<{ id: string; project?: { id: string; name: string; type: string } | null }>
  >({
    queryKey: ['cross-project-expenses', PROJECT_ID, 'view-projeto-light'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses/cross-project?limit=500`),
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


  const influenceProjects = useMemo(
    () => tenantProjects.filter((p) => p.id !== PROJECT_ID && (p.type === 'CASA' || p.type === 'CARRO' || p.type === 'REFORMA')),
    [tenantProjects, PROJECT_ID],
  );

  const { data: influenceSummary = [] } = useQuery<
    Array<{ id: string; name: string; type: string; estimatedMonthly: number; totalAccumulated: number; isOneTime: boolean }>
  >({
    queryKey: ['pessoal-influence', influenceProjects.map((p) => p.id).join(',')],
    enabled: projectType === 'PESSOAL' && influenceProjects.length > 0,
    queryFn: async () => {
      const monthlyFactor = (frequencia: string) => {
        switch (frequencia) {
          case 'ANUAL': return 1 / 12;
          case 'SEMESTRAL': return 1 / 6;
          case 'TRIMESTRAL': return 1 / 3;
          case 'BIMESTRAL': return 1 / 2;
          default: return 1;
        }
      };
      const rows = await Promise.all(
        influenceProjects.map(async (p) => {
          if (p.type === 'REFORMA') {
            const exps = await api
              .get<{ items: Array<{ valorTotal?: number | null }> }>(`/projects/${p.id}/expenses?pageSize=500`)
              .catch(() => ({ items: [] as Array<{ valorTotal?: number | null }> }));
            const totalAccumulated = (exps.items ?? []).reduce((sum, e) => sum + (e.valorTotal ?? 0), 0);
            return {
              id: p.id,
              name: p.name,
              type: p.type,
              estimatedMonthly: 0,
              totalAccumulated,
              isOneTime: true,
            };
          }
          const [bills, logs] = await Promise.all([
            api.get<RecurringBillLite[]>(`/projects/${p.id}/recurring-bills`).catch(() => []),
            api.get<MaintenanceLogLite[]>(`/projects/${p.id}/maintenance-logs`).catch(() => []),
          ]);
          const recurringMonthly = bills
            .filter((b) => b.status === 'ATIVO')
            .reduce((sum, b) => sum + Math.round((b.valor ?? 0) * monthlyFactor(b.frequencia ?? 'MENSAL')), 0);
          const maintenanceMonthly = Math.round(
            logs.reduce((sum, l) => sum + (l.custo ?? 0), 0) / 12,
          );
          return {
            id: p.id,
            name: p.name,
            type: p.type,
            estimatedMonthly: recurringMonthly + maintenanceMonthly,
            totalAccumulated: 0,
            isOneTime: false,
          };
        }),
      );
      return rows.sort((a, b) => (b.estimatedMonthly + b.totalAccumulated) - (a.estimatedMonthly + a.totalAccumulated));
    },
  });

  const { data: plannedExpenses = [] } = useQuery<Expense[]>({
    queryKey: ['expenses', PROJECT_ID, 'planned'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses/planned`),
    enabled: payModalOpen,
  });

  const roomOptions = useMemo(() =>
    (project?.rooms ?? []).map((r) => ({ value: r.id, label: r.name })),
    [project]
  );

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
  } = useExpenseFilters(expenses, showRooms);

  // KPIs
  const totalGeral = filteredExpenses.reduce((s, e) => s + e.valorTotal, 0);
  const totalProjeto = expenses.reduce((s, e) => s + e.valorTotal, 0);
  const totalPlanejado = filteredExpenses.filter((e) => e.status === 'PLANEJADO').reduce((s, e) => s + e.valorTotal, 0);
  const totalPago = filteredExpenses.filter((e) => e.status === 'PAGO').reduce((s, e) => s + e.valorTotal, 0);

  // Visão mensal
  const groupedByMes = useMemo(() => groupExpensesByMes(filteredExpenses), [filteredExpenses]);
  useEffect(() => {
    const cur = currentMonthKey();
    setCollapsedMonths(new Set(groupedByMes.filter((g) => g.mesKey !== cur).map((g) => g.mesKey)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedByMes.length]);

  const influenceTotal = influenceSummary.reduce((sum, i) => sum + i.estimatedMonthly, 0);
  const influenceReformaTotal = influenceSummary
    .filter((i) => i.isOneTime)
    .reduce((sum, i) => sum + i.totalAccumulated, 0);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['expenses', PROJECT_ID] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', PROJECT_ID] });
    queryClient.invalidateQueries({ queryKey: ['cash-flow', PROJECT_ID] });
  };

  const createMutation = useMutation({
    mutationFn: (data: ExpenseFormData) => api.post(`/projects/${PROJECT_ID}/expenses`, data),
    onSuccess: () => { 
      toast.success('Despesa criada com sucesso');
      invalidate(); 
      closeFormModal(); 
      setShowNewRow(false); 
      setNewRow(makeEmptyNewRow(defaultExpenseType)); 
    },
    onError: (e: Error) => {
      console.error('[expenses] create failed', e);
      toast.error(`Erro ao criar despesa: ${e.message}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ExpenseFormData }) =>
      api.patch(`/projects/${PROJECT_ID}/expenses/${id}`, data),
    onSuccess: () => { 
      toast.success('Despesa atualizada com sucesso');
      invalidate(); 
      closeFormModal(); 
    },
    onError: (e: Error) => {
      console.error('[expenses] update failed', e);
      toast.error(`Erro ao salvar despesa: ${e.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${PROJECT_ID}/expenses/${id}`),
    onSuccess: () => {
      toast.success('Despesa excluída com sucesso');
      invalidate();
    },
    onError: (e: Error) => {
      console.error('[expenses] delete failed', e);
      toast.error(`Erro ao excluir despesa: ${e.message}`);
    },
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${PROJECT_ID}/expenses/${id}/pay`, {}),
    onSuccess: () => { 
      toast.success('Despesa marcada como paga');
      invalidate(); 
      setPayModalOpen(false); 
    },
    onError: (e: Error) => {
      console.error('[expenses] pay failed', e);
      toast.error(`Erro ao pagar despesa: ${e.message}`);
    },
  });

  // Toggle rápido de status (PAGO ↔ PLANEJADO)
  const toggleStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'PAGO' | 'PLANEJADO' }) =>
      api.patch(`/projects/${PROJECT_ID}/expenses/${id}`, { status }),
    onSuccess: invalidate,
    onError: (e: Error) => {
      console.error('[expenses] toggle status failed', e);
      toast.error(`Erro ao alterar status: ${e.message}`);
    },
  });

  // Edição rápida (valor + data)
  const quickUpdateMutation = useMutation({
    mutationFn: ({ id, valorTotal, dataPagamento, quantidade }: { id: string; valorTotal: number; dataPagamento: string; quantidade: number }) => {
      const valorUnit = quantidade > 0 ? valorTotal / quantidade : valorTotal;
      return api.patch(`/projects/${PROJECT_ID}/expenses/${id}`, {
        valor: valorUnit,
        dataPagamento,
      });
    },
    onSuccess: invalidate,
    onError: (e: Error) => {
      console.error('[expenses] quick update failed', e);
      toast.error(`Erro ao atualizar: ${e.message}`);
    },
  });

  function closeFormModal() {
    setFormModalOpen(false);
    setEditing(null);
    setTipoDespesa('');
    setFormaPagamento('');
    setValor('');
    setQuantidade('1');
  }

  function openPlanForm() {
    setFormStatus('PLANEJADO');
    setEditing(null);
    setTipoDespesa('');
    setFormaPagamento('');
    setValor('');
    setQuantidade('1');
    setFormVinculos({ creditCardId: '', bankAccountId: '', linkedExpenseId: '' });
    setFormModalOpen(true);
  }

  function openPayOptions() {
    setPayModalOpen(true);
  }

  function openNewPaidForm() {
    setPayModalOpen(false);
    setFormStatus('PAGO');
    setEditing(null);
    setTipoDespesa('');
    setFormaPagamento('');
    setValor('');
    setQuantidade('1');
    setFormVinculos({ creditCardId: '', bankAccountId: '', linkedExpenseId: '' });
    setFormModalOpen(true);
  }

  function openEdit(expense: Expense) {
    setShowNewRow(false);
    closeInlineEdit();
    setEditing(expense);
    setFormStatus(expense.status as 'PLANEJADO' | 'PAGO');
    setTipoDespesa(expense.tipoDespesa);
    setFormaPagamento(expense.formaPagamento);
    setValor(expense.valor ? (expense.valor / 100).toFixed(2) : '');
    setQuantidade(String(expense.quantidade ?? 1));
    setFormVinculos({
      creditCardId: '',
      bankAccountId: '',
      linkedExpenseId: expense.linkedExpenseId ?? '',
    });
    setFormModalOpen(true);
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
    if (fp === 'A_VISTA') {
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
      roomId: showRooms ? nullable('roomId') : null,
      valor: Number(form.get('valor')),
      quantidade: Number(form.get('quantidade')),
      titulo: nullable('titulo'),
      fornecedor: nullable('fornecedor'),
      link: nullable('link'),
      imageUrl: nullable('imageUrl'),
      formaPagamento: form.get('formaPagamento') as string,
      status: formStatus,
    };
    const fp = data.formaPagamento;
    if (fp === 'A_VISTA') {
      data.dataPagamento = nullable('dataPagamento');
      data.quantidadeParcela = null;
      data.dataInicioParcela = null;
    } else if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
      const q = Number(form.get('quantidadeParcela'));
      data.quantidadeParcela = q > 0 ? q : null;
      data.dataInicioParcela = nullable('dataInicioParcela');
      data.dataPagamento = null;
    }
    // Vínculos (cards/contas/cross-project) — '' equivale a null pro backend
    data.creditCardId = formVinculos.creditCardId || null;
    data.bankAccountId = formVinculos.bankAccountId || null;
    data.linkedExpenseId = formVinculos.linkedExpenseId || null;
    if (editing) {
      console.log('[expenses] PATCH', editing.id, data);
      updateMutation.mutate({ id: editing.id, data });
    } else {
      console.log('[expenses] POST', data);
      createMutation.mutate(data);
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
  const voice = useVoiceExpense({
    allowedExpenseTypes,
    defaultExpenseType,
    onCreate: (data, onSuccess) => createMutation.mutate(data, { onSuccess }),
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
    openVoiceModal,
    closeVoiceModal,
    clearVoiceTranscript,
    startVoiceCapture,
    saveVoiceExpense,
  } = voice;

  return (
    <div className="space-y-4">
      {/* Header with tabs */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">Despesas</h1>
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
            <button
              onClick={() => setActiveTab('outros')}
              className={`px-4 py-1.5 transition-colors font-medium border-l border-gray-200 flex items-center gap-1.5 ${activeTab === 'outros' ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            ><ExternalLink className="w-3.5 h-3.5" /> Outras despesas</button>
          </div>
        </div>
        {activeTab === 'despesas' && (
          <div className="flex flex-wrap gap-2 items-center">
            <ExpenseViewToggle value={viewMode} onChange={setViewMode} showProject={projectType === 'PESSOAL'} />
            <Button
              variant="secondary"
              onClick={openVoiceModal}
            >
              <Mic className="w-4 h-4" /> Lançar por voz
            </Button>
            <Button variant="secondary" onClick={openPlanForm}>
              <Plus className="w-4 h-4" /> Planejar
            </Button>
            <ImportLauncher
              projectId={PROJECT_ID}
              onImported={() => {
                queryClient.invalidateQueries({ queryKey: ['expenses', PROJECT_ID] });
                queryClient.invalidateQueries({ queryKey: ['cash-flow', PROJECT_ID] });
              }}
            />
            <Button onClick={openPayOptions}>
              <CreditCard className="w-4 h-4" /> Pagar
            </Button>
          </div>
        )}
      </div>

      {activeTab === 'compraveis' ? (
        <CompráveisView expenses={expenses} tipoLabel={tipoLabel} />
      ) : activeTab === 'outros' ? (
        <OtherProjectsExpensesView projectId={PROJECT_ID} localExpenses={expenses} />
      ) : (
      <>

      {/* KPI Cards */}
      <ExpenseKpiCards
        projectType={projectType}
        expensesCount={expenses.length}
        filteredCount={filteredExpenses.length}
        filteredPlanejadoCount={filteredExpenses.filter((e) => e.status === 'PLANEJADO').length}
        filteredPagoCount={filteredExpenses.filter((e) => e.status === 'PAGO').length}
        totalProjeto={totalProjeto}
        totalGeral={totalGeral}
        totalPlanejado={totalPlanejado}
        totalPago={totalPago}
        hasActiveFilters={hasActiveFilters}
        showInfluencePanel={projectType === 'PESSOAL' && influenceProjects.length > 0}
        influenceSummary={influenceSummary}
        influenceTotal={influenceTotal}
        influenceReformaTotal={influenceReformaTotal}
      />

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
      />

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
        {viewMode === 'project' && projectType === 'PESSOAL' ? (
          <PersonalHierarchicalView
            expenses={filteredExpenses}
            remoteMap={remoteProjectMap}
            selfProjectName={project?.name ?? 'Pessoal'}
            tipoLabel={tipoLabel}
            openEdit={openEdit}
            onDelete={(id) => deleteMutation.mutate(id)}
            onToggleStatus={(id, status) => toggleStatusMutation.mutate({ id, status })}
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
            onToggleStatus={(id, status) => toggleStatusMutation.mutate({ id, status })}
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
        <>
        <MobileExpenseList
          categorias={categorias}
          collapsedCategories={collapsedCategories}
          toggleCategory={toggleCategory}
          tipoLabel={tipoLabel}
          formaLabel={formaLabel}
          catMaoLabel={catMaoLabel}
          openEdit={openEdit}
          onDelete={(id) => deleteMutation.mutate(id)}
          totalGeral={totalGeral}
          hasActiveFilters={hasActiveFilters}
          emptyMsg="Nenhuma despesa cadastrada."
        />
        <ExpenseDesktopTable
          categorias={categorias}
          filteredExpenses={filteredExpenses}
          collapsedCategories={collapsedCategories}
          toggleCategory={toggleCategory}
          expandedExpenses={expandedExpenses}
          toggleExpand={toggleExpand}
          showRooms={showRooms}
          colSpan={COL_SPAN}
          totalGeral={totalGeral}
          hasActiveFilters={hasActiveFilters}
          openInlineEdit={openInlineEdit}
          openEdit={openEdit}
          onDelete={(id) => deleteMutation.mutate(id)}
          editingInlineId={editingInlineId}
          editingInlineRow={editingInlineRow}
          setEditingInlineRow={setEditingInlineRow}
          handleInlineUpdateSubmit={handleInlineUpdateSubmit}
          closeInlineEdit={closeInlineEdit}
          inlineEditKeyDown={inlineEditKeyDown}
          showNewRow={showNewRow}
          setShowNewRow={setShowNewRow}
          newRow={newRow}
          setNewRow={setNewRow}
          handleInlineSubmit={handleInlineSubmit}
          inlineKeyDown={inlineKeyDown}
          tipoDespesaOptions={TIPO_DESPESA_OPTIONS}
          roomOptions={roomOptions}
        />
        </>
      )}

      {/* Botão para adicionar linha rápida (desktop apenas) */}
      {!showNewRow && !editingInlineId && (
        <button onClick={() => { closeInlineEdit(); setShowNewRow(true); }}
          className="hidden md:block w-full border-2 border-dashed border-gray-200 rounded-lg py-2 text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors">
          + Adicionar rápido (linha inline)
        </button>
      )}

      </>
      )}

      </>
      )}

      {/* FAB mobile — abre opções de adição (Planejar / Pagar) */}
      {activeTab === 'despesas' && (
        <button
          type="button"
          onClick={openPayOptions}
          aria-label="Nova despesa"
          className="md:hidden fixed right-4 bottom-20 z-30 h-14 w-14 rounded-full bg-darc-red text-darc-linen shadow-darc-hero flex items-center justify-center active:scale-95 transition-transform"
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
        startVoiceCapture={startVoiceCapture}
        clearVoiceTranscript={clearVoiceTranscript}
        saveVoiceExpense={saveVoiceExpense}
        saveDisabled={!voiceData?.valor || createMutation.isPending}
        tipoDespesaOptions={TIPO_DESPESA_OPTIONS}
      />

      {/* Pay Options Modal */}
      <PayOptionsModal
        open={payModalOpen}
        onClose={() => setPayModalOpen(false)}
        onOpenNewPaidForm={openNewPaidForm}
        onOpenVoiceModal={() => {
          setPayModalOpen(false);
          openVoiceModal();
        }}
        plannedExpenses={plannedExpenses}
        onPay={(id) => payMutation.mutate(id)}
        payDisabled={payMutation.isPending}
      />

      {/* Expense Form Modal */}
      <ExpenseFormModal
        open={formModalOpen}
        onClose={closeFormModal}
        onSubmit={handleSubmit}
        editing={editing}
        formStatus={formStatus}
        tipoDespesa={tipoDespesa}
        setTipoDespesa={setTipoDespesa}
        formaPagamento={formaPagamento}
        setFormaPagamento={setFormaPagamento}
        valor={valor}
        setValor={setValor}
        quantidade={quantidade}
        setQuantidade={setQuantidade}
        valorTotal={valorTotal}
        formVinculos={formVinculos}
        setFormVinculos={setFormVinculos}
        projectId={PROJECT_ID}
        showRooms={showRooms}
        tipoDespesaOptions={TIPO_DESPESA_OPTIONS}
        roomOptions={roomOptions}
        isPending={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
}
