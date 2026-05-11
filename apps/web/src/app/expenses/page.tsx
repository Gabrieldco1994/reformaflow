'use client';

import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Plus, CreditCard, Pencil, Trash2, Check, X, ChevronDown, ChevronRight, Filter, Search, ExternalLink, ShoppingCart, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import type { Expense, ExpenseFormData, Project } from '@/types';

const PROJECT_ID = 'dev-project-1';

const TIPO_DESPESA_OPTIONS = [
  { value: 'MATERIAL_CONSTRUCAO', label: 'Material p/ Construção' },
  { value: 'ELETRODOMESTICO', label: 'Eletrodoméstico' },
  { value: 'REVESTIMENTO', label: 'Revestimento' },
  { value: 'ILUMINACAO', label: 'Iluminação' },
  { value: 'MARMORE', label: 'Mármore' },
  { value: 'VIDRACARIA_SERRALHERIA', label: 'Vidraçaria & Serralheria' },
  { value: 'METAL_CERAMICA', label: 'Metal & Cerâmica' },
  { value: 'MARCENARIA', label: 'Marcenaria' },
  { value: 'MAO_DE_OBRA', label: 'Mão de Obra' },
];

const CATEGORIA_MAO_DE_OBRA_OPTIONS = [
  { value: 'EMPREITEIRO', label: 'Empreiteiro' },
  { value: 'INSTALADOR_PISO', label: 'Instalador de Piso' },
  { value: 'INSTALADOR_MARMORE', label: 'Instalador de Mármore' },
  { value: 'PINTOR', label: 'Pintor' },
  { value: 'ELETRICISTA', label: 'Eletricista' },
  { value: 'VIDRACEIRO', label: 'Vidraceiro' },
  { value: 'SERRALHEIRO', label: 'Serralheiro' },
  { value: 'MARCENEIRO', label: 'Marceneiro' },
];

const FORMA_PAGAMENTO_OPTIONS = [
  { value: 'A_VISTA', label: 'À Vista' },
  { value: 'PARCELADO', label: 'Parcelado' },
  { value: 'QUINZENAL', label: 'Quinzenal' },
];

function StatusBadge({ status }: { status: string }) {
  const styles = status === 'PAGO'
    ? 'bg-green-100 text-green-800'
    : 'bg-amber-100 text-amber-800';
  const label = status === 'PAGO' ? 'Pago' : 'Planejado';
  return <span className={`${styles} px-2 py-0.5 rounded-full text-xs font-medium`}>{label}</span>;
}

interface InlineNewRow {
  tipoDespesa: string;
  categoriaMaoDeObra: string;
  roomId: string;
  valor: string;
  quantidade: string;
  titulo: string;
  fornecedor: string;
  formaPagamento: string;
  status: string;
  dataPagamento: string;
  quantidadeParcela: string;
  dataInicioParcela: string;
}

const emptyNewRow: InlineNewRow = {
  tipoDespesa: 'MATERIAL_CONSTRUCAO',
  categoriaMaoDeObra: '',
  roomId: '',
  valor: '',
  quantidade: '1',
  titulo: '',
  fornecedor: '',
  formaPagamento: 'A_VISTA',
  status: 'PLANEJADO',
  dataPagamento: '',
  quantidadeParcela: '',
  dataInicioParcela: '',
};

// ─── Compráveis View ─────────────────────────────────────────────
interface LinkPreview {
  url: string;
  ogImage: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  favicon: string | null;
}

