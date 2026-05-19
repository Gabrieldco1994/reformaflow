'use client';

import React, { useMemo, useState } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { ExternalLink, ShoppingCart } from 'lucide-react';
import { ExpenseTypeLabels } from '@reformaflow/domain';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { CashFlowEntry, Expense } from '@/types';
import { tipoLabel } from '@/lib/expense-options';
import type { PayConfig, Scenario, SimulationData } from '../_types';

interface LinkPreview {
  ogTitle?: string;
  ogImage?: string;
}

interface SimShoppableItem {
  id: string;
  productKey: string;
  titulo: string;
  tipoDespesa: string;
  ambiente: string;
  valorProj: number;
  link: string;
  imageUrl?: string;
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

function parseConfigsFromSaved(savedValues?: Record<string, string>) {
  const payConfigs: Record<string, PayConfig> = {};
  const excludes = new Set<string>();
  if (!savedValues) return { payConfigs, excludes };
  for (const [key, val] of Object.entries(savedValues)) {
    if (key.startsWith('monthly_excl|')) {
      if (val === '1') excludes.add(key.slice(13));
    } else if (key.startsWith('monthly_pay|')) {
      const rest = key.slice(12);
      const lastPipe = rest.lastIndexOf('|');
      const id = rest.slice(0, lastPipe);
      const field = rest.slice(lastPipe + 1);
      if (!payConfigs[id]) payConfigs[id] = { mode: 'avista', parcelas: '1', inicio: '', valor: '' };
      const cfg = payConfigs[id];
      if (field === 'mode') cfg.mode = val;
      else if (field === 'parcelas') cfg.parcelas = val;
      else if (field === 'inicio') cfg.inicio = val;
      else if (field === 'valor') cfg.valor = val;
      else if (field === 'titulo') cfg.titulo = val;
      else if (field === 'categoria') cfg.categoria = val;
      else if (field === 'subcategoria') cfg.subcategoria = val;
      else if (field === 'ambiente') cfg.ambiente = val;
      else if (field === 'link') cfg.link = val;
      else if (field === 'imageUrl') cfg.imageUrl = val;
    }
  }
  return { payConfigs, excludes };
}

function buildItems({
  cfEntries, expenses, payConfigs, excludes,
}: {
  cfEntries: CashFlowEntry[];
  expenses: Expense[];
  payConfigs: Record<string, PayConfig>;
  excludes: Set<string>;
}): SimShoppableItem[] {
  const out: SimShoppableItem[] = [];
  const expenseById = new Map<string, Expense>(expenses.map((e) => [e.id, e]));
  const seen = new Set<string>();

  const byExpense = new Map<string, CashFlowEntry[]>();
  for (const e of cfEntries.filter((e) => e.tipo === 'DESPESA')) {
    if (!e.expenseId) continue;
    const arr = byExpense.get(e.expenseId);
    if (arr) arr.push(e);
    else byExpense.set(e.expenseId, [e]);
  }

  for (const [expenseId, entries] of byExpense) {
    const exp = expenseById.get(expenseId);
    const cfg = payConfigs[expenseId];
    const first = entries[0];
    const link = cfg?.link || exp?.link;
    const ambiente = cfg?.ambiente || first.ambiente || exp?.room?.name;
    if (!link || !ambiente) continue;
    const tipo = normalizeTipo(exp?.tipoDespesa || cfg?.categoria || first.categoria);
    if (EXCLUDED_TIPOS.has(tipo) || EXCLUDED_LABELS.has(tipo)) continue;
    const totalReal = entries.reduce((s, x) => s + x.valor, 0);
    const projValor = cfg?.valor ? Math.round(parseFloat(cfg.valor) * 100) : totalReal;
    out.push({
      id: expenseId,
      productKey: `e::${expenseId}`,
      titulo: cfg?.titulo || first.titulo || exp?.titulo || 'Item',
      tipoDespesa: tipo,
      ambiente,
      valorProj: projValor,
      link,
      imageUrl: cfg?.imageUrl || exp?.imageUrl || undefined,
      isExtra: false,
      isExcluded: excludes.has(expenseId),
    });
    seen.add(expenseId);
  }

  for (const [id, cfg] of Object.entries(payConfigs)) {
    if (!id.startsWith('extra_')) continue;
    if (seen.has(id)) continue;
    if (!cfg.link || !cfg.ambiente) continue;
    const tipo = normalizeTipo(cfg.categoria);
    if (EXCLUDED_TIPOS.has(tipo) || EXCLUDED_LABELS.has(tipo)) continue;
    const valor = cfg.valor ? Math.round(parseFloat(cfg.valor) * 100) : 0;
    const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    out.push({
      id,
      productKey: `x::${norm(cfg.ambiente)}::${norm(cfg.titulo || '')}`,
      titulo: cfg.titulo || 'Item Simulado',
      tipoDespesa: tipo,
      ambiente: cfg.ambiente,
      valorProj: valor,
      link: cfg.link,
      imageUrl: cfg.imageUrl,
      isExtra: true,
      isExcluded: excludes.has(id),
    });
  }

  return out;
}

export function ShoppableSimulationView() {
  const { projectId: PROJECT_ID } = useProject();

  const { data: scenarios = [] } = useQuery<Scenario[]>({
    queryKey: ['simulation-scenarios', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation/scenarios`),
  });

  const { data: cfEntries = [] } = useQuery<CashFlowEntry[]>({
    queryKey: ['cash-flow', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
  });

  const { data: expenses = [] } = useQuery<Expense[]>({
    queryKey: ['expenses', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses`),
  });

  const scenarioQueries = useQueries({
    queries: scenarios.map((s) => ({
      queryKey: ['simulation', PROJECT_ID, s.id],
      queryFn: () => api.get<SimulationData>(`/projects/${PROJECT_ID}/simulation?scenarioId=${s.id}`),
      enabled: !!s.id,
    })),
  });

  const [filterTipo, setFilterTipo] = useState('');
  const [filterAmbiente, setFilterAmbiente] = useState('');

  const columns = useMemo(() => {
    return scenarios.map((s, idx) => {
      const data = scenarioQueries[idx]?.data;
      const { payConfigs, excludes } = parseConfigsFromSaved(data?.savedValues);
      const items = buildItems({ cfEntries, expenses, payConfigs, excludes });
      let filtered = items;
      if (filterTipo) filtered = filtered.filter((i) => i.tipoDespesa === filterTipo);
      if (filterAmbiente) filtered = filtered.filter((i) => i.ambiente === filterAmbiente);
      const totalProj = filtered.filter((i) => !i.isExcluded).reduce((s, i) => s + i.valorProj, 0);
      return {
        scenario: s,
        items: filtered,
        total: totalProj,
        loading: scenarioQueries[idx]?.isLoading ?? false,
      };
    });
  }, [scenarios, scenarioQueries, cfEntries, expenses, filterTipo, filterAmbiente]);

  const byAmbiente = useMemo(() => {
    const map = new Map<string, Map<string, { titulo: string; isExtra: boolean }>>();
    for (const col of columns) {
      for (const it of col.items) {
        if (!map.has(it.ambiente)) map.set(it.ambiente, new Map());
        const inner = map.get(it.ambiente)!;
        if (!inner.has(it.productKey)) inner.set(it.productKey, { titulo: it.titulo, isExtra: it.isExtra });
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ambiente, prods]) => ({
        ambiente,
        products: Array.from(prods.entries())
          .sort(([, a], [, b]) => a.titulo.localeCompare(b.titulo))
          .map(([productKey, info]) => ({ productKey, ...info })),
      }));
  }, [columns]);

