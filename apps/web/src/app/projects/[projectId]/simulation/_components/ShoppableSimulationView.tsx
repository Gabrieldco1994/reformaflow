'use client';

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ExternalLink, ShoppingCart, GripVertical, Plus } from 'lucide-react';
import { ExpenseTypeLabels } from '@reformaflow/domain';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { CashFlowEntry, Expense } from '@/types';
import { TIPO_DESPESA_OPTIONS, tipoLabel } from '@/lib/expense-options';
import type { PayConfig } from '../_types';

interface LinkPreview {
  ogTitle?: string;
  ogImage?: string;
  ogDescription?: string;
  favicon?: string;
}

interface SimShoppableItem {
  id: string;
  titulo: string;
  tipoDespesa: string;
  ambiente: string;
  valorReal: number;
  valorProj: number;
  link: string;
  imageUrl?: string;
  fornecedor?: string;
  isExtra: boolean;
  isExcluded: boolean;
}

const EXCLUDED_TIPOS = new Set(['MATERIAL_CONSTRUCAO', 'MAO_DE_OBRA']);
const EXCLUDED_LABELS = new Set(['Material p/ Construção', 'Mão de Obra']);

function normalizeTipo(s?: string | null): string {
  if (!s) return '';
  if (EXCLUDED_TIPOS.has(s)) return s;
  for (const [enumVal, label] of Object.entries(ExpenseTypeLabels)) {
    if (label === s) return enumVal;
  }
  return s;
}

/* ─────────── Card ─────────── */