function LinkPreviewCard({ expense, tipoLabel }: { expense: Expense; tipoLabel: (t: string) => string }) {
  const [imgError, setImgError] = useState(false);
  const { data: preview, isLoading } = useQuery<LinkPreview>({
    queryKey: ['link-preview', expense.link],
    queryFn: () => api.get(`/link-preview?url=${encodeURIComponent(expense.link!)}`),
    staleTime: 1000 * 60 * 60 * 24, // 24h cache
    retry: 1,
    enabled: !!expense.link,
  });

  const title = expense.titulo || preview?.ogTitle || 'Sem título';
  // Priority: manual imageUrl > auto-detected ogImage
  const imageSource = expense.imageUrl || (preview?.ogImage && !imgError ? preview.ogImage : null);
  const hasImage = !!imageSource && !imgError;
  let domain = '';
  try { domain = new URL(expense.link!).hostname.replace('www.', ''); } catch {}

  return (
    <div className="border rounded-xl overflow-hidden bg-white shadow-sm hover:shadow-md transition-all group flex flex-col">
      {/* Image area */}
      <div className="relative h-56 bg-gray-100 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 border-2 border-orange-300 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : hasImage ? (
          <img
            src={imageSource!}
            alt={title}
            className="w-full h-full object-contain p-2 group-hover:scale-105 transition-transform duration-300"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full bg-gradient-to-br from-gray-50 to-gray-200">
            {preview?.favicon ? (
              <img src={preview.favicon} alt="" className="w-12 h-12 rounded-lg shadow-sm mb-2" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            ) : (
              <ShoppingCart className="w-10 h-10 text-gray-300 mb-2" />
            )}
            <p className="text-xs text-gray-400 font-medium">{domain}</p>
          </div>
        )}
        {/* Status badge overlay */}
        <div className="absolute top-2 right-2">
          <StatusBadge status={expense.status} />
        </div>
        {/* Favicon on image */}
        {hasImage && preview?.favicon && (
          <div className="absolute bottom-2 left-2 w-6 h-6 rounded-md bg-white/90 p-0.5 shadow-sm backdrop-blur-sm">
            <img src={preview.favicon} alt="" className="w-full h-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-3 flex-1 flex flex-col gap-1.5">
        <h3 className="font-semibold text-sm text-gray-800 line-clamp-2 leading-snug">{title}</h3>
        {preview?.ogDescription && (
          <p className="text-[10px] text-gray-400 line-clamp-2">{preview.ogDescription}</p>
        )}

        <div className="flex flex-wrap gap-1 mt-1">
          <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{tipoLabel(expense.tipoDespesa)}</span>
          {expense.room?.name && (
            <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">{expense.room.name}</span>
          )}
        </div>

        {expense.fornecedor && (
          <p className="text-[10px] text-gray-500">🏪 {expense.fornecedor}</p>
        )}

        <div className="mt-auto pt-2 flex items-end justify-between border-t border-gray-100">
          <div>
            <p className="text-xs text-gray-400">Valor total</p>
            <p className="text-base font-bold text-gray-900">{formatCurrency(expense.valorTotal / 100)}</p>
            {expense.quantidade > 1 && (
              <p className="text-[10px] text-gray-400">{expense.quantidade}x {formatCurrency(expense.valor / 100)}</p>
            )}
          </div>
          <a
            href={expense.link!}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-orange-500 text-white text-xs font-medium rounded-lg hover:bg-orange-600 transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> Abrir
          </a>
        </div>
      </div>
    </div>
  );
}

