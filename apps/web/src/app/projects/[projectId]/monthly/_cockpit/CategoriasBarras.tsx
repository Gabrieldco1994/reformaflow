'use client';

import { Card } from './ui';
import { fmtMoney } from './format';
import type { CategoriaBarra } from './derive';

export default function CategoriasBarras({
  categorias,
  title = 'Principais gastos',
  hint,
  columns = 1,
  headerExtra,
  onCategoryClick,
}: {
  categorias: CategoriaBarra[];
  title?: string;
  hint?: string;
  /** Nº de colunas no layout (para listas longas em seção larga). */
  columns?: 1 | 2 | 3;
  /** Controle extra no header (ex.: toggle Realizado/Planejado). */
  headerExtra?: React.ReactNode;
  /** Se definido, cada categoria vira clicável (abre o pop-up de despesas). */
  onCategoryClick?: (categoria: string) => void;
}) {
  const total = categorias.reduce((s, c) => s + c.valor, 0);
  const gridCls =
    columns === 3
      ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3'
      : columns === 2
        ? 'grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3'
        : 'space-y-3';
  return (
    <Card
      title={title}
      hint={
        headerExtra ? (
          <span className="flex items-center gap-2">
            {hint && <span className="text-[10px] text-[var(--ck-muted)]">{hint}</span>}
            {headerExtra}
          </span>
        ) : (
          hint
        )
      }
    >
      {categorias.length === 0 ? (
        <p className="text-xs text-[var(--ck-muted)]">Sem gastos por categoria neste período.</p>
      ) : (
        <div className={gridCls}>
          {categorias.map((c) => {
            const clickable = !!onCategoryClick;
            const Row = (
              <>
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
              </>
            );
            return clickable ? (
              <button
                key={c.categoria}
                type="button"
                onClick={() => onCategoryClick!(c.categoria)}
                className="block w-full text-left rounded-lg -mx-1 px-1 py-0.5 transition-colors hover:bg-[var(--ck-surface-2)]"
                title={`Ver despesas de ${c.categoria}`}
              >
                {Row}
              </button>
            ) : (
              <div key={c.categoria}>{Row}</div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
