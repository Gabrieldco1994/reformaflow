'use client';

import { formatCurrency } from '@/lib/utils';
import type { MonthlyOverviewRow } from '../_types';

interface Props {
  current: MonthlyOverviewRow | null;
}

export default function TopCategoriasCard({ current }: Props) {
  const top = current?.porCategoria ?? [];
  const max = top[0]?.valor ?? 1;

  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
      <h3 className="text-sm font-semibold text-darc-velvet mb-3">
        Maiores categorias do mês
      </h3>
      {top.length === 0 ? (
        <p className="text-xs text-darc-velvet/60">Nenhuma despesa neste mês.</p>
      ) : (
        <ul className="space-y-3">
          {top.map((c) => {
            const widthPct = Math.max(2, Math.round((c.valor / max) * 100));
            return (
              <li key={c.categoria}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-medium text-darc-velvet truncate">{c.categoria}</span>
                  <span className="tabular-nums text-darc-velvet/70">{formatCurrency(c.valor / 100)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-darc-linen overflow-hidden">
                  <div
                    className="h-full bg-darc-raspberry rounded-full transition-all"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
