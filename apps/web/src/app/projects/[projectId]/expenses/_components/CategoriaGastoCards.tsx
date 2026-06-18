'use client';
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
 * Substitui a antiga quebra "Por projeto". Mostra, por tipo de despesa, o total
 * do período com a divisão pago/planejado.
 */
export function CategoriaGastoCards({
  categorias,
  tipoLabel,
}: {
  categorias: CategoriaGasto[];
  tipoLabel: (t: string) => string;
}) {
  if (categorias.length === 0) return null;
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        Gastos por categoria no mês
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
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
    </section>
  );
}
