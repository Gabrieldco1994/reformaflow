'use client';
import { useProject } from '@/contexts/project-context';

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { Plus, CreditCard, Pencil, Trash2, Check, X, ChevronDown, ChevronRight, Filter, Search, ExternalLink, ShoppingCart, ImageOff, GripVertical, BarChart3, Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import type { Expense, ExpenseFormData, ExpensesPage, Project } from '@/types';
import { toast } from 'sonner';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import {
  ExpenseType,
  ExpenseTypeLabels,
  ExpenseStatus,
  PaymentForm,
  type ProjectType as PType,
  getExpenseTypesForProject,
  buildInstallments,
} from '@reformaflow/domain';
import { CATEGORIA_MAO_DE_OBRA_OPTIONS, FORMA_PAGAMENTO_OPTIONS, tipoLabel, formaLabel, catMaoLabel } from '@/lib/expense-options';
import {
  type InlineNewRow,
  type LinkPreview,
  type PriceResult,
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
import { StatusBadge } from './_components/StatusBadge';
import { CompráveisView } from './_components/CompraveisView';
import { OtherProjectsExpensesView } from './_components/OtherProjectsExpensesView';
import { VinculosFields } from './_components/VinculosFields';
import { MobileExpenseList } from './_components/MobileExpenseList';
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
          <div className="flex flex-wrap gap-2">
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
        <div className="hidden md:block border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="text-left px-2 py-2 font-medium text-gray-600">Título</th>
                  <th className="text-left px-2 py-2 font-medium text-gray-600">Fornecedor</th>
                  {showRooms && <th className="text-left px-2 py-2 font-medium text-gray-600">Ambiente</th>}
                  <th className="text-right px-2 py-2 font-medium text-gray-600">Valor Unit.</th>
                  <th className="text-right px-2 py-2 font-medium text-gray-600">Qtd</th>
                  <th className="text-right px-2 py-2 font-medium text-gray-600">Valor Total</th>
                  <th className="text-center px-2 py-2 font-medium text-gray-600 min-w-[200px]">Pagamento</th>
                  <th className="text-right px-2 py-2 font-medium text-gray-600">Ações</th>
                </tr>
              </thead>
              <tbody>
                {categorias.map((cat) => {
                  const isCatCollapsed = collapsedCategories.has(cat.tipo);
                  return (
                    <React.Fragment key={cat.tipo}>
                      {/* Category header row */}
                      <tr
                        className="bg-darc-pink-logo/60 border-y border-darc-pink-logo cursor-pointer hover:bg-darc-pink-logo"
                        onClick={() => toggleCategory(cat.tipo)}
                      >
                        <td className="px-2 py-2 text-center text-darc-raspberry">
                          {isCatCollapsed ? <ChevronRight className="w-3.5 h-3.5 inline" /> : <ChevronDown className="w-3.5 h-3.5 inline" />}
                        </td>
                        <td colSpan={showRooms ? 3 : 2} className="px-2 py-2 font-bold uppercase tracking-wider text-darc-velvet text-xs">
                          {cat.label}
                          <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-darc-raspberry/70">({cat.expenses.length} itens)</span>
                        </td>
                        <td colSpan={2} className="px-2 py-2 text-right text-[10px] text-darc-raspberry">
                          <span className="inline-flex items-center gap-2">
                            {cat.totalPlanejado > 0 && (
                              <span className="bg-darc-sunfire/20 text-darc-raspberry px-1.5 py-0.5 rounded">Plan: {formatCurrency(cat.totalPlanejado / 100)}</span>
                            )}
                            {cat.totalPago > 0 && (
                              <span className="bg-darc-mist/30 text-darc-velvet px-1.5 py-0.5 rounded">Pago: {formatCurrency(cat.totalPago / 100)}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right font-bold text-darc-velvet text-xs tabular-nums">
                          {formatCurrency(cat.total / 100)}
                        </td>
                        <td colSpan={2} />
                      </tr>

                      {/* Expense rows within category */}
                      {!isCatCollapsed && cat.expenses.map((exp) => {
                        const hasDetail = (exp.formaPagamento === 'PARCELADO' || exp.formaPagamento === 'QUINZENAL') && (exp.quantidadeParcela ?? 0) > 1;
                        const isExpanded = expandedExpenses.has(exp.id);

                        return (
                          <React.Fragment key={exp.id}>
                            <tr className="hover:bg-gray-50 border-b border-gray-100">
                              <td className="px-2 py-1.5 text-center">
                                {hasDetail ? (
                                  <button onClick={() => toggleExpand(exp.id)} className="text-gray-400 hover:text-gray-600">
                                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                  </button>
                                ) : null}
                              </td>
                              <td className="px-2 py-1.5 font-medium text-gray-800">
                                {exp.titulo || tipoLabel(exp.tipoDespesa)}
                                {exp.tipoDespesa === 'MAO_DE_OBRA' && exp.categoriaMaoDeObra && (
                                  <span className="ml-1.5 text-[10px] text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">{catMaoLabel(exp.categoriaMaoDeObra)}</span>
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-gray-600 max-w-[120px]" title={exp.fornecedor || ''}>
                                <div className="truncate">{exp.fornecedor || '—'}</div>
                                {(exp.cardLast4 || exp.bankLast4) && (
                                  <div className="text-[10px] text-gray-500 mt-0.5">
                                    {exp.cardLast4 ? `💳 ••${exp.cardLast4}` : `🏦 ••${exp.bankLast4}`}
                                  </div>
                                )}
                              </td>
                              {showRooms && (
                                <td className="px-2 py-1.5 text-gray-600 max-w-[110px] truncate" title={exp.room?.name || ''}>{exp.room?.name || '—'}</td>
                              )}
                              <td className="px-2 py-1.5 text-right text-gray-600 tabular-nums">{formatCurrency(exp.valor / 100)}</td>
                              <td className="px-2 py-1.5 text-right text-gray-600 tabular-nums">{exp.quantidade}</td>
                              <td className="px-2 py-1.5 text-right font-medium text-gray-800 tabular-nums">{formatCurrency(exp.valorTotal / 100)}</td>
                              <td className="px-3 py-1.5 text-center align-middle">
                                <div className="flex flex-col items-center gap-0.5 leading-tight">
                                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                                    <span className="text-gray-600">{formaLabel(exp.formaPagamento)}</span>
                                    {(exp.quantidadeParcela ?? 0) > 1 && (
                                      <span className="text-[11px] font-bold text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded">{exp.quantidadeParcela}×</span>
                                    )}
                                    <StatusBadge status={exp.status} />
                                  </span>
                                  {(exp.dataInicioParcela || exp.dataPagamento) && (
                                    <span className="text-[11px] text-gray-400 tabular-nums">
                                      {exp.dataInicioParcela
                                        ? `1ª ${formatDateBR(exp.dataInicioParcela)}`
                                        : formatDateBR(exp.dataPagamento!)}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-right">
                                <span className="inline-flex gap-0.5">
                                  <button onClick={() => openInlineEdit(exp)} className="p-1 rounded hover:bg-blue-100" title="Editar rápido">
                                    <Pencil className="w-3.5 h-3.5 text-gray-500" />
                                  </button>
                                  <button onClick={() => openEdit(exp)} className="p-1 rounded hover:bg-gray-200" title="Editar completo">
                                    <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
                                  </button>
                                  <button onClick={() => deleteMutation.mutate(exp.id)} className="p-1 rounded hover:bg-red-100" title="Excluir">
                                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                  </button>
                                </span>
                              </td>
                            </tr>

                            {editingInlineId === exp.id && (
                              <>
                                <tr className="bg-blue-50/40 border-b border-blue-100">
                                  <td className="px-2 py-2 text-center">
                                    <Pencil className="w-3.5 h-3.5 text-blue-500 inline" />
                                  </td>
                                  <td className="px-3 py-2" colSpan={2}>
                                    <div className="flex gap-2">
                                      <select value={editingInlineRow.tipoDespesa} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, tipoDespesa: e.target.value })}
                                        onKeyDown={inlineEditKeyDown}
                                        className="border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                                        {TIPO_DESPESA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                      </select>
                                      <input type="text" placeholder="Título" value={editingInlineRow.titulo}
                                        onChange={(e) => setEditingInlineRow({ ...editingInlineRow, titulo: e.target.value })} onKeyDown={inlineEditKeyDown}
                                        className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <input type="text" placeholder="Fornecedor" value={editingInlineRow.fornecedor}
                                      onChange={(e) => setEditingInlineRow({ ...editingInlineRow, fornecedor: e.target.value })} onKeyDown={inlineEditKeyDown}
                                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                                  </td>
                                  <td className="px-3 py-2">
                                    <input type="number" step="0.01" placeholder="Valor" value={editingInlineRow.valor}
                                      onChange={(e) => setEditingInlineRow({ ...editingInlineRow, valor: e.target.value })} onKeyDown={inlineEditKeyDown}
                                      className="w-20 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                                  </td>
                                  <td className="px-3 py-2">
                                    <input type="number" min="1" value={editingInlineRow.quantidade}
                                      onChange={(e) => setEditingInlineRow({ ...editingInlineRow, quantidade: e.target.value })} onKeyDown={inlineEditKeyDown}
                                      className="w-14 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                                  </td>
                                  <td className="px-3 py-2 text-right text-xs text-gray-500 font-medium">
                                    {formatCurrency((parseFloat(editingInlineRow.valor) || 0) * (parseInt(editingInlineRow.quantidade) || 1))}
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="flex gap-1">
                                      <select value={editingInlineRow.formaPagamento} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, formaPagamento: e.target.value })}
                                        onKeyDown={inlineEditKeyDown}
                                        className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                                        {FORMA_PAGAMENTO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                      </select>
                                      <select value={editingInlineRow.status} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, status: e.target.value })}
                                        onKeyDown={inlineEditKeyDown}
                                        className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                                        <option value="PLANEJADO">Plan.</option>
                                        <option value="PAGO">Pago</option>
                                      </select>
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <span className="inline-flex gap-0.5">
                                      <button onClick={handleInlineUpdateSubmit} className="p-1 rounded hover:bg-green-100" title="Salvar (Enter)">
                                        <Check className="w-3.5 h-3.5 text-green-600" />
                                      </button>
                                      <button onClick={closeInlineEdit} className="p-1 rounded hover:bg-gray-200" title="Cancelar (Esc)">
                                        <X className="w-3.5 h-3.5 text-gray-500" />
                                      </button>
                                    </span>
                                  </td>
                                </tr>
                                <tr className="bg-blue-50/20 border-b border-blue-100">
                                  <td />
                                  <td colSpan={COL_SPAN - 1} className="px-3 py-1.5">
                                    <div className="flex items-center gap-4 flex-wrap">
                                      {showRooms && (
                                        <div className="flex items-center gap-2">
                                          <span className="text-[10px] text-gray-500 font-medium">Ambiente:</span>
                                          <select value={editingInlineRow.roomId} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, roomId: e.target.value })}
                                            onKeyDown={inlineEditKeyDown}
                                            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                                            <option value="">-</option>
                                            {roomOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                          </select>
                                        </div>
                                      )}
                                      {editingInlineRow.tipoDespesa === 'MAO_DE_OBRA' && (
                                        <div className="flex items-center gap-2">
                                          <span className="text-[10px] text-gray-500 font-medium">Cat. Mão de Obra:</span>
                                          <select value={editingInlineRow.categoriaMaoDeObra}
                                            onChange={(e) => setEditingInlineRow({ ...editingInlineRow, categoriaMaoDeObra: e.target.value })}
                                            onKeyDown={inlineEditKeyDown}
                                            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                                            <option value="">Selecione...</option>
                                            {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                          </select>
                                        </div>
                                      )}
                                      {editingInlineRow.formaPagamento === 'A_VISTA' && (
                                        <div className="flex items-center gap-2">
                                          <span className="text-[10px] text-gray-500 font-medium">Data Pagto:</span>
                                          <input type="date" value={editingInlineRow.dataPagamento}
                                            onChange={(e) => setEditingInlineRow({ ...editingInlineRow, dataPagamento: e.target.value })} onKeyDown={inlineEditKeyDown}
                                            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                                        </div>
                                      )}
                                      {(editingInlineRow.formaPagamento === 'PARCELADO' || editingInlineRow.formaPagamento === 'QUINZENAL') && (
                                        <>
                                          <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 font-medium">
                                              {editingInlineRow.formaPagamento === 'PARCELADO' ? 'Parcelas:' : 'Quinzenas:'}
                                            </span>
                                            <input type="number" min="1" placeholder="1" value={editingInlineRow.quantidadeParcela}
                                              onChange={(e) => setEditingInlineRow({ ...editingInlineRow, quantidadeParcela: e.target.value })} onKeyDown={inlineEditKeyDown}
                                              className="w-14 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-gray-500 font-medium">Início:</span>
                                            <input type="date" value={editingInlineRow.dataInicioParcela}
                                              onChange={(e) => setEditingInlineRow({ ...editingInlineRow, dataInicioParcela: e.target.value })} onKeyDown={inlineEditKeyDown}
                                              className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              </>
                            )}

                            {/* Parcela detail rows */}
                            {isExpanded && hasDetail && buildInstallments({
                              valorTotal: exp.valorTotal,
                              formaPagamento: exp.formaPagamento,
                              dataPagamento: exp.dataPagamento ? new Date(exp.dataPagamento) : null,
                              quantidadeParcela: exp.quantidadeParcela,
                              dataInicioParcela: exp.dataInicioParcela ? new Date(exp.dataInicioParcela) : null,
                            }).map((p) => (
                              <tr key={`${exp.id}-${p.parcela}`} className="bg-gray-50/50">
                                <td />
                                <td className="px-2 py-1 pl-8 text-gray-500">
                                  ↳ Parcela {p.parcela}
                                </td>
                                <td className="px-2 py-1 text-gray-400 tabular-nums">
                                  {formatDateBR(p.data.toISOString().slice(0, 10))}
                                </td>
                                <td />
                                <td />
                                <td />
                                <td className="px-2 py-1 text-right text-gray-500 tabular-nums">{formatCurrency(p.valor / 100)}</td>
                                <td colSpan={2} />
                              </tr>
                            ))}
                          </React.Fragment>
                        );
                      })}
                    </React.Fragment>
                  );
                })}

                {/* Inline new row */}
                {showNewRow && (
                  <>
                    <tr className="bg-blue-50/40 border-t-2 border-blue-200">
                      <td className="px-2 py-2 text-center">
                        <span className="text-blue-400 text-xs font-bold">+</span>
                      </td>
                      <td className="px-3 py-2" colSpan={2}>
                        <div className="flex gap-2">
                          <select value={newRow.tipoDespesa} onChange={(e) => setNewRow({ ...newRow, tipoDespesa: e.target.value })}
                            onKeyDown={inlineKeyDown}
                            className="border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300" autoFocus>
                            {TIPO_DESPESA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <input type="text" placeholder="Título" value={newRow.titulo}
                            onChange={(e) => setNewRow({ ...newRow, titulo: e.target.value })} onKeyDown={inlineKeyDown}
                            className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" placeholder="Fornecedor" value={newRow.fornecedor}
                          onChange={(e) => setNewRow({ ...newRow, fornecedor: e.target.value })} onKeyDown={inlineKeyDown}
                          className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" placeholder="Valor" value={newRow.valor}
                          onChange={(e) => setNewRow({ ...newRow, valor: e.target.value })} onKeyDown={inlineKeyDown}
                          className="w-20 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="number" min="1" value={newRow.quantidade}
                          onChange={(e) => setNewRow({ ...newRow, quantidade: e.target.value })} onKeyDown={inlineKeyDown}
                          className="w-14 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-gray-500 font-medium">
                        {formatCurrency((parseFloat(newRow.valor) || 0) * (parseInt(newRow.quantidade) || 1))}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          <select value={newRow.formaPagamento} onChange={(e) => setNewRow({ ...newRow, formaPagamento: e.target.value })}
                            onKeyDown={inlineKeyDown}
                            className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                            {FORMA_PAGAMENTO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <select value={newRow.status} onChange={(e) => setNewRow({ ...newRow, status: e.target.value })}
                            onKeyDown={inlineKeyDown}
                            className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                            <option value="PLANEJADO">Plan.</option>
                            <option value="PAGO">Pago</option>
                          </select>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="inline-flex gap-0.5">
                          <button onClick={handleInlineSubmit} className="p-1 rounded hover:bg-green-100" title="Salvar (Enter)">
                            <Check className="w-3.5 h-3.5 text-green-600" />
                          </button>
                          <button onClick={() => setShowNewRow(false)} className="p-1 rounded hover:bg-gray-200" title="Cancelar (Esc)">
                            <X className="w-3.5 h-3.5 text-gray-500" />
                          </button>
                        </span>
                      </td>
                    </tr>
                    {/* Conditional fields row */}
                    <tr className="bg-blue-50/20">
                      <td />
                      <td colSpan={COL_SPAN - 1} className="px-3 py-1.5">
                        <div className="flex items-center gap-4 flex-wrap">
                          {showRooms && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-gray-500 font-medium">Ambiente:</span>
                              <select value={newRow.roomId} onChange={(e) => setNewRow({ ...newRow, roomId: e.target.value })}
                                onKeyDown={inlineKeyDown}
                                className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                                <option value="">-</option>
                                {roomOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          )}
                          {newRow.tipoDespesa === 'MAO_DE_OBRA' && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-gray-500 font-medium">Cat. Mão de Obra:</span>
                              <select value={newRow.categoriaMaoDeObra}
                                onChange={(e) => setNewRow({ ...newRow, categoriaMaoDeObra: e.target.value })}
                                onKeyDown={inlineKeyDown}
                                className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                                <option value="">Selecione...</option>
                                {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          )}
                          {newRow.formaPagamento === 'A_VISTA' && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-gray-500 font-medium">Data Pagto:</span>
                              <input type="date" value={newRow.dataPagamento}
                                onChange={(e) => setNewRow({ ...newRow, dataPagamento: e.target.value })} onKeyDown={inlineKeyDown}
                                className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                            </div>
                          )}
                          {(newRow.formaPagamento === 'PARCELADO' || newRow.formaPagamento === 'QUINZENAL') && (
                            <>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-500 font-medium">
                                  {newRow.formaPagamento === 'PARCELADO' ? 'Parcelas:' : 'Quinzenas:'}
                                </span>
                                <input type="number" min="1" placeholder="1" value={newRow.quantidadeParcela}
                                  onChange={(e) => setNewRow({ ...newRow, quantidadeParcela: e.target.value })} onKeyDown={inlineKeyDown}
                                  className="w-14 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-gray-500 font-medium">Início:</span>
                                <input type="date" value={newRow.dataInicioParcela}
                                  onChange={(e) => setNewRow({ ...newRow, dataInicioParcela: e.target.value })} onKeyDown={inlineKeyDown}
                                  className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                              </div>
                              {newRow.quantidadeParcela && parseFloat(newRow.valor) > 0 && (
                                <span className="text-[10px] text-gray-400">
                                  = <span className="font-medium text-gray-600">
                                    {formatCurrency(((parseFloat(newRow.valor) || 0) * (parseInt(newRow.quantidade) || 1)) / (parseInt(newRow.quantidadeParcela) || 1))}
                                  </span> / {newRow.formaPagamento === 'PARCELADO' ? 'parcela' : 'quinzena'}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  </>
                )}

                {filteredExpenses.length === 0 && !showNewRow && (
                  <tr><td colSpan={COL_SPAN} className="px-4 py-8 text-center text-gray-400">
                    {hasActiveFilters ? 'Nenhuma despesa encontrada com os filtros aplicados.' : 'Nenhuma despesa cadastrada.'}
                  </td></tr>
                )}
              </tbody>
              <tfoot className="bg-gray-50 border-t">
                <tr className="font-semibold text-xs">
                  <td />
                  <td className="px-2 py-2 text-gray-700">Total</td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td className="px-2 py-2 text-right font-bold text-gray-800 tabular-nums">{formatCurrency(totalGeral / 100)}</td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
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