function SimLinkPreviewCard({ item }: { item: SimShoppableItem }) {
  const [imgError, setImgError] = useState(false);
  const { data: preview, isLoading } = useQuery<LinkPreview>({
    queryKey: ['link-preview', item.link],
    queryFn: () => api.get(`/link-preview?url=${encodeURIComponent(item.link)}`),
    staleTime: 1000 * 60 * 60 * 24,
    retry: 1,
    enabled: !!item.link,
  });

  const title = item.titulo || preview?.ogTitle || 'Sem título';
  const imageSource = item.imageUrl || (preview?.ogImage && !imgError ? preview.ogImage : null);
  const hasImage = !!imageSource && !imgError;
  let domain = '';
  try { domain = new URL(item.link).hostname.replace('www.', ''); } catch { /* ignore */ }
  const diff = item.valorProj - item.valorReal;

  return (
    <div className={`border rounded-xl overflow-hidden bg-white shadow-sm hover:shadow-md transition-all group flex flex-col ${item.isExcluded ? 'opacity-50' : ''}`}>
      {/* Image area */}
      <div className="relative h-32 sm:h-56 bg-gray-100 overflow-hidden">
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
        {item.isExtra && (
          <span className="absolute top-2 right-2 text-[9px] font-semibold bg-purple-600 text-white px-1.5 py-0.5 rounded">SIMULADO</span>
        )}
        {hasImage && preview?.favicon && (
          <div className="absolute bottom-2 left-2 w-6 h-6 rounded-md bg-white/90 p-0.5 shadow-sm backdrop-blur-sm">
            <img src={preview.favicon} alt="" className="w-full h-full object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-2 sm:p-3 flex-1 flex flex-col gap-1 sm:gap-1.5">
        <h3 className="font-semibold text-[11px] sm:text-sm text-gray-800 line-clamp-2 leading-snug">{title}</h3>
        {preview?.ogDescription && (
          <p className="hidden sm:block text-[10px] text-gray-400 line-clamp-2">{preview.ogDescription}</p>
        )}
        <div className="flex flex-wrap gap-1 mt-0.5 sm:mt-1">
          <span className="text-[9px] sm:text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{tipoLabel(item.tipoDespesa)}</span>
          {item.ambiente && (
            <span className="hidden sm:inline text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">{item.ambiente}</span>
          )}
        </div>
        {item.fornecedor && (
          <p className="hidden sm:block text-[10px] text-gray-500">🏪 {item.fornecedor}</p>
        )}
        <div className="mt-auto pt-1.5 sm:pt-2 flex items-end justify-between border-t border-gray-100">
          <div className="min-w-0">
            <p className="hidden sm:block text-xs text-gray-400">Projetado</p>
            <p className="text-sm sm:text-base font-bold text-purple-700 truncate">{formatCurrency(item.valorProj / 100)}</p>
            {!item.isExtra && item.valorReal > 0 && item.valorReal !== item.valorProj && (
              <p className="hidden sm:block text-[10px] text-gray-400">
                Real: {formatCurrency(item.valorReal / 100)}
                {diff !== 0 && (
                  <span className={`ml-1 ${diff > 0 ? 'text-red-500' : 'text-green-600'}`}>
                    ({diff > 0 ? '+' : ''}{formatCurrency(diff / 100)})
                  </span>
                )}
              </p>
            )}
          </div>
          <div className="flex gap-1 sm:gap-1.5 shrink-0">
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 bg-orange-500 text-white text-xs font-medium rounded-lg hover:bg-orange-600 transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> <span className="hidden sm:inline">Abrir</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function SortableSimCard({ item }: { item: SimShoppableItem }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative">
      <div
        {...attributes}
        {...listeners}
        className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 z-10 p-0.5 sm:p-1 rounded-md bg-white/80 backdrop-blur-sm shadow-sm cursor-grab active:cursor-grabbing hover:bg-white transition-colors"
      >
        <GripVertical className="w-3 h-3 sm:w-4 sm:h-4 text-gray-400" />
      </div>
      <SimLinkPreviewCard item={item} />
    </div>
  );
}

/* ─────────── View principal ─────────── */

export function ShoppableSimulationView({
  payConfigs,
  excludes,
  onPayConfigChange,
  scenarioId,
}: {
  payConfigs: Record<string, PayConfig>;
  excludes: Set<string>;
  onPayConfigChange: (id: string, cfg: PayConfig) => void;
  scenarioId?: string;
}) {
  const { projectId: PROJECT_ID } = useProject();

  const { data: cfEntries = [] } = useQuery<CashFlowEntry[]>({
    queryKey: ['cash-flow', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
  });

  const { data: expenses = [] } = useQuery<Expense[]>({
    queryKey: ['expenses', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses`),
  });

  const expenseById = useMemo(() => {
    const m = new Map<string, Expense>();
    for (const e of expenses) m.set(e.id, e);
    return m;
  }, [expenses]);

  const [filterTipo, setFilterTipo] = useState('');
  const [sortBy, setSortBy] = useState<'valor' | 'titulo' | 'custom'>('custom');
  const [cardOrder, setCardOrder] = useState<Record<string, string[]>>({});
  const [colsPerRow, setColsPerRow] = useState<3 | 4>(3);

  const storageKeyOrder = `compraveis-sim-order-${scenarioId || 'default'}`;
  const storageKeyCols = `compraveis-sim-cols-${scenarioId || 'default'}`;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKeyOrder);
      if (saved) setCardOrder(JSON.parse(saved));
      const savedCols = localStorage.getItem(storageKeyCols);
      if (savedCols === '4' || savedCols === '3') setColsPerRow(Number(savedCols) as 3 | 4);
    } catch { /* ignore */ }
  }, [storageKeyOrder, storageKeyCols]);

  const changeCols = useCallback((n: 3 | 4) => {
    setColsPerRow(n);
    try { localStorage.setItem(storageKeyCols, String(n)); } catch { /* ignore */ }
  }, [storageKeyCols]);

  const saveOrder = useCallback((order: Record<string, string[]>) => {
    setCardOrder(order);
    try { localStorage.setItem(storageKeyOrder, JSON.stringify(order)); } catch { /* ignore */ }
  }, [storageKeyOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /* Build items */
  const allItems = useMemo<SimShoppableItem[]>(() => {
    const out: SimShoppableItem[] = [];
    const seen = new Set<string>();

    // Itens reais: agrupados por expenseId
    const byExpense = new Map<string, CashFlowEntry[]>();
    for (const e of cfEntries.filter((e) => e.tipo === 'DESPESA')) {
      if (!e.expenseId) continue;
      const existing = byExpense.get(e.expenseId);
      if (existing) existing.push(e);
      else byExpense.set(e.expenseId, [e]);
    }
    for (const [expenseId, entries] of byExpense) {
      const exp = expenseById.get(expenseId);
      const cfg = payConfigs[expenseId];
      const first = entries[0];
      // Filtro: precisa ter link + ambiente, excluir MAO_DE_OBRA / MATERIAL_CONSTRUCAO
      const link = cfg?.link || exp?.link;
      const ambiente = cfg?.ambiente || first.ambiente || exp?.room?.name;
      if (!link || !ambiente) continue;
      const tipo = normalizeTipo(exp?.tipoDespesa || cfg?.categoria || first.categoria);
      if (EXCLUDED_TIPOS.has(tipo) || EXCLUDED_LABELS.has(tipo)) continue;
      const totalReal = entries.reduce((s, x) => s + x.valor, 0);
      const projValor = cfg?.valor ? Math.round(parseFloat(cfg.valor) * 100) : totalReal;
      out.push({
        id: expenseId,
        titulo: cfg?.titulo || first.titulo || exp?.titulo || 'Item',
        tipoDespesa: tipo,
        ambiente,
        valorReal: totalReal,
        valorProj: projValor,
        link,
        imageUrl: cfg?.imageUrl || exp?.imageUrl || undefined,
        fornecedor: first.fornecedor || exp?.fornecedor,
        isExtra: false,
        isExcluded: excludes.has(expenseId),
      });
      seen.add(expenseId);
    }

    // Itens simulados (extras)
    for (const [id, cfg] of Object.entries(payConfigs)) {
      if (!id.startsWith('extra_')) continue;
      if (seen.has(id)) continue;
      if (!cfg.link || !cfg.ambiente) continue;
      const tipo = normalizeTipo(cfg.categoria);
      if (EXCLUDED_TIPOS.has(tipo) || EXCLUDED_LABELS.has(tipo)) continue;
      const valor = cfg.valor ? Math.round(parseFloat(cfg.valor) * 100) : 0;
      out.push({
        id,
        titulo: cfg.titulo || 'Item Simulado',
        tipoDespesa: tipo,
        ambiente: cfg.ambiente,
        valorReal: 0,
        valorProj: valor,
        link: cfg.link,
        imageUrl: cfg.imageUrl,
        isExtra: true,
        isExcluded: excludes.has(id),
      });
    }

    return out;
  }, [cfEntries, payConfigs, excludes, expenseById]);

  /* Filter + sort */
  const compraveis = useMemo(() => {
    let items = allItems;
    if (filterTipo) items = items.filter((e) => e.tipoDespesa === filterTipo);
    if (sortBy === 'valor') items = [...items].sort((a, b) => b.valorProj - a.valorProj);
    else if (sortBy === 'titulo') items = [...items].sort((a, b) => a.titulo.localeCompare(b.titulo));
    return items;
  }, [allItems, filterTipo, sortBy]);

  const totalProj = compraveis.filter((i) => !i.isExcluded).reduce((s, i) => s + i.valorProj, 0);

  const availableTipos = useMemo(() => {
    const tipos = new Set(allItems.map((i) => i.tipoDespesa).filter(Boolean));
    return Array.from(tipos).map((t) => ({ value: t, label: ExpenseTypeLabels[t as keyof typeof ExpenseTypeLabels] ?? t }));
  }, [allItems]);

  /* Group by ambiente */
  const groupedRooms = useMemo(() => {
    const grouped = new Map<string, SimShoppableItem[]>();
    compraveis.forEach((e) => {
      if (!grouped.has(e.ambiente)) grouped.set(e.ambiente, []);
      grouped.get(e.ambiente)!.push(e);
    });
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([roomName, items]) => {
        if (sortBy === 'custom' && cardOrder[roomName]) {
          const order = cardOrder[roomName];
          const ordered: SimShoppableItem[] = [];
          const remaining = [...items];
          order.forEach((id) => {
            const idx = remaining.findIndex((e) => e.id === id);
            if (idx >= 0) ordered.push(...remaining.splice(idx, 1));
          });
          return { roomName, items: [...ordered, ...remaining] };
        }
        return { roomName, items };
      });
  }, [compraveis, sortBy, cardOrder]);

  const handleDragEnd = useCallback((roomName: string) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const room = groupedRooms.find((g) => g.roomName === roomName);
    if (!room) return;
    const oldIndex = room.items.findIndex((e) => e.id === active.id);
    const newIndex = room.items.findIndex((e) => e.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const newItems = arrayMove(room.items, oldIndex, newIndex);
    const newOrder = { ...cardOrder, [roomName]: newItems.map((e) => String(e.id)) };
    saveOrder(newOrder);
    setSortBy('custom');
  }, [groupedRooms, cardOrder, saveOrder]);

  /* Add form */
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ titulo: '', valor: '', categoria: '', ambiente: '', link: '', imageUrl: '' });
  const canSubmit = !!draft.titulo && !!draft.valor && !!draft.link && !!draft.ambiente;
  const ambienteOptions = useMemo(() => {
    const set = new Set<string>();
    expenses.forEach((e) => { if (e.room?.name) set.add(e.room.name); });
    return Array.from(set).sort();
  }, [expenses]);

  return (
    <div className="space-y-4">
      {/* Summary + Filters */}
      <div className="bg-gradient-to-r from-orange-50 to-amber-50 rounded-xl p-4 border border-orange-100">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-orange-500" />
              {compraveis.length} {compraveis.length === 1 ? 'item simulado' : 'itens simulados'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">Projetado: <span className="font-bold text-orange-700">{formatCurrency(totalProj / 100)}</span></p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <select
              value={filterTipo}
              onChange={(e) => setFilterTipo(e.target.value)}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="">Todos os tipos</option>
              {availableTipos.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'valor' | 'titulo' | 'custom')}
              className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300"
            >
              <option value="custom">Manual (arrastar)</option>
              <option value="valor">Maior valor</option>
              <option value="titulo">A–Z</option>
            </select>
            <div className="hidden lg:inline-flex items-center gap-1 text-xs bg-white border rounded-lg px-2 py-1" title="Itens por linha">
              <span className="text-gray-400">Por linha:</span>
              <button type="button" onClick={() => changeCols(3)} className={`px-1.5 rounded ${colsPerRow === 3 ? 'bg-orange-100 text-orange-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}>3</button>
              <button type="button" onClick={() => changeCols(4)} className={`px-1.5 rounded ${colsPerRow === 4 ? 'bg-orange-100 text-orange-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}>4</button>
            </div>
          </div>
        </div>
      </div>

      {/* Add form */}
      {showAdd ? (
        <div className="border-2 border-dashed border-purple-300 rounded-lg p-3 bg-purple-50/30 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-sm text-purple-700">Novo item simulado</h4>
            <button onClick={() => { setShowAdd(false); setDraft({ titulo: '', valor: '', categoria: '', ambiente: '', link: '', imageUrl: '' }); }} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <input value={draft.titulo} onChange={(e) => setDraft((p) => ({ ...p, titulo: e.target.value }))} placeholder="Nome do produto" className="border rounded px-2 py-1.5 text-sm" autoFocus />
            <input type="number" step="0.01" value={draft.valor} onChange={(e) => setDraft((p) => ({ ...p, valor: e.target.value }))} placeholder="Valor (R$)" className="border rounded px-2 py-1.5 text-sm" />
            <select value={draft.categoria} onChange={(e) => setDraft((p) => ({ ...p, categoria: e.target.value }))} className="border rounded px-2 py-1.5 text-sm bg-white">
              <option value="">Tipo de despesa...</option>
              {TIPO_DESPESA_OPTIONS.filter((o) => !EXCLUDED_TIPOS.has(o.value)).map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            <input list="sim-ambientes-options" value={draft.ambiente} onChange={(e) => setDraft((p) => ({ ...p, ambiente: e.target.value }))} placeholder="Ambiente *" className="border rounded px-2 py-1.5 text-sm" />
            <datalist id="sim-ambientes-options">
              {ambienteOptions.map((a) => (<option key={a} value={a} />))}
            </datalist>
            <input type="url" value={draft.link} onChange={(e) => setDraft((p) => ({ ...p, link: e.target.value }))} placeholder="URL do produto *" className="border rounded px-2 py-1.5 text-sm" />
            <input type="url" value={draft.imageUrl} onChange={(e) => setDraft((p) => ({ ...p, imageUrl: e.target.value }))} placeholder="URL da imagem (opcional)" className="border rounded px-2 py-1.5 text-sm sm:col-span-2 lg:col-span-1" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowAdd(false); setDraft({ titulo: '', valor: '', categoria: '', ambiente: '', link: '', imageUrl: '' }); }} className="px-3 py-1.5 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300">Cancelar</button>
            <button
              disabled={!canSubmit}
              onClick={() => {
                const id = `extra_${Date.now()}`;
                onPayConfigChange(id, {
                  mode: 'avista', parcelas: '1', inicio: '', valor: draft.valor,
                  titulo: draft.titulo,
                  categoria: draft.categoria || undefined,
                  ambiente: draft.ambiente,
                  link: draft.link,
                  imageUrl: draft.imageUrl || undefined,
                });
                setDraft({ titulo: '', valor: '', categoria: '', ambiente: '', link: '', imageUrl: '' });
                setShowAdd(false);
              }}
              className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded font-medium hover:bg-purple-700 disabled:opacity-40"
            >
              Adicionar item
            </button>
          </div>
          <p className="text-[10px] text-purple-600/70">* Nome, valor, ambiente e URL obrigatórios para aparecer na vitrine.</p>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full border-2 border-dashed border-purple-300 rounded-lg py-2.5 text-purple-600 text-sm font-medium hover:bg-purple-50 hover:border-purple-400 transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Adicionar item simulado
        </button>
      )}

      {/* Cards grouped by Room */}
      {compraveis.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <ShoppingCart className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum item comprável encontrado neste cenário</p>
          <p className="text-xs mt-1">Itens com link e ambiente preenchidos (exceto Material de Construção e Mão de Obra) aparecerão aqui</p>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedRooms.map(({ roomName, items }) => (
            <div key={roomName}>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-sm font-bold text-gray-700">🏠 {roomName}</h3>
                <span className="text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{items.length} {items.length === 1 ? 'item' : 'itens'}</span>
                <span className="text-[10px] text-gray-500 ml-auto font-medium">{formatCurrency(items.filter((i) => !i.isExcluded).reduce((s, e) => s + e.valorProj, 0) / 100)}</span>
              </div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd(roomName)}>
                <SortableContext items={items.map((e) => e.id)} strategy={rectSortingStrategy}>
                  <div className={`grid grid-cols-2 sm:grid-cols-2 ${colsPerRow === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-2 sm:gap-5`}>
                    {items.map((item) => (<SortableSimCard key={item.id} item={item} />))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
