'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CreditCard } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { getExpenseIcon } from '@/lib/expense-icons';
import type { AccountViewSaida } from '../_types';

interface CatGroup {
  key: string;
  label: string;
  tipo: string | null;
  total: number;
  count: number;
}

interface ProjGroup {
  key: string;
  name: string;
  type: string;
  total: number;
  count: number;
  categorias: CatGroup[];
}

// Cor por tipo de projeto — espelha o accent das Despesas. Mapa local (5 linhas) para
// não acoplar ao módulo pesado PersonalHierarchicalView.
function projectAccent(type: string): { card: string; badge: string } {
  switch (type) {
    case 'REFORMA':
      return { card: 'border-orange-300', badge: 'bg-orange-100 text-orange-800' };
    case 'CASA':
      return { card: 'border-emerald-300', badge: 'bg-emerald-100 text-emerald-800' };
    case 'CARRO':
      return { card: 'border-blue-300', badge: 'bg-blue-100 text-blue-800' };
    case 'COMPRA':
      return { card: 'border-amber-300', badge: 'bg-amber-100 text-amber-800' };
    case 'PESSOAL':
      return { card: 'border-indigo-300', badge: 'bg-indigo-100 text-indigo-800' };
    default:
      return { card: 'border-gray-300', badge: 'bg-gray-100 text-gray-800' };
  }
}

/** Agrupa saídas por projeto de destino → categoria (tipo de despesa). */
export function buildProjetoCategoria(items: AccountViewSaida[], selfProjectId: string): ProjGroup[] {
  const map = new Map<string, ProjGroup & { cats: Map<string, CatGroup> }>();
  for (const m of items) {
    const proj = m.projetoOrigem && m.projetoOrigem.type !== 'PESSOAL' ? m.projetoOrigem : null;
    const pKey = proj ? proj.id : selfProjectId;
    let pg = map.get(pKey);
    if (!pg) {
      pg = {
        key: pKey,
        name: proj ? proj.name : 'Pessoal',
        type: proj ? proj.type : 'PESSOAL',
        total: 0,
        count: 0,
        categorias: [],
        cats: new Map(),
      };
      map.set(pKey, pg);
    }
    pg.total += m.valor;
    pg.count += 1;
    const cKey = m.isInvoice ? '__fatura__' : m.tipoDespesa || '__sem__';
    const cur =
      pg.cats.get(cKey) ??
      {
        key: cKey,
        label: m.isInvoice ? 'Fatura de cartão' : tipoLabel(m.tipoDespesa) || 'Sem categoria',
        tipo: m.isInvoice ? null : m.tipoDespesa || null,
        total: 0,
        count: 0,
      };
    cur.total += m.valor;
    cur.count += 1;
    pg.cats.set(cKey, cur);
  }
  return Array.from(map.values())
    .map((p) => ({
      key: p.key,
      name: p.name,
      type: p.type,
      total: p.total,
      count: p.count,
      categorias: Array.from(p.cats.values()).sort((a, b) => b.total - a.total),
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Visão "Por projeto e categoria" da Conta (desktop). Espelha o drill-down das
 * Despesas: cada projeto é um card expansível cujas linhas são as categorias
 * (clique → abre a Lista já filtrada por projeto + categoria).
 */
export function PorProjetoCategoriaView({
  items,
  selfProjectId,
  onDrill,
}: {
  items: AccountViewSaida[];
  selfProjectId: string;
  onDrill: (projKey: string, tipo: string | null) => void;
}) {
  const grupos = useMemo(() => buildProjetoCategoria(items, selfProjectId), [items, selfProjectId]);

  if (grupos.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-lifeone-hairline bg-lifeone-card p-8 text-center text-sm text-lifeone-ink-3">
        Nenhuma saída com esses filtros.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {grupos.map((g) => (
        <ProjetoCard key={g.key} g={g} onDrill={onDrill} />
      ))}
    </div>
  );
}

function ProjetoCard({
  g,
  onDrill,
}: {
  g: ProjGroup;
  onDrill: (projKey: string, tipo: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const accent = projectAccent(g.type);
  return (
    <div className={`overflow-hidden rounded-2xl border-2 ${accent.card} bg-lifeone-card`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition hover:bg-lifeone-sidebar"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
        )}
        <span className="truncate text-sm font-bold text-lifeone-ink">{g.name}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.badge}`}>
          {g.count}
        </span>
        <span className="ml-auto whitespace-nowrap text-sm font-bold tabular-nums font-geist text-lifeone-ink">
          {formatCurrency(g.total / 100)}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-lifeone-hairline border-t border-lifeone-hairline">
          {g.categorias.map((c) => {
            const iconCfg = c.tipo
              ? getExpenseIcon(c.tipo)
              : { Icon: CreditCard, color: 'text-[#7A3FC2]', bgColor: 'bg-[#EFE6FA]' };
            const CatIcon = iconCfg.Icon;
            return (
              <button
                key={c.key}
                type="button"
                disabled={!c.tipo}
                onClick={() => onDrill(g.key, c.tipo)}
                className={`flex w-full items-center gap-3 py-2.5 pl-10 pr-4 text-left transition ${
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
                <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums font-geist text-lifeone-ink">
                  {formatCurrency(c.total / 100)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