  const availableTipos = useMemo(() => {
    const set = new Set<string>();
    for (const col of columns) for (const it of col.items) if (it.tipoDespesa) set.add(it.tipoDespesa);
    return Array.from(set).map((t) => ({
      value: t,
      label: ExpenseTypeLabels[t as keyof typeof ExpenseTypeLabels] ?? t,
    }));
  }, [columns]);

  const availableAmbientes = useMemo(() => {
    const set = new Set<string>();
    for (const col of columns) for (const it of col.items) if (it.ambiente) set.add(it.ambiente);
    return Array.from(set).sort();
  }, [columns]);

  if (scenarios.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <ShoppingCart className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">Nenhum cenário criado ainda</p>
        <p className="text-xs mt-1">Crie um cenário em Simulação para começar a comparar produtos</p>
      </div>
    );
  }

  const colCount = columns.length;
  const totalProducts = byAmbiente.reduce((s, a) => s + a.products.length, 0);

  return (
    <div className="space-y-3">
      <div className="bg-gradient-to-r from-orange-50 to-amber-50 rounded-xl p-3 border border-orange-100 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-orange-500" />
            Compráveis por cenário · {colCount} {colCount === 1 ? 'simulação' : 'simulações'}
          </h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {totalProducts} {totalProducts === 1 ? 'produto' : 'produtos'} distintos · cards alinhados horizontalmente por produto
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <select value={filterAmbiente} onChange={(e) => setFilterAmbiente(e.target.value)} className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300">
            <option value="">Todos os ambientes</option>
            {availableAmbientes.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={filterTipo} onChange={(e) => setFilterTipo(e.target.value)} className="text-xs border rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-orange-300">
            <option value="">Todos os tipos</option>
            {availableTipos.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {totalProducts === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <ShoppingCart className="w-10 h-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Nenhum item comprável encontrado em nenhum cenário</p>
          <p className="text-xs mt-1">Adicione itens com link e ambiente preenchidos na tela de Simulação</p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-2 px-2 pb-2">
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${colCount}, minmax(180px, 1fr))`,
              minWidth: `${colCount * 200}px`,
            }}
          >
            {columns.map((c) => (
              <div key={`hdr-${c.scenario.id}`} className="bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200 rounded-lg p-2.5 sticky top-0 z-10 shadow-sm">
                <p className="text-[11px] font-bold text-purple-700 uppercase tracking-wider truncate">{c.scenario.name}</p>
                <p className="text-base font-bold text-purple-900 mt-0.5">{formatCurrency(c.total / 100)}</p>
                <p className="text-[10px] text-purple-600/70">{c.items.filter((i) => !i.isExcluded).length} itens · projetado</p>
              </div>
            ))}

            {byAmbiente.map(({ ambiente, products }) => (
              <React.Fragment key={`amb-${ambiente}`}>
                <div
                  className="col-span-full bg-gray-50 border-l-4 border-orange-400 rounded px-2 py-1 mt-1"
                  style={{ gridColumn: `1 / span ${colCount}` }}
                >
                  <p className="text-xs font-bold text-gray-700">🏠 {ambiente} <span className="font-normal text-gray-400 ml-1">({products.length})</span></p>
                </div>
                {products.map((p) => (
                  <React.Fragment key={`row-${p.productKey}`}>
                    {columns.map((c) => {
                      const item = c.items.find((i) => i.productKey === p.productKey);
                      return (
                        <div key={`cell-${c.scenario.id}-${p.productKey}`}>
                          {item ? <CompactItemCard item={item} /> : <EmptyCell titulo={p.titulo} />}
                        </div>
                      );
                    })}
                  </React.Fragment>
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompactItemCard({ item }: { item: SimShoppableItem }) {
  const [imgError, setImgError] = useState(false);
  const { data: preview } = useQuery<LinkPreview>({
    queryKey: ['link-preview', item.link],
    queryFn: () => api.get(`/link-preview?url=${encodeURIComponent(item.link)}`),
    staleTime: 1000 * 60 * 60 * 24,
    retry: 1,
    enabled: !!item.link,
  });
  const imageSource = item.imageUrl || (preview?.ogImage && !imgError ? preview.ogImage : null);
  const title = item.titulo || preview?.ogTitle || 'Sem título';

  return (
    <div className={`relative border rounded-lg overflow-hidden bg-white shadow-sm hover:shadow-md transition-all flex flex-col h-full ${item.isExcluded ? 'opacity-40' : ''}`}>
      <div className="h-20 sm:h-24 bg-gray-50 flex items-center justify-center overflow-hidden">
        {imageSource ? (
          <img
            src={imageSource}
            alt={title}
            className="max-h-full max-w-full object-contain p-1"
            onError={() => setImgError(true)}
          />
        ) : (
          <ShoppingCart className="w-6 h-6 text-gray-300" />
        )}
      </div>
      <div className="p-1.5 flex-1 flex flex-col gap-0.5 min-h-0">
        <p className="text-[10px] sm:text-[11px] font-semibold text-gray-800 line-clamp-2 leading-tight" title={title}>{title}</p>
        <span className="text-[9px] bg-orange-100 text-orange-700 px-1 py-0.5 rounded inline-block w-fit truncate max-w-full">{tipoLabel(item.tipoDespesa)}</span>
        <div className="mt-auto flex items-end justify-between pt-1 border-t border-gray-100 gap-1">
          <p className="text-xs sm:text-sm font-bold text-purple-700 truncate">{formatCurrency(item.valorProj / 100)}</p>
          <a
            href={item.link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-orange-500 hover:text-orange-700 shrink-0"
            title="Abrir link"
          >
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
      {item.isExtra && (
        <span className="absolute top-1 right-1 text-[8px] font-bold bg-purple-600 text-white px-1 py-0.5 rounded">SIM</span>
      )}
      {item.isExcluded && (
        <span className="absolute top-1 left-1 text-[8px] font-bold bg-red-500 text-white px-1 py-0.5 rounded">EXCL</span>
      )}
    </div>
  );
}

function EmptyCell({ titulo }: { titulo: string }) {
  return (
    <div className="border border-dashed border-gray-200 rounded-lg p-2 bg-gray-50/50 h-full flex flex-col items-center justify-center text-center min-h-[120px]">
      <p className="text-[10px] text-gray-400 font-medium">— não incluso —</p>
      <p className="text-[9px] text-gray-300 line-clamp-2 mt-1" title={titulo}>{titulo}</p>
    </div>
  );
}
