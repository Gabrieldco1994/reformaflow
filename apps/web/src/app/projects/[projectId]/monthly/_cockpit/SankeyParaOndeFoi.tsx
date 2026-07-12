"use client";

import { fmtMoney } from "../_cockpit/format";
import type { CategoriaBarra } from "../_cockpit/derive";

/**
 * Sankey "Para onde foi" (inovação #3). Fluxo renda → categorias do mês.
 * A largura de cada fita é proporcional ao valor da categoria sobre o total
 * de entrada — dado 100% já calculado por `deriveMonth`/`CategoriasBarras`,
 * sem lib de Sankey nova (SVG próprio, hand-rolled).
 */
export interface SankeyRibbon {
  categoria: string;
  valor: number;
  cor: string;
  pct: number;
}

export function buildSankeyRibbons(
  categorias: CategoriaBarra[],
  entrouTotal: number,
): SankeyRibbon[] {
  const somaCategorias = categorias.reduce((sum, c) => sum + c.valor, 0);
  const total = entrouTotal > 0 ? entrouTotal : somaCategorias;
  return categorias.map((c) => ({
    categoria: c.categoria,
    valor: c.valor,
    cor: c.cor,
    pct: total > 0 ? c.valor / total : 0,
  }));
}

export default function SankeyParaOndeFoi({
  categorias,
  entrouTotal,
  onSelectCategoria,
}: {
  categorias: CategoriaBarra[];
  entrouTotal: number;
  onSelectCategoria?: (categoria: string) => void;
}) {
  const ribbons = buildSankeyRibbons(categorias, entrouTotal);

  return (
    <section
      aria-label="Para onde foi seu dinheiro este mês"
      className="rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 shadow-lifeone-card"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--ck-text)]">
          Para onde foi
        </h2>
        <span className="text-sm text-[var(--ck-muted)]">
          fluxo Sankey do mês
        </span>
      </div>

      {ribbons.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--ck-muted)]">
          Sem gastos neste período para montar o fluxo.
        </p>
      ) : (
        <>
          <svg
            role="presentation"
            viewBox="0 0 100 12"
            preserveAspectRatio="none"
            className="mt-3 h-6 w-full overflow-hidden rounded-full"
          >
            {(() => {
              let offset = 0;
              return ribbons.map((ribbon) => {
                const width = Math.max(ribbon.pct * 100, ribbon.pct > 0 ? 1 : 0);
                const rect = (
                  <rect
                    key={ribbon.categoria}
                    x={offset}
                    y={0}
                    width={width}
                    height={12}
                    fill={ribbon.cor}
                  />
                );
                offset += width;
                return rect;
              });
            })()}
          </svg>

          <ul className="mt-3 space-y-2">
            {ribbons.map((ribbon) => (
              <li key={ribbon.categoria}>
                <button
                  type="button"
                  onClick={() => onSelectCategoria?.(ribbon.categoria)}
                  className="flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg px-1 text-left text-sm text-[var(--ck-text)] transition-colors hover:bg-[var(--ck-surface-2)]"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: ribbon.cor }}
                    />
                    <span className="truncate">{ribbon.categoria}</span>
                  </span>
                  <span className="shrink-0 font-geist text-base font-semibold tabular-nums text-[var(--ck-text)]">
                    {fmtMoney(ribbon.valor)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