function CompráveisView({ expenses, tipoLabel }: { expenses: Expense[]; tipoLabel: (t: string) => string }) {
  const [filterTipo, setFilterTipo] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [sortBy, setSortBy] = useState<'valor' | 'titulo'>('valor');

  const compraveis = useMemo(() => {
    let items = expenses.filter(
      (e) => e.link && e.tipoDespesa !== 'MATERIAL_CONSTRUCAO'
    );
    if (filterTipo) items = items.filter((e) => e.tipoDespesa === filterTipo);
    if (filterStatus) items = items.filter((e) => e.status === filterStatus);

    items.sort((a, b) => {
      if (sortBy === 'valor') return b.valorTotal - a.valorTotal;
      return (a.titulo ?? '').localeCompare(b.titulo ?? '');
    });

    return items;
  }, [expenses, filterTipo, filterStatus, sortBy]);

  const totalCompraveis = compraveis.reduce((s, e) => s + e.valorTotal, 0);

  // Available tipos (only those with links, excluding Material Construção)
  const availableTipos = useMemo(() => {
    const tipos = new Set(
      expenses
        .filter((e) => e.link && e.tipoDespesa !== 'MATERIAL_CONSTRUCAO')
        .map((e) => e.tipoDespesa)
    );
    return TIPO_DESPESA_OPTIONS.filter((o) => tipos.has(o.value));
  }, [expenses]);

  return (
    <div className="space-y-4">
      {/* Summary + Filters */}
      <div className="bg-gradient-to-r from-orange-50 to-amber-50 rounded-xl p-4 border border-orange-100">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-orange-500" />
              {compraveis.length} {compraveis.length === 1 ? 'item comprável' : 'itens compráveis'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">Total: <span className="font-bold text-orange-700">{formatCurrency(totalCompraveis / 100)}</span></p>
          </div>
          <div className="flex gap-2">
            <select
              value={filterTipo}
              onChange={(e) => setFilterTipo(e.target.value)}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="">Todos os tipos</option>
              {availableTipos.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="">Todos os status</option>
              <option value="PLANEJADO">Planejado</option>
              <option value="PAGO">Pago</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'valor' | 'titulo')}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="valor">Maior valor</option>
              <option value="titulo">A–Z</option>
            </select>
          </div>
        </div>
      </div>

      {/* Cards grouped by Room */}
      {compraveis.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <ShoppingCart className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum item comprável encontrado</p>
          <p className="text-xs mt-1">Despesas com link preenchido (exceto Material de Construção) aparecerão aqui</p>
        </div>
      ) : (
        <div className="space-y-6">
          {(() => {
            const grouped = new Map<string, Expense[]>();
            compraveis.forEach((e) => {
              const roomName = e.room?.name || 'Sem ambiente';
              if (!grouped.has(roomName)) grouped.set(roomName, []);
              grouped.get(roomName)!.push(e);
            });
            return Array.from(grouped.entries())
              .sort(([a], [b]) => a === 'Sem ambiente' ? 1 : b === 'Sem ambiente' ? -1 : a.localeCompare(b))
              .map(([roomName, items]) => (
                <div key={roomName}>
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-sm font-bold text-gray-700">🏠 {roomName}</h3>
                    <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{items.length} {items.length === 1 ? 'item' : 'itens'}</span>
                    <span className="text-[10px] text-gray-500 ml-auto font-medium">{formatCurrency(items.reduce((s, e) => s + e.valorTotal, 0) / 100)}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {items.map((expense) => (
                      <LinkPreviewCard key={expense.id} expense={expense} tipoLabel={tipoLabel} />
                    ))}
                  </div>
                </div>
              ));
          })()}
        </div>
      )}
    </div>
  );
}

