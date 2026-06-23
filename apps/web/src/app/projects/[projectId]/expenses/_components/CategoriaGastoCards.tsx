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
function Donut({ pct, color = '#F27D33' }: { pct: number; color?: string }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10 shrink-0 -rotate-90">
      <circle cx="20" cy="20" r={r} fill="none" stroke="#EDDBC2" strokeWidth="4" />
      <circle
        cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="4"
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
  limitsByTipo,
}: {
  categorias: CategoriaGasto[];
  tipoLabel: (t: string) => string;
  /** Limite mensal (centavos) por tipoDespesa — quando existe meta, o donut e o texto refletem o % do limite. */
  limitsByTipo?: Map<string, number>;
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
        <span className="text-xs font-semibold uppercase tracking-wide text-darc-velvet/60">
          Gastos por categoria
        </span>
        <span className="text-[10px] text-darc-velvet/40">
          {categorias.length} {categorias.length === 1 ? 'categoria' : 'categorias'}
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 p-4 border-t border-darc-linen">
          {categorias.map((c) => {
            const limite = limitsByTipo?.get(c.tipo);
            // Com meta: % e cor do donut refletem uso do limite; sem meta: % sobre o total do mês.
            const pct = limite && limite > 0
              ? Math.round((c.total / limite) * 100)
              : (total > 0 ? Math.round((c.total / total) * 100) : 0);
            const donutColor = limite
              ? (pct >= 100 ? '#DC2626' : pct >= 80 ? '#F59E0B' : '#F27D33')
              : '#F27D33';
            return (
              <div key={c.tipo} className="rounded-xl border border-darc-linen/60 bg-white p-3 hover:shadow-sm transition-shadow">
                <div className="flex items-start gap-2">
                  <Donut pct={Math.min(pct, 999)} color={donutColor} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-darc-velvet leading-tight">{tipoLabel(c.tipo)}</p>
                    <p className="mt-1 text-base font-bold text-darc-velvet tabular-nums">{formatCurrency(c.total / 100)}</p>
                    {limite && (
                      <p className="text-[10px] text-darc-velvet/40">de {formatCurrency(limite / 100)}</p>
                    )}
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-darc-linen/40">
                  <p className="text-[10px] text-darc-velvet/50 leading-relaxed">
                    Pago <span className="font-semibold text-emerald-600">{formatCurrency(c.pago / 100)}</span>
                    {' · '}
                    A vir <span className="font-semibold text-amber-600">{formatCurrency(c.planejado / 100)}</span>
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

