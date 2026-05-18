'use client';

import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ShoppingCart, Plus } from 'lucide-react';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { CashFlowEntry, Expense } from '@/types';
import { TIPO_DESPESA_OPTIONS, CATEGORIA_MAO_DE_OBRA_OPTIONS, tipoLabel } from '@/lib/expense-options';
import type { PayConfig } from '../_types';

interface LinkPreview {
  ogTitle?: string;
  ogImage?: string;
  ogDescription?: string;
  favicon?: string;
}

interface ShoppableItem {
  id: string;
  titulo: string;
  categoria?: string;
  ambiente?: string;
  valorReal: number;
  valorProj: number;
  link?: string;
  imageUrl?: string;
  fornecedor?: string;
  isExtra: boolean;
  isExcluded: boolean;
}

function ShoppableSimItemCard({ item }: { item: ShoppableItem }) {
  const [imgError, setImgError] = useState(false);
  const { data: preview, isLoading } = useQuery<LinkPreview>({
    queryKey: ['link-preview', item.link],
    queryFn: () => api.get(`/link-preview?url=${encodeURIComponent(item.link!)}`),
    staleTime: 1000 * 60 * 60 * 24,
    retry: 1,
    enabled: !!item.link,
  });

  const title = item.titulo || preview?.ogTitle || 'Sem título';
  const imageSource = item.imageUrl || (preview?.ogImage && !imgError ? preview.ogImage : null);
  const hasImage = !!imageSource && !imgError;
  let domain = '';
  try { if (item.link) domain = new URL(item.link).hostname.replace('www.', ''); } catch { /* ignore */ }

  const diff = item.valorProj - item.valorReal;

  return (
    <div className={`border rounded-xl overflow-hidden bg-white shadow-sm hover:shadow-md transition-all group flex flex-col ${item.isExcluded ? 'opacity-50' : ''}`}>
      {/* Image area */}
      <div className="relative h-32 sm:h-44 bg-gray-100 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 border-2 border-purple-300 border-t-transparent rounded-full animate-spin" />
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
            <p className="text-xs text-gray-400 font-medium">{domain || '—'}</p>
          </div>
        )}
        {item.isExtra && (
          <span className="absolute top-2 left-2 text-[9px] font-semibold bg-purple-600 text-white px-1.5 py-0.5 rounded">SIM</span>
        )}
      </div>

      {/* Content */}
      <div className="p-2 sm:p-3 flex-1 flex flex-col gap-1 sm:gap-1.5">
        <h3 className="font-semibold text-[11px] sm:text-sm text-gray-800 line-clamp-2 leading-snug">{title}</h3>

        <div className="flex flex-wrap gap-1">
          {item.categoria && (
            <span className="text-[9px] sm:text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{tipoLabel(item.categoria)}</span>
          )}
          {item.ambiente && (
            <span className="hidden sm:inline text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">{item.ambiente}</span>
          )}
        </div>

        {item.fornecedor && (
          <p className="hidden sm:block text-[10px] text-gray-500 truncate">🏪 {item.fornecedor}</p>
        )}

        <div className="mt-auto pt-1.5 sm:pt-2 flex items-end justify-between border-t border-gray-100">
          <div className="min-w-0">
            <p className="hidden sm:block text-[10px] text-gray-400">Projetado</p>
            <p className="text-sm sm:text-base font-bold text-purple-700 truncate">{formatCurrency(item.valorProj / 100)}</p>
            {!item.isExtra && item.valorReal !== item.valorProj && (
              <p className="text-[10px] text-gray-400">
                Real: <span className="font-medium">{formatCurrency(item.valorReal / 100)}</span>
                {diff !== 0 && (
                  <span className={`ml-1 ${diff > 0 ? 'text-red-500' : 'text-green-600'}`}>
                    ({diff > 0 ? '+' : ''}{formatCurrency(diff / 100)})
                  </span>
                )}
              </p>
            )}
          </div>
          {item.link && (
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 sm:px-3 py-1 sm:py-1.5 bg-purple-500 text-white text-xs font-medium rounded-lg hover:bg-purple-600 transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> <span className="hidden sm:inline">Abrir</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function ShoppableSimulationView({
  payConfigs,
  excludes,
  onPayConfigChange,
}: {
  payConfigs: Record<string, PayConfig>;
  excludes: Set<string>;
  onPayConfigChange: (id: string, cfg: PayConfig) => void;
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

  const items = useMemo<ShoppableItem[]>(() => {
    const out: ShoppableItem[] = [];
    const seen = new Set<string>();

    const EXCLUDED_TIPOS = new Set(['MATERIAL_CONSTRUCAO', 'MAO_DE_OBRA']);
    const EXCLUDED_LABELS = new Set(['Material p/ Construção', 'Mão de Obra']);
    const isExcluded = (tipo?: string) => !!tipo && (EXCLUDED_TIPOS.has(tipo) || EXCLUDED_LABELS.has(tipo));

    // Despesas reais agrupadas por expenseId
    const byExpense = new Map<string, CashFlowEntry[]>();
    for (const e of cfEntries.filter((e) => e.tipo === 'DESPESA')) {
      if (!e.expenseId) continue;
      const existing = byExpense.get(e.expenseId);
      if (existing) existing.push(e);
      else byExpense.set(e.expenseId, [e]);
    }
    for (const [expenseId, entries] of byExpense) {
      const exp = expenseById.get(expenseId);
      const first = entries[0];
      const cfg = payConfigs[expenseId];
      // Source of truth: Expense.tipoDespesa (enum value). Fallback to cfg.categoria / cf.categoria (labels).
      if (isExcluded(exp?.tipoDespesa) || isExcluded(cfg?.categoria) || isExcluded(first.categoria)) continue;
      const totalReal = entries.reduce((s, x) => s + x.valor, 0);
      const projValor = cfg?.valor ? Math.round(parseFloat(cfg.valor) * 100) : totalReal;
      out.push({
        id: expenseId,
        titulo: cfg?.titulo || first.titulo || exp?.titulo || first.categoria || 'Despesa',
        categoria: exp?.tipoDespesa || cfg?.categoria || first.categoria,
        ambiente: cfg?.ambiente || first.ambiente || exp?.room?.name,
        valorReal: totalReal,
        valorProj: projValor,
        link: cfg?.link || exp?.link || undefined,
        imageUrl: cfg?.imageUrl || exp?.imageUrl || undefined,
        fornecedor: first.fornecedor || exp?.fornecedor,
        isExtra: false,
        isExcluded: excludes.has(expenseId),
      });
      seen.add(expenseId);
    }

    // Itens simulados (extras) - id começa com extra_
    for (const [id, cfg] of Object.entries(payConfigs)) {
      if (!id.startsWith('extra_')) continue;
      if (seen.has(id)) continue;
      if (isExcluded(cfg.categoria)) continue;
      const valor = cfg.valor ? Math.round(parseFloat(cfg.valor) * 100) : 0;
      out.push({
        id,
        titulo: cfg.titulo || 'Despesa Extra',
        categoria: cfg.categoria,
        ambiente: cfg.ambiente,
        valorReal: 0,
        valorProj: valor,
        link: cfg.link,
        imageUrl: cfg.imageUrl,
        isExtra: true,
        isExcluded: excludes.has(id),
      });
    }

    return out.sort((a, b) => b.valorProj - a.valorProj);
  }, [cfEntries, payConfigs, excludes, expenseById]);

  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ titulo: '', valor: '', categoria: '', subcategoria: '', ambiente: '', link: '', imageUrl: '' });

  const totalProj = useMemo(() => items.filter((i) => !i.isExcluded).reduce((s, i) => s + i.valorProj, 0), [items]);
  const totalReal = useMemo(() => items.filter((i) => !i.isExtra).reduce((s, i) => s + i.valorReal, 0), [items]);

  const canSubmit = !!draft.titulo && !!draft.valor;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div className="bg-gray-50 border rounded-lg px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Itens</p>
          <p className="text-lg font-bold text-gray-800">{items.length}</p>
        </div>
        <div className="bg-gray-50 border rounded-lg px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Total Real</p>
          <p className="text-lg font-bold text-gray-700">{formatCurrency(totalReal / 100)}</p>
        </div>
        <div className="bg-purple-50 border border-purple-100 rounded-lg px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-purple-700">Total Projetado</p>
          <p className="text-lg font-bold text-purple-700">{formatCurrency(totalProj / 100)}</p>
        </div>
      </div>

      {/* Add form */}
      {showAdd ? (
        <div className="border-2 border-dashed border-purple-300 rounded-lg p-3 bg-purple-50/30 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-sm text-purple-700">Novo item simulado</h4>
            <button onClick={() => { setShowAdd(false); setDraft({ titulo: '', valor: '', categoria: '', subcategoria: '', ambiente: '', link: '', imageUrl: '' }); }} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <input
              value={draft.titulo}
              onChange={(e) => setDraft((p) => ({ ...p, titulo: e.target.value }))}
              placeholder="Nome do produto/despesa"
              className="border rounded px-2 py-1.5 text-sm"
              autoFocus
            />
            <input
              type="number"
              step="0.01"
              value={draft.valor}
              onChange={(e) => setDraft((p) => ({ ...p, valor: e.target.value }))}
              placeholder="Valor (R$)"
              className="border rounded px-2 py-1.5 text-sm"
            />
            <select
              value={draft.categoria}
              onChange={(e) => setDraft((p) => ({ ...p, categoria: e.target.value, subcategoria: '' }))}
              className="border rounded px-2 py-1.5 text-sm bg-white"
            >
              <option value="">Tipo de despesa...</option>
              {TIPO_DESPESA_OPTIONS.filter((o) => o.value !== 'MATERIAL_CONSTRUCAO' && o.value !== 'MAO_DE_OBRA').map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
            {draft.categoria === 'MAO_DE_OBRA' && (
              <select
                value={draft.subcategoria}
                onChange={(e) => setDraft((p) => ({ ...p, subcategoria: e.target.value }))}
                className="border rounded px-2 py-1.5 text-sm bg-white"
              >
                <option value="">Categoria...</option>
                {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            )}
            <input
              value={draft.ambiente}
              onChange={(e) => setDraft((p) => ({ ...p, ambiente: e.target.value }))}
              placeholder="Ambiente"
              className="border rounded px-2 py-1.5 text-sm"
            />
            <input
              type="url"
              value={draft.link}
              onChange={(e) => setDraft((p) => ({ ...p, link: e.target.value }))}
              placeholder="URL do produto (opcional)"
              className="border rounded px-2 py-1.5 text-sm"
            />
            <input
              type="url"
              value={draft.imageUrl}
              onChange={(e) => setDraft((p) => ({ ...p, imageUrl: e.target.value }))}
              placeholder="URL da imagem (opcional)"
              className="border rounded px-2 py-1.5 text-sm sm:col-span-2 lg:col-span-1"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowAdd(false); setDraft({ titulo: '', valor: '', categoria: '', subcategoria: '', ambiente: '', link: '', imageUrl: '' }); }}
              className="px-3 py-1.5 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
            >
              Cancelar
            </button>
            <button
              disabled={!canSubmit}
              onClick={() => {
                const id = `extra_${Date.now()}`;
                onPayConfigChange(id, {
                  mode: 'avista',
                  parcelas: '1',
                  inicio: '',
                  valor: draft.valor,
                  titulo: draft.titulo,
                  categoria: draft.categoria || undefined,
                  subcategoria: draft.subcategoria || undefined,
                  ambiente: draft.ambiente || undefined,
                  link: draft.link || undefined,
                  imageUrl: draft.imageUrl || undefined,
                });
                setDraft({ titulo: '', valor: '', categoria: '', subcategoria: '', ambiente: '', link: '', imageUrl: '' });
                setShowAdd(false);
              }}
              className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded font-medium hover:bg-purple-700 disabled:opacity-40"
            >
              Adicionar item
            </button>
          </div>
          <p className="text-[10px] text-purple-600/70">
            Dica: itens com link mostram a imagem automaticamente; informe a URL da imagem se preferir um thumbnail próprio.
          </p>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full border-2 border-dashed border-purple-300 rounded-lg py-3 text-purple-600 text-sm font-medium hover:bg-purple-50 hover:border-purple-400 transition-colors flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Adicionar item simulado
        </button>
      )}

      {/* Grid */}
      {items.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <ShoppingCart className="w-12 h-12 mx-auto mb-2 opacity-40" />
          <p className="text-sm">Nenhum item ainda neste cenário.</p>
          <p className="text-xs mt-1">Adicione itens acima ou cadastre despesas no cash-flow.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {items.map((item) => (
            <ShoppableSimItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
