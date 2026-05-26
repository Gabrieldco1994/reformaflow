'use client';
import React from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { Receipt } from '@/types';

interface Grupo {
  tipo: string;
  label: string;
  items: Receipt[];
  total: number;
  totalEmCaixa: number;
  totalPrevisto: number;
}

interface Props {
  grouped: Grupo[];
  collapsedTipos: Set<string>;
  toggleTipo: (tipo: string) => void;
  openEdit: (receipt: Receipt) => void;
  onDelete: (id: string) => void;
  emptyMsg: string;
}

function StatusBadgeMobile({ status }: { status: string }) {
  const isCaixa = status === 'EM_CAIXA';
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
        isCaixa
          ? 'bg-darc-mist/40 text-darc-velvet'
          : 'bg-darc-sunfire/20 text-darc-raspberry'
      }`}
    >
      {isCaixa ? 'Em Caixa' : 'Previsto'}
    </span>
  );
}

function MobileReceiptListImpl({
  grouped,
  collapsedTipos,
  toggleTipo,
  openEdit,
  onDelete,
  emptyMsg,
}: Props) {
  const totalItems = grouped.reduce((s, g) => s + g.items.length, 0);

  return (
    <div className="md:hidden space-y-3">
      {grouped.map((g) => {
        const collapsed = collapsedTipos.has(g.tipo);
        return (
          <div
            key={g.tipo}
            className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleTipo(g.tipo)}
              className="w-full flex items-center justify-between px-4 py-3 bg-darc-pink-logo/40 active:bg-darc-pink-logo/70 transition-colors text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                {collapsed ? (
                  <ChevronRight className="w-4 h-4 text-darc-raspberry flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-darc-raspberry flex-shrink-0" />
                )}
                <span className="font-semibold uppercase tracking-[0.15em] text-[11px] text-darc-velvet truncate">
                  {g.label}
                </span>
                <span className="text-[10px] text-darc-raspberry/80 flex-shrink-0">
                  ({g.items.length})
                </span>
              </div>
              <span className="text-sm font-bold text-darc-velvet tabular-nums ml-2">
                {formatCurrency(g.total / 100)}
              </span>
            </button>

            {!collapsed && (
              <div className="divide-y divide-darc-linen">
                {g.items.map((r) => (
                  <div
                    key={r.id}
                    className="px-4 py-3 active:bg-darc-linen/40 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-darc-velvet leading-snug tabular-nums">
                          {formatCurrency(r.valor / 100)}
                        </p>
                        <p className="text-xs text-darc-velvet/60 mt-1 tabular-nums">
                          {r.data
                            ? formatDateBR(r.data)
                            : '—'}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <StatusBadgeMobile status={r.status} />
                      </div>
                    </div>

                    <div className="mt-2 flex items-center gap-1 justify-end">
                      <button
                        type="button"
                        onClick={() => openEdit(r)}
                        aria-label="Editar"
                        className="p-1.5 rounded-full hover:bg-darc-linen/60 active:bg-darc-linen"
                      >
                        <Pencil className="w-4 h-4 text-darc-velvet/70" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(r.id)}
                        aria-label="Excluir"
                        className="p-1.5 rounded-full hover:bg-darc-red-bright/10 active:bg-darc-red-bright/20"
                      >
                        <Trash2 className="w-4 h-4 text-darc-red" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {totalItems === 0 && (
        <div className="text-center text-darc-velvet/50 text-sm py-8 rounded-2xl bg-white shadow-darc-soft border border-darc-linen">
          {emptyMsg}
        </div>
      )}
    </div>
  );
}

export const MobileReceiptList = React.memo(MobileReceiptListImpl);
