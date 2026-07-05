'use client';

import { Card } from './ui';
import { fmtMoney } from './format';
import type { CategoriaBarra } from './derive';

export default function CategoriasBarras({
  categorias,
  title = 'Principais gastos',
  hint,
}: {
  categorias: CategoriaBarra[];
  title?: string;
  hint?: string;
}) {
  const total = categorias.reduce((s, c) => s + c.valor, 0);
  return (
    <Card title={title} hint={hint}>
      {categorias.length === 0 ? (
        <p className="text-xs text-[var(--ck-muted)]">Sem gastos por categoria neste período.</p>
      ) : (
        <div className="space-y-3">
          {categorias.map((c) => (
            <div key={c.categoria}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-xs text-[var(--ck-text)] flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: c.cor }} />
                  {c.categoria}
                </span>
                <span className="text-xs font-geist tabular-nums text-[var(--ck-muted)]">
                  {c.media != null && c.media > 0 && (
                    <span className="mr-2 text-[10px] text-[var(--ck-muted)]/80">
                      ~{fmtMoney(c.media)}/mês
                    </span>
                  )}
                  {fmtMoney(c.valor)}
                  {total > 0 && <span className="ml-1 text-[10px]">({Math.round((c.valor / total) * 100)}%)</span>}
                </span>
              </div>
              <div className="h-2 rounded-full bg-[var(--ck-surface-2)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${Math.max(2, c.pct * 100)}%`, background: c.cor }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
