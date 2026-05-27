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
import type { Expense, ExpenseFormData, Project } from '@/types';
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
  type ParsedVoiceExpense,
  parseVoiceExpense,
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

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

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

  // Filters
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    tipoDespesa: '',
    room: '',
    titulo: '',
    fornecedor: '',
    formaPagamento: '',
    status: '',
  });
  const updateFilter = (key: string, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const [searchText, setSearchText] = useState('');
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [voiceData, setVoiceData] = useState<ParsedVoiceExpense | null>(null);
  const [voiceFornecedor, setVoiceFornecedor] = useState('');
  const [speechApi, setSpeechApi] = useState<SpeechRecognitionCtor | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceFeatureEnabled = true;

  const { data: expenses = [], isLoading } = useQuery<Expense[]>({
    queryKey: ['expenses', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses`),
  });

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
              .get<Array<{ valorTotal?: number | null }>>(`/projects/${p.id}/expenses`)
              .catch(() => []);
            const totalAccumulated = exps.reduce((sum, e) => sum + (e.valorTotal ?? 0), 0);
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

  const filteredExpenses = useMemo(() => {
    return expenses.filter((exp) => {
      if (filters.tipoDespesa && exp.tipoDespesa !== filters.tipoDespesa) return false;
      if (showRooms && filters.room) {
        const roomName = exp.room?.name ?? '';
        if (!roomName.toLowerCase().includes(filters.room.toLowerCase())) return false;
      }
      if (filters.titulo) {
        if (!(exp.titulo ?? '').toLowerCase().includes(filters.titulo.toLowerCase())) return false;
      }
      if (filters.fornecedor) {
        if (!(exp.fornecedor ?? '').toLowerCase().includes(filters.fornecedor.toLowerCase())) return false;
      }
      if (filters.formaPagamento && exp.formaPagamento !== filters.formaPagamento) return false;
      if (filters.status && exp.status !== filters.status) return false;
      // Global search
      if (searchText) {
        const s = searchText.toLowerCase();
        const searchable = [
          exp.titulo, exp.fornecedor, exp.room?.name,
          tipoLabel(exp.tipoDespesa), formaLabel(exp.formaPagamento),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!searchable.includes(s)) return false;
      }
      return true;
    });
  }, [expenses, filters, searchText, showRooms]);

  const hasActiveFilters = Object.values(filters).some((v) => v !== '') || searchText !== '';

  // Group filtered expenses by tipoDespesa (category)
  const categorias = useMemo(() => {
    const catMap = new Map<string, Expense[]>();
    for (const exp of filteredExpenses) {
      const cat = exp.tipoDespesa;
      const arr = catMap.get(cat);
      if (arr) arr.push(exp);
      else catMap.set(cat, [exp]);
    }
    return Array.from(catMap.entries())
      .map(([cat, items]) => ({
        tipo: cat,
        label: tipoLabel(cat),
        expenses: items.sort((a, b) => b.valorTotal - a.valorTotal),
        totalPlanejado: items.filter((e) => e.status === 'PLANEJADO').reduce((s, e) => s + e.valorTotal, 0),
        totalPago: items.filter((e) => e.status === 'PAGO').reduce((s, e) => s + e.valorTotal, 0),
        total: items.reduce((s, e) => s + e.valorTotal, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [filteredExpenses]);

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

  useEffect(() => {
    if (!voiceFeatureEnabled) return;
    if (typeof window === 'undefined') return;
    const win = window as Window & {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
    // IMPORTANTE: React trata o argumento de useState como updater function quando é função.
    // Como SpeechRecognition é um construtor (function), precisamos wrappear em callback
    // para guardá-lo como valor, e não invocá-lo. Sem isso: TypeError "use 'new' operator".
    setSpeechApi(() => ctor);
    setVoiceSupported(Boolean(ctor));
  }, [voiceFeatureEnabled]);

  useEffect(() => {
    if (!voiceFeatureEnabled) return;
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // no-op: navegadores podem lançar se já estiver parado
      } finally {
        recognitionRef.current = null;
      }
    };
  }, [voiceFeatureEnabled]);

  const parseVoiceTranscript = useCallback((rawText: string): ParsedVoiceExpense => {
    return parseVoiceExpense({
      transcript: rawText,
      allowedExpenseTypes: TIPO_DESPESA_OPTIONS.map((o) => o.value as ExpenseType),
      defaultExpenseType,
    });
  }, [TIPO_DESPESA_OPTIONS, defaultExpenseType]);

  const startVoiceCapture = useCallback(() => {
    if (!speechApi) {
      setVoiceError('Seu navegador não suporta lançamento por voz.');
      return;
    }
    setVoiceError('');
    setVoiceTranscript('');
    setVoiceData(null);
    setVoiceFornecedor('');

    try {
      recognitionRef.current?.stop();
      const recognition = new speechApi();
      recognitionRef.current = recognition;
      recognition.lang = 'pt-BR';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => setVoiceListening(true);
      recognition.onend = () => setVoiceListening(false);
      recognition.onerror = (event) => {
        setVoiceListening(false);
        if (event.error === 'not-allowed') {
          setVoiceError('Microfone bloqueado. Libere a permissão para continuar.');
          return;
        }
        setVoiceError('Não consegui captar sua voz. Tente novamente.');
      };
      recognition.onresult = (event) => {
        const text = event.results[0]?.[0]?.transcript?.trim() ?? '';
        setVoiceTranscript(text);
        if (!text) {
          setVoiceError('Não consegui entender o áudio.');
          setVoiceData(null);
          return;
        }
        try {
          const parsed = parseVoiceTranscript(text);
          setVoiceData(parsed);
          setVoiceFornecedor('');
          if (!parsed.valor) {
            setVoiceError('Não consegui identificar o valor. Fale algo como "gastei 85 reais no mercado".');
          } else {
            setVoiceError('');
          }
        } catch {
          setVoiceData(null);
          setVoiceError('Ocorreu um erro ao interpretar o comando de voz.');
        }
      };
      recognition.start();
    } catch {
      setVoiceListening(false);
      setVoiceError('Falha ao iniciar o microfone neste dispositivo.');
    }
  }, [parseVoiceTranscript, speechApi]);

  function saveVoiceExpense() {
    if (!voiceData || !voiceData.valor) return;
    const data: ExpenseFormData = {
      tipoDespesa: voiceData.tipoDespesa,
      categoriaMaoDeObra: null,
      roomId: null,
      valor: voiceData.valor,
      quantidade: 1,
      titulo: voiceData.titulo || null,
      fornecedor: voiceFornecedor || null,
      formaPagamento: voiceData.formaPagamento,
      status: voiceData.status as 'PLANEJADO' | 'PAGO',
      dataPagamento: null,
      quantidadeParcela: null,
      dataInicioParcela: null,
    };
    if (voiceData.formaPagamento === PaymentForm.A_VISTA) {
      data.dataPagamento = voiceData.dataReferencia || toIsoDate(new Date());
    } else {
      data.quantidadeParcela = voiceData.quantidadeParcela || 1;
      data.dataInicioParcela = voiceData.dataReferencia || toIsoDate(new Date());
    }

    createMutation.mutate(data, {
      onSuccess: () => {
        setVoiceModalOpen(false);
        setVoiceTranscript('');
        setVoiceData(null);
        setVoiceFornecedor('');
        setVoiceError('');
      },
    });
  }

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
            {voiceFeatureEnabled && (
              <Button
                variant="secondary"
                onClick={() => {
                  setVoiceModalOpen(true);
                  setVoiceError('');
                  setVoiceTranscript('');
                  setVoiceData(null);
                  setVoiceFornecedor('');
                }}
              >
                <Mic className="w-4 h-4" /> Lançar por voz
              </Button>
            )}
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 bg-orange-50 border-orange-200">
          <p className="text-xs font-medium text-orange-600">{projectType === 'REFORMA' ? 'Total da Reforma' : 'Total Despesas'}</p>
          <p className="text-lg font-bold text-orange-800 mt-0.5">
            {formatCurrency((projectType === 'REFORMA' ? totalProjeto : totalGeral) / 100)}
          </p>
          <p className="text-[10px] text-orange-500 mt-0.5">
            {projectType === 'REFORMA'
              ? `${expenses.length} itens no projeto`
              : `${filteredExpenses.length} itens`}
          </p>
          {projectType === 'REFORMA' && hasActiveFilters && (
            <p className="text-[10px] text-orange-500/80 mt-0.5">
              Filtros exibindo {formatCurrency(totalGeral / 100)} ({filteredExpenses.length} itens)
            </p>
          )}
        </div>
        <div className="rounded-lg border p-3 bg-amber-50 border-amber-200">
          <p className="text-xs font-medium text-amber-600">Planejado</p>
          <p className="text-lg font-bold text-amber-800 mt-0.5">{formatCurrency(totalPlanejado / 100)}</p>
          <p className="text-[10px] text-amber-500 mt-0.5">{filteredExpenses.filter((e) => e.status === 'PLANEJADO').length} itens</p>
        </div>
        <div className="rounded-lg border p-3 bg-green-50 border-green-200">
          <p className="text-xs font-medium text-green-600">Pago</p>
          <p className="text-lg font-bold text-green-800 mt-0.5">{formatCurrency(totalPago / 100)}</p>
          <p className="text-[10px] text-green-500 mt-0.5">{filteredExpenses.filter((e) => e.status === 'PAGO').length} itens</p>
        </div>
      </div>

      {projectType === 'PESSOAL' && influenceProjects.length > 0 && (
        <section className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-indigo-700">Influência de Reforma / Casa / Carro no Pessoal</p>
              <p className="text-[11px] text-indigo-600">
                CASA/CARRO consolidam mensalmente contas recorrentes e manutenção. REFORMA mostra o total acumulado das despesas.
              </p>
            </div>
            <div className="text-right space-y-0.5">
              {influenceTotal > 0 && (
                <p className="text-sm font-bold text-indigo-800 tabular-nums">
                  {formatCurrency(influenceTotal / 100)}/mês
                </p>
              )}
              {influenceReformaTotal > 0 && (
                <p className="text-[11px] font-semibold text-indigo-700 tabular-nums">
                  + {formatCurrency(influenceReformaTotal / 100)} reforma (total)
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {influenceSummary.map((p) => (
              <div key={p.id} className="rounded-md border border-indigo-100 bg-white px-3 py-2 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-800">{p.name}</p>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">{p.type}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-indigo-800 tabular-nums">
                    {formatCurrency((p.isOneTime ? p.totalAccumulated : p.estimatedMonthly) / 100)}
                  </p>
                  <p className="text-[10px] text-indigo-500">{p.isOneTime ? 'total' : '/mês'}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Search + Filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Buscar despesas..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg transition-colors ${
            showFilters || hasActiveFilters
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'border-gray-200 text-gray-600 hover:bg-gray-50'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filtros
          {hasActiveFilters && (
            <span className="ml-1 bg-blue-600 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center">
              {Object.values(filters).filter((v) => v !== '').length}
            </span>
          )}
        </button>
        {hasActiveFilters && (
          <button
            onClick={() => { setFilters({ tipoDespesa: '', room: '', titulo: '', fornecedor: '', formaPagamento: '', status: '' }); setSearchText(''); }}
            className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1.5"
          >
            Limpar
          </button>
        )}
      </div>

      {/* Expandable Filters */}
      {showFilters && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 px-3 py-2 bg-gray-50 border rounded-lg">
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Tipo</label>
            <select value={filters.tipoDespesa} onChange={(e) => updateFilter('tipoDespesa', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
              <option value="">Todos</option>
              {TIPO_DESPESA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {showRooms && (
            <div>
              <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Ambiente</label>
              <input type="text" placeholder="Filtrar..." value={filters.room}
                onChange={(e) => updateFilter('room', e.target.value)}
                className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
            </div>
          )}
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Título</label>
            <input type="text" placeholder="Filtrar..." value={filters.titulo}
              onChange={(e) => updateFilter('titulo', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Fornecedor</label>
            <input type="text" placeholder="Filtrar..." value={filters.fornecedor}
              onChange={(e) => updateFilter('fornecedor', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Pagamento</label>
            <select value={filters.formaPagamento} onChange={(e) => updateFilter('formaPagamento', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
              <option value="">Todos</option>
              {FORMA_PAGAMENTO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Status</label>
            <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
              <option value="">Todos</option>
              <option value="PLANEJADO">Planejado</option>
              <option value="PAGO">Pago</option>
            </select>
          </div>
        </div>
      )}

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

      {voiceFeatureEnabled && (
      <Modal
        open={voiceModalOpen}
        onClose={() => {
          try {
            recognitionRef.current?.stop();
          } catch {
            // no-op
          }
          setVoiceModalOpen(false);
          setVoiceListening(false);
          setVoiceFornecedor('');
        }}
        title="Lançar despesa por voz"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Fale uma frase como: <span className="font-medium">&quot;Gastei 85 reais no mercado no cartão hoje&quot;</span>.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={startVoiceCapture}
              disabled={!voiceSupported || voiceListening}
            >
              <Mic className="w-4 h-4" /> {voiceListening ? 'Ouvindo...' : 'Capturar voz'}
            </Button>
            {voiceTranscript && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setVoiceTranscript('');
                  setVoiceData(null);
                  setVoiceFornecedor('');
                  setVoiceError('');
                }}
              >
                Limpar
              </Button>
            )}
          </div>

          {!voiceSupported && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Seu navegador não suporta reconhecimento de voz. Use o lançamento manual.
            </p>
          )}

          {voiceTranscript && (
            <div className="rounded border bg-gray-50 px-3 py-2">
              <p className="text-xs text-gray-500 mb-1">Transcrição</p>
              <p className="text-sm text-gray-800">{voiceTranscript}</p>
            </div>
          )}

          {voiceError && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {voiceError}
            </p>
          )}

          {voiceData && (
            <div className="space-y-3 rounded border p-3">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Revisar antes de salvar</p>
              <Select
                label="Tipo da Despesa"
                name="voiceTipoDespesa"
                options={TIPO_DESPESA_OPTIONS}
                value={voiceData.tipoDespesa}
                onChange={(e) => setVoiceData({ ...voiceData, tipoDespesa: e.target.value as ExpenseType })}
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Valor (R$)"
                  name="voiceValor"
                  type="number"
                  step="0.01"
                  min="0"
                  value={voiceData.valor ? String(voiceData.valor) : ''}
                  onChange={(e) =>
                    setVoiceData({
                      ...voiceData,
                      valor: e.target.value ? Number.parseFloat(e.target.value) : null,
                    })
                  }
                />
                <Select
                  label="Forma de Pagamento"
                  name="voiceFormaPagamento"
                  options={FORMA_PAGAMENTO_OPTIONS}
                  value={voiceData.formaPagamento}
                  onChange={(e) =>
                    setVoiceData({
                      ...voiceData,
                      formaPagamento: e.target.value as PaymentForm,
                      quantidadeParcela:
                        e.target.value === PaymentForm.A_VISTA ? null : (voiceData.quantidadeParcela ?? 1),
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Status"
                  name="voiceStatus"
                  options={[
                    { value: 'PLANEJADO', label: 'Planejado' },
                    { value: 'PAGO', label: 'Pago' },
                  ]}
                  value={voiceData.status}
                  onChange={(e) =>
                    setVoiceData({ ...voiceData, status: e.target.value as ExpenseStatus })
                  }
                />
                {voiceData.formaPagamento === PaymentForm.A_VISTA ? (
                  <Input
                    label="Data do Pagamento"
                    name="voiceDataPagamento"
                    type="date"
                    value={voiceData.dataReferencia}
                    onChange={(e) => setVoiceData({ ...voiceData, dataReferencia: e.target.value })}
                  />
                ) : (
                  <Input
                    label="Qtd Parcelas"
                    name="voiceQuantidadeParcela"
                    type="number"
                    min="1"
                    value={String(voiceData.quantidadeParcela ?? 1)}
                    onChange={(e) =>
                      setVoiceData({
                        ...voiceData,
                        quantidadeParcela: Math.max(1, Number.parseInt(e.target.value || '1', 10)),
                      })
                    }
                  />
                )}
              </div>
              {voiceData.formaPagamento !== PaymentForm.A_VISTA && (
                <Input
                  label="Data de Início"
                  name="voiceDataInicioParcela"
                  type="date"
                  value={voiceData.dataReferencia}
                  onChange={(e) => setVoiceData({ ...voiceData, dataReferencia: e.target.value })}
                />
              )}
              <Input
                label="Título"
                name="voiceTitulo"
                value={voiceData.titulo}
                onChange={(e) => setVoiceData({ ...voiceData, titulo: e.target.value })}
              />
              <Input
                label="Fornecedor"
                name="voiceFornecedor"
                value={voiceFornecedor}
                onChange={(e) => setVoiceFornecedor(e.target.value)}
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setVoiceModalOpen(false);
                setVoiceFornecedor('');
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={saveVoiceExpense}
              disabled={!voiceData?.valor || createMutation.isPending}
            >
              Salvar despesa
            </Button>
          </div>
        </div>
      </Modal>
      )}

      {/* Pay Options Modal */}
      <Modal open={payModalOpen} onClose={() => setPayModalOpen(false)} title="Pagar Despesa">
        <div className="space-y-4">
          <Button className="w-full" onClick={openNewPaidForm}>Nova Despesa (já paga)</Button>
          {voiceFeatureEnabled && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                setPayModalOpen(false);
                setVoiceModalOpen(true);
                setVoiceError('');
                setVoiceTranscript('');
                setVoiceData(null);
                setVoiceFornecedor('');
              }}
            >
              <Mic className="w-4 h-4" /> Lançar por voz
            </Button>
          )}
          <div className="border-t pt-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Pagar Despesa Planejada:</p>
            {plannedExpenses.length === 0 ? (
              <p className="text-sm text-gray-400">Nenhuma despesa planejada encontrada.</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {plannedExpenses.map((exp) => (
                  <button
                    key={exp.id}
                    onClick={() => payMutation.mutate(exp.id)}
                    className="w-full text-left p-3 border rounded-lg hover:bg-green-50 hover:border-green-300 transition-colors"
                    disabled={payMutation.isPending}
                  >
                    <div className="flex justify-between">
                      <span className="font-medium text-sm">{tipoLabel(exp.tipoDespesa)}</span>
                      <span className="text-sm font-medium">{formatCurrency(exp.valorTotal / 100)}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{exp.fornecedor ?? ''} {exp.room?.name ? `· ${exp.room.name}` : ''}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Expense Form Modal */}
      <Modal open={formModalOpen} onClose={closeFormModal} title={editing ? 'Editar Despesa' : formStatus === 'PLANEJADO' ? 'Planejar Despesa' : 'Nova Despesa (Paga)'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Select
            label="Tipo da Despesa"
            name="tipoDespesa"
            options={TIPO_DESPESA_OPTIONS}
            required
            value={tipoDespesa}
            onChange={(e) => setTipoDespesa(e.target.value)}
          />

          {tipoDespesa === 'MAO_DE_OBRA' && (
            <Select
              label="Categoria Mão de Obra"
              name="categoriaMaoDeObra"
              options={CATEGORIA_MAO_DE_OBRA_OPTIONS}
              defaultValue={editing?.categoriaMaoDeObra ?? ''}
            />
          )}

          {showRooms && (
            <Select
              label="Ambiente"
              name="roomId"
              options={roomOptions}
              defaultValue={editing?.roomId ?? ''}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Valor (R$)"
              name="valor"
              type="number"
              step="0.01"
              min="0"
              required
              value={valor}
              onChange={(e) => setValor(e.target.value)}
            />
            <Input
              label="Quantidade"
              name="quantidade"
              type="number"
              min="1"
              required
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
            />
          </div>

          <div className="text-sm text-gray-600">
            Valor Total: <span className="font-semibold">{formatCurrency(valorTotal)}</span>
          </div>

          <Input
            label="Título da Despesa"
            name="titulo"
            defaultValue={editing?.titulo ?? ''}
          />
          <Input
            label="Fornecedor"
            name="fornecedor"
            defaultValue={editing?.fornecedor ?? ''}
          />
          <Input
            label="Link"
            name="link"
            type="text"
            defaultValue={editing?.link ?? ''}
          />
          <Input
            label="URL da Imagem (opcional)"
            name="imageUrl"
            type="text"
            placeholder="Cole a URL direta da imagem do produto"
            defaultValue={editing?.imageUrl ?? ''}
          />

          <Select
            label="Forma de Pagamento"
            name="formaPagamento"
            options={FORMA_PAGAMENTO_OPTIONS}
            required
            value={formaPagamento}
            onChange={(e) => setFormaPagamento(e.target.value)}
          />

          {formaPagamento === 'A_VISTA' && (
            <Input
              label="Data do Pagamento"
              name="dataPagamento"
              type="date"
              defaultValue={editing?.dataPagamento?.slice(0, 10) ?? ''}
            />
          )}

          {(formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL') && (
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Qtd Parcelas"
                name="quantidadeParcela"
                type="number"
                min="1"
                defaultValue={editing?.quantidadeParcela ?? ''}
              />
              <Input
                label="Data de Início"
                name="dataInicioParcela"
                type="date"
                defaultValue={editing?.dataInicioParcela?.slice(0, 10) ?? ''}
              />
            </div>
          )}

          <VinculosFields
            projectId={PROJECT_ID}
            value={formVinculos}
            onChange={setFormVinculos}
            initialCardLast4={editing?.cardLast4 ?? null}
            initialBankLast4={editing?.bankLast4 ?? null}
            initialLinkedExpenseId={editing?.linkedExpenseId ?? null}
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={closeFormModal}>Cancelar</Button>
            <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
              {editing ? 'Salvar' : 'Criar'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
