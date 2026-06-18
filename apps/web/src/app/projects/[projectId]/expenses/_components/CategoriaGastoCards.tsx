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

/**
 * Cards de "Gastos por categoria no mês" (visão Gastos Controle do PESSOAL).
 * Substitui a antiga quebra "Por projeto". Colapsável (fechado por padrão);
 * o cabeçalho mostra o total agregado e abre o detalhamento por tipo.
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
    <section className="rounded-xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50"
      >
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Gastos por categoria no mês
        </span>
        <span className="text-[10px] text-gray-400">
          {categorias.length} {categorias.length === 1 ? 'categoria' : 'categorias'}
        </span>
        <span className="ml-auto font-mono text-sm font-bold text-gray-900 tabular-nums">
          {formatCurrency(total / 100)}
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-2 border-t border-gray-100 p-3 md:grid-cols-2 xl:grid-cols-3">
          {categorias.map((c) => (
            <div key={c.tipo} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-800">{tipoLabel(c.tipo)}</p>
                  <p className="text-[10px] uppercase tracking-wider text-gray-400">
                    {c.count} {c.count === 1 ? 'item' : 'itens'}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-bold text-gray-900 tabular-nums">
                  {formatCurrency(c.total / 100)}
                </p>
              </div>
              <div className="mt-2 flex items-center gap-3 text-[11px]">
                <span className="text-gray-500">
                  Pago{' '}
                  <span className="font-semibold text-emerald-700 tabular-nums">
                    {formatCurrency(c.pago / 100)}
                  </span>
                </span>
                <span className="text-gray-500">
                  Planejado{' '}
                  <span className="font-semibold text-amber-700 tabular-nums">
                    {formatCurrency(c.planejado / 100)}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

