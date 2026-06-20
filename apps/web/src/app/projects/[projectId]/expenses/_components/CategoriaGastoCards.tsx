'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

export interface CategoriaGasto {
  tipo: string;
  total: number;
  pago: number;
  planejado: number;
  count: number;
}

/** Donut compacto (% sobre o total) — trilha linen, progresso laranja. */
function Donut({ pct }: { pct: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10 shrink-0 -rotate-90">
      <circle cx="20" cy="20" r={r} fill="none" stroke="#EDDBC2" strokeWidth="4" />
      <circle
        cx="20" cy="20" r={r} fill="none" stroke="#F27D33" strokeWidth="4"
        strokeLinecap="round" strokeDasharray={`${dash} ${c}`}
      />
      <text x="20" y="21" transform="rotate(90 20 20)" textAnchor="middle" dominantBaseline="middle"
        className="fill-darc-velvet text-[11px] font-bold">{pct}%</text>
    </svg>
  );
}

/**
 * "Gastos por categoria no mês" (visão Gastos Controle do PESSOAL).
 * Colapsável (fechado por padrão). Aberto: lista com donut (% do total),
 * valor e divisão pago/planejado — estilo da tela de metas de referência.
 */
export function CategoriaGastoCards({
  categorias,
  tipoLabel,
}: {
  categorias: CategoriaGasto[];
  tipoLabel: (t: string) => string;
}) {
  const [open, setOpen] = useState(false);
  if (categorias.length === 0) return null;
  const total = categorias.reduce((s, c) => s + c.total, 0);
  return (
    <section className="rounded-2xl border border-darc-linen bg-white shadow-darc-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-orange-50/40"
      >
        {open ? <ChevronDown className="h-4 w-4 text-darc-velvet/40" /> : <ChevronRight className="h-4 w-4 text-darc-velvet/40" />}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-darc-velvet/60">
          Gastos por categoria
        </span>
        <span className="text-[10px] text-darc-velvet/40">
          {categorias.length} {categorias.length === 1 ? 'categoria' : 'categorias'}
        </span>
        <span className="ml-auto font-bold text-sm text-darc-velvet tabular-nums">
          {formatCurrency(total / 100)}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-darc-linen/60 border-t border-darc-linen">
          {categorias.map((c) => {
            const pct = total > 0 ? Math.round((c.total / total) * 100) : 0;
            return (
              <div key={c.tipo} className="flex items-center gap-3 px-4 py-2.5">
                <Donut pct={pct} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-darc-velvet">{tipoLabel(c.tipo)}</p>
                  <p className="text-[11px] text-darc-velvet/50">
                    Pago <span className="font-semibold text-emerald-600">{formatCurrency(c.pago / 100)}</span>
                    {' · '}A vir <span className="font-semibold text-amber-600">{formatCurrency(c.planejado / 100)}</span>
                  </p>
                </div>
                <p className="shrink-0 text-sm font-bold text-darc-velvet tabular-nums">
                  {formatCurrency(c.total / 100)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

