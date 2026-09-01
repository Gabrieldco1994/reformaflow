'use client';

import { formatCurrency } from '@/lib/utils';
import { typeAccent } from '../../../_components/type-accent';
import type { ByTypeGroup } from '../_lib/by-type';

/**
 * U6b build 1 (#456) — visão "Por tipo" da Conta. Card por `project.type`
 * (grupo já vem pronto de `buildByTypeGroups`; este componente só renderiza).
 * PLANTAS aparece sempre como "sem financeiro" (`hasFinance: false`), nunca
 * com movimento fabricado. Reaproveita `typeAccent` (mesma fonte de
 * cor/rótulo/ícone usada em `/projects`), em vez de reinventar um mapa local.
 */
export function PorTipoView({
  groups,
  selectedType,
  onSelectType,
}: {
  groups: ByTypeGroup[];
  /** `?tipo=` da URL. Desconhecido → estado vazio seguro (nunca erro/fetch). */
  selectedType?: string | null;
  /** Clique no card seleciona (drill); `null` volta para "todos os tipos". */
  onSelectType: (type: string | null) => void;
}) {
  const visible = selectedType ? groups.filter((g) => g.type === selectedType) : groups;

  if (selectedType && visible.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-lifeone-hairline bg-lifeone-card p-8 text-center text-sm text-lifeone-ink-3">
        Nenhum tipo encontrado com esses filtros.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {selectedType && (
        <button
          type="button"
          onClick={() => onSelectType(null)}
          className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm font-medium text-lifeone-ink-2 transition hover:border-lifeone-blue md:h-9"
        >
          Ver todos os tipos
        </button>
      )}
      {visible.map((g) => {
        const accent = typeAccent(g.type);
        const Icon = accent.icon;
        return (
          <div
            key={g.type}
            className="overflow-hidden rounded-2xl border-2 bg-lifeone-card"
            style={{ borderColor: accent.color }}
          >
            <button
              type="button"
              disabled={!g.hasFinance || !!selectedType}
              onClick={() => (g.hasFinance ? onSelectType(g.type) : undefined)}
              className={`flex min-h-[44px] w-full items-center gap-2 px-4 py-3 text-left transition ${
                g.hasFinance ? 'hover:bg-lifeone-sidebar' : 'cursor-default'
              }`}
              title={g.hasFinance ? 'Ver lançamentos deste tipo' : 'Este tipo não tem financeiro'}
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: accent.fill, color: accent.color }}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-lifeone-ink">
                {accent.label}
                {!g.hasFinance && (
                  <span className="ml-2 text-[11px] font-medium text-lifeone-ink-3">
                    Sem financeiro
                  </span>
                )}
                {g.hasFinance && (
                  <span className="ml-2 text-[11px] font-medium text-lifeone-ink-3">
                    {g.count} lançamento{g.count === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              {g.hasFinance && (
                <span className="ml-auto whitespace-nowrap text-sm font-bold tabular-nums font-geist text-lifeone-ink">
                  {formatCurrency(g.total / 100)}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