export default function ExpensesPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'despesas' | 'compraveis'>('despesas');
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [formStatus, setFormStatus] = useState<'PLANEJADO' | 'PAGO'>('PLANEJADO');
  const [tipoDespesa, setTipoDespesa] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('');
  const [valor, setValor] = useState('');
  const [quantidade, setQuantidade] = useState('1');

  // Inline new row
  const [showNewRow, setShowNewRow] = useState(false);
  const [newRow, setNewRow] = useState<InlineNewRow>(emptyNewRow);

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

  const tipoLabel = (t: string) => TIPO_DESPESA_OPTIONS.find((o) => o.value === t)?.label ?? t;
  const formaLabel = (f: string) => FORMA_PAGAMENTO_OPTIONS.find((o) => o.value === f)?.label ?? f;
  const catMaoLabel = (c: string) => CATEGORIA_MAO_DE_OBRA_OPTIONS.find((o) => o.value === c)?.label ?? c;

  const { data: expenses = [], isLoading } = useQuery<Expense[]>({
    queryKey: ['expenses'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses`),
  });

  const { data: project } = useQuery<Project>({
    queryKey: ['project'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}`),
  });

  const { data: plannedExpenses = [] } = useQuery<Expense[]>({
    queryKey: ['expenses', 'planned'],
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
      if (filters.room) {
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
  }, [expenses, filters, searchText]);

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
  const totalPlanejado = filteredExpenses.filter((e) => e.status === 'PLANEJADO').reduce((s, e) => s + e.valorTotal, 0);
  const totalPago = filteredExpenses.filter((e) => e.status === 'PAGO').reduce((s, e) => s + e.valorTotal, 0);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['expenses'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['cash-flow'] });
  };

  const createMutation = useMutation({
    mutationFn: (data: ExpenseFormData) => api.post(`/projects/${PROJECT_ID}/expenses`, data),
    onSuccess: () => { invalidate(); closeFormModal(); setShowNewRow(false); setNewRow(emptyNewRow); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ExpenseFormData }) =>
      api.patch(`/projects/${PROJECT_ID}/expenses/${id}`, data),
    onSuccess: () => { invalidate(); closeFormModal(); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${PROJECT_ID}/expenses/${id}`),
    onSuccess: invalidate,
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${PROJECT_ID}/expenses/${id}/pay`, {}),
    onSuccess: () => { invalidate(); setPayModalOpen(false); },
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
    setFormModalOpen(true);
  }

  function openEdit(expense: Expense) {
    setEditing(expense);
    setFormStatus(expense.status as 'PLANEJADO' | 'PAGO');
    setTipoDespesa(expense.tipoDespesa);
    setFormaPagamento(expense.formaPagamento);
    setValor(expense.valor ? (expense.valor / 100).toFixed(2) : '');
    setQuantidade(String(expense.quantidade ?? 1));
    setFormModalOpen(true);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const data: ExpenseFormData = {
      tipoDespesa: form.get('tipoDespesa') as string,
      categoriaMaoDeObra: form.get('categoriaMaoDeObra') as string || undefined,
      roomId: form.get('roomId') as string || undefined,
      valor: Number(form.get('valor')),
      quantidade: Number(form.get('quantidade')),
      titulo: form.get('titulo') as string || undefined,
      fornecedor: form.get('fornecedor') as string || undefined,
      link: form.get('link') as string || undefined,
      imageUrl: form.get('imageUrl') as string || undefined,
      formaPagamento: form.get('formaPagamento') as string,
      status: formStatus,
    };
    const fp = data.formaPagamento;
    if (fp === 'A_VISTA') {
      data.dataPagamento = form.get('dataPagamento') as string || undefined;
    } else if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
      data.quantidadeParcela = Number(form.get('quantidadeParcela')) || undefined;
      data.dataInicioParcela = form.get('dataInicioParcela') as string || undefined;
    }
    if (editing) {
      updateMutation.mutate({ id: editing.id, data });
    } else {
      createMutation.mutate(data);
    }
  }

  // Inline new row
  function handleInlineSubmit() {
    if (!newRow.valor || !newRow.tipoDespesa) return;
    const fp = newRow.formaPagamento;
    const data: ExpenseFormData = {
      tipoDespesa: newRow.tipoDespesa,
      categoriaMaoDeObra: newRow.tipoDespesa === 'MAO_DE_OBRA' && newRow.categoriaMaoDeObra ? newRow.categoriaMaoDeObra : undefined,
      roomId: newRow.roomId || undefined,
      valor: parseFloat(newRow.valor),
      quantidade: parseInt(newRow.quantidade) || 1,
      titulo: newRow.titulo || undefined,
      fornecedor: newRow.fornecedor || undefined,
      formaPagamento: fp,
      status: newRow.status as 'PLANEJADO' | 'PAGO',
    };
    if (fp === 'A_VISTA') {
      data.dataPagamento = newRow.dataPagamento || new Date().toISOString().slice(0, 10);
    } else if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
      data.quantidadeParcela = parseInt(newRow.quantidadeParcela) || 1;
      data.dataInicioParcela = newRow.dataInicioParcela || undefined;
    }
    createMutation.mutate(data);
  }

  function inlineKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleInlineSubmit();
    else if (e.key === 'Escape') setShowNewRow(false);
  }

  const valorTotal = useMemo(() => {
    const v = parseFloat(valor) || 0;
    const q = parseInt(quantidade) || 1;
    return v * q;
  }, [valor, quantidade]);

  // (moved to top of component)

  // Helper: generate parcela breakdown for parcelado/quinzenal expenses
  function getParcelaBreakdown(exp: Expense): { parcela: string; valor: number; data: string }[] {
    const qtd = exp.quantidadeParcela || 1;
    const total = exp.valorTotal;
    const valorParcela = Math.floor(total / qtd);
    const resto = total - valorParcela * qtd;
    const inicio = exp.dataInicioParcela ? new Date(exp.dataInicioParcela) : new Date();
    const isQuinzenal = exp.formaPagamento === 'QUINZENAL';

    return Array.from({ length: qtd }, (_, i) => {
      const d = new Date(inicio);
      if (isQuinzenal) {
        d.setDate(d.getDate() + i * 15);
      } else {
        d.setMonth(d.getMonth() + i);
      }
      return {
        parcela: `${i + 1}/${qtd}`,
        valor: valorParcela + (i === qtd - 1 ? resto : 0),
        data: d.toISOString().slice(0, 10),
      };
    });
  }

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

  const COL_SPAN = 9;

  return (
    <div className="space-y-4">
      {/* Header with tabs */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Despesas</h1>
          <div className="inline-flex rounded-lg border border-gray-200 text-sm overflow-hidden ml-2">
            <button
              onClick={() => setActiveTab('despesas')}
              className={`px-4 py-1.5 transition-colors font-medium ${activeTab === 'despesas' ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >Despesas</button>
            <button
              onClick={() => setActiveTab('compraveis')}
              className={`px-4 py-1.5 transition-colors font-medium border-l border-gray-200 flex items-center gap-1.5 ${activeTab === 'compraveis' ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            ><ShoppingCart className="w-3.5 h-3.5" /> Compráveis</button>
          </div>
        </div>
        {activeTab === 'despesas' && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={openPlanForm}>
              <Plus className="w-4 h-4" /> Planejar
            </Button>
            <Button onClick={openPayOptions}>
              <CreditCard className="w-4 h-4" /> Pagar
            </Button>
          </div>
        )}
      </div>

      {activeTab === 'compraveis' ? (
        <CompráveisView expenses={expenses} tipoLabel={tipoLabel} />
      ) : (
      <>

      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 bg-orange-50 border-orange-200">
          <p className="text-xs font-medium text-orange-600">Total Despesas</p>
          <p className="text-lg font-bold text-orange-800 mt-0.5">{formatCurrency(totalGeral / 100)}</p>
          <p className="text-[10px] text-orange-500 mt-0.5">{filteredExpenses.length} itens</p>
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
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2 px-3 py-2 bg-gray-50 border rounded-lg">
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Tipo</label>
            <select value={filters.tipoDespesa} onChange={(e) => updateFilter('tipoDespesa', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
              <option value="">Todos</option>
              {TIPO_DESPESA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Ambiente</label>
            <input type="text" placeholder="Filtrar..." value={filters.room}
              onChange={(e) => updateFilter('room', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
          </div>
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
        <p className="text-gray-500">Carregando...</p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Título</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Fornecedor</th>
                  <th className="text-left px-3 py-2 font-medium text-gray-600">Ambiente</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-600">Valor Unit.</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-600">Qtd</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-600">Valor Total</th>
                  <th className="text-center px-3 py-2 font-medium text-gray-600">Pagamento</th>
                  <th className="text-right px-3 py-2 font-medium text-gray-600">Ações</th>
                </tr>
              </thead>
              <tbody>
                {categorias.map((cat) => {
                  const isCatCollapsed = collapsedCategories.has(cat.tipo);
                  return (
                    <React.Fragment key={cat.tipo}>
                      {/* Category header row */}
                      <tr
                        className="bg-orange-50/60 border-t border-b border-orange-200 cursor-pointer hover:bg-orange-50"
                        onClick={() => toggleCategory(cat.tipo)}
                      >
                        <td className="px-2 py-2 text-center text-orange-500">
                          {isCatCollapsed ? <ChevronRight className="w-3.5 h-3.5 inline" /> : <ChevronDown className="w-3.5 h-3.5 inline" />}
                        </td>
                        <td colSpan={3} className="px-3 py-2 font-semibold text-orange-800 text-xs">
                          {cat.label}
                          <span className="ml-2 text-[10px] font-normal text-orange-500">({cat.expenses.length} itens)</span>
                        </td>
                        <td colSpan={2} className="px-3 py-2 text-right text-[10px] text-orange-600">
                          <span className="inline-flex items-center gap-2">
                            {cat.totalPlanejado > 0 && (
                              <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Plan: {formatCurrency(cat.totalPlanejado / 100)}</span>
                            )}
                            {cat.totalPago > 0 && (
                              <span className="bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Pago: {formatCurrency(cat.totalPago / 100)}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-orange-800 text-xs">
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
                              <td className="px-3 py-1.5 font-medium text-gray-800">
                                {exp.titulo || tipoLabel(exp.tipoDespesa)}
                                {exp.tipoDespesa === 'MAO_DE_OBRA' && exp.categoriaMaoDeObra && (
                                  <span className="ml-1.5 text-[10px] text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">{catMaoLabel(exp.categoriaMaoDeObra)}</span>
                                )}
                                {hasDetail && (
                                  <span className="ml-1.5 text-[10px] text-gray-400">({exp.quantidadeParcela}x)</span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-gray-600">{exp.fornecedor || '—'}</td>
                              <td className="px-3 py-1.5 text-gray-600">{exp.room?.name || '—'}</td>
                              <td className="px-3 py-1.5 text-right text-gray-600">{formatCurrency(exp.valor / 100)}</td>
                              <td className="px-3 py-1.5 text-right text-gray-600">{exp.quantidade}</td>
                              <td className="px-3 py-1.5 text-right font-medium text-gray-800">{formatCurrency(exp.valorTotal / 100)}</td>
                              <td className="px-3 py-1.5 text-center">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="text-gray-600">{formaLabel(exp.formaPagamento)}</span>
                                  <StatusBadge status={exp.status} />
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right">
                                <span className="inline-flex gap-0.5">
                                  <button onClick={() => openEdit(exp)} className="p-1 rounded hover:bg-gray-200" title="Editar">
                                    <Pencil className="w-3.5 h-3.5 text-gray-500" />
                                  </button>
                                  <button onClick={() => deleteMutation.mutate(exp.id)} className="p-1 rounded hover:bg-red-100" title="Excluir">
                                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                                  </button>
                                </span>
                              </td>
                            </tr>

                            {/* Parcela detail rows */}
                            {isExpanded && hasDetail && getParcelaBreakdown(exp).map((p) => (
                              <tr key={`${exp.id}-${p.parcela}`} className="bg-gray-50/50">
                                <td />
                                <td className="px-3 py-1 pl-8 text-gray-500">
                                  ↳ Parcela {p.parcela}
                                </td>
                                <td className="px-3 py-1 text-gray-400">
                                  {new Date(p.data).toLocaleDateString('pt-BR')}
                                </td>
                                <td />
                                <td />
                                <td />
                                <td className="px-3 py-1 text-right text-gray-500">{formatCurrency(p.valor / 100)}</td>
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
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 font-medium">Ambiente:</span>
                            <select value={newRow.roomId} onChange={(e) => setNewRow({ ...newRow, roomId: e.target.value })}
                              onKeyDown={inlineKeyDown}
                              className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                              <option value="">-</option>
                              {roomOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
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
                  <td className="px-3 py-2 text-gray-700">Total</td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <td className="px-3 py-2 text-right font-bold text-gray-800">{formatCurrency(totalGeral / 100)}</td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Botão para adicionar linha rápida */}
      {!showNewRow && (
        <button onClick={() => setShowNewRow(true)}
          className="w-full border-2 border-dashed border-gray-200 rounded-lg py-2 text-sm text-gray-400 hover:border-blue-300 hover:text-blue-500 transition-colors">
          + Adicionar rápido (linha inline)
        </button>
      )}

      </>
      )}

      {/* Pay Options Modal */}
      <Modal open={payModalOpen} onClose={() => setPayModalOpen(false)} title="Pagar Despesa">
        <div className="space-y-4">
          <Button className="w-full" onClick={openNewPaidForm}>Nova Despesa (já paga)</Button>
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

          <Select
            label="Ambiente"
            name="roomId"
            options={roomOptions}
            defaultValue={editing?.roomId ?? ''}
          />

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
            type="url"
            defaultValue={editing?.link ?? ''}
          />
          <Input
            label="URL da Imagem (opcional)"
            name="imageUrl"
            type="url"
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
