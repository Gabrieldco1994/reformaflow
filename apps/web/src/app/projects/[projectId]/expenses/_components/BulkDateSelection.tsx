'use client';
import React, { createContext, useContext } from 'react';
import {
  ListChecks,
  CheckSquare,
  Square,
  CalendarClock,
  Check,
  X,
} from 'lucide-react';

interface BulkDateCtx {
  selectMode: boolean;
  selectedIds: Set<string>;
  toggle: (id: string) => void;
}

const Ctx = createContext<BulkDateCtx | null>(null);

export function BulkDateProvider({
  value,
  children,
}: {
  value: BulkDateCtx;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBulkDate(): BulkDateCtx | null {
  return useContext(Ctx);
}

/**
 * Checkbox de seleção exibido por cada linha de despesa. Renderiza nada quando
 * não há provider ativo ou quando o modo de seleção está desligado.
 */
export function BulkCheckbox({ id }: { id: string }) {
  const ctx = useBulkDate();
  if (!ctx || !ctx.selectMode) return null;
  const checked = ctx.selectedIds.has(id);
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        ctx.toggle(id);
      }}
      className="flex-shrink-0 p-0.5 text-violet-600 hover:text-violet-800"
      aria-label={checked ? 'Desmarcar' : 'Marcar'}
    >
      {checked ? (
        <CheckSquare className="w-4 h-4" />
      ) : (
        <Square className="w-4 h-4 text-darc-velvet/40" />
      )}
    </button>
  );
}

/**
 * Barra de ações para alterar a data de várias despesas de uma vez. Fica no
 * topo da lista (visões Geral, Mês e Categoria).
 */
export function BulkDateToolbar({
  selectMode,
  onEnter,
  onExit,
  selectedCount,
  allSelected,
  onToggleAll,
  bulkDate,
  onBulkDateChange,
  onApply,
}: {
  selectMode: boolean;
  onEnter: () => void;
  onExit: () => void;
  selectedCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  bulkDate: string;
  onBulkDateChange: (v: string) => void;
  onApply: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-violet-200 bg-violet-50/90 px-3 py-2 backdrop-blur">
      {!selectMode ? (
        <button
          type="button"
          onClick={onEnter}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-white px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
        >
          <ListChecks className="w-3.5 h-3.5" /> Selecionar para alterar data
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={onToggleAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-white px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
          >
            {allSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
            {allSelected ? 'Limpar' : 'Selecionar tudo'}
          </button>
          <span className="text-xs font-semibold text-violet-800">
            {selectedCount} {selectedCount === 1 ? 'selecionada' : 'selecionadas'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-violet-600" />
            <input
              type="date"
              value={bulkDate}
              onChange={(ev) => onBulkDateChange(ev.target.value)}
              className="w-36 rounded border border-violet-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
            />
            <button
              type="button"
              onClick={onApply}
              disabled={!bulkDate || selectedCount === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Check className="w-3.5 h-3.5" /> Aplicar data
            </button>
            <button
              type="button"
              onClick={onExit}
              className="p-1.5 rounded-full hover:bg-violet-100"
              title="Cancelar seleção"
            >
              <X className="w-4 h-4 text-violet-700" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
