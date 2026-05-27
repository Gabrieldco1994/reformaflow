'use client';
import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  CheckCircle2,
  Clock,
  Check,
  X,
} from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { Receipt } from '@/types';
import type { GrupoPorMes } from '../_types';

interface Props {
  grouped: GrupoPorMes[];
  collapsedMonths: Set<string>;
  toggleMonth: (key: string) => void;
  tipoLabel: (tipo: string) => string;
  openEdit: (receipt: Receipt) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, newStatus: 'EM_CAIXA' | 'PREVISTO') => void;
  onQuickUpdate: (id: string, valor: number, data: string) => void;
  emptyMsg: string;
}

function StatusInline({ status }: { status: string }) {
  if (status === 'EM_CAIXA') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] text-darc-velvet/70"
        title="Em caixa"
      >
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
        <span className="hidden sm:inline">Recebido</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-darc-raspberry"
      title="Previsto"
    >
      <Clock className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">Previsto</span>
    </span>
  );
}

function MonthlyViewImpl({
  grouped,
  collapsedMonths,
  toggleMonth,
  tipoLabel,
  openEdit,
  onDelete,
  onToggleStatus,
  onQuickUpdate,
  emptyMsg,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValor, setEditValor] = useState('');
  const [editData, setEditData] = useState('');
  if (grouped.length === 0) {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen px-4 py-8 text-center text-darc-velvet/50 text-sm italic">
        {emptyMsg}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {grouped.map((g) => {
        const collapsed = collapsedMonths.has(g.mesKey);
        const progressPct =
          g.total > 0 ? (g.totalEmCaixa / g.total) * 100 : 0;
        const accent = g.isCurrentMonth
          ? 'border-darc-velvet/30 ring-1 ring-darc-velvet/10'
          : g.isFuture
            ? 'border-darc-linen'
            : 'border-darc-linen opacity-90';

        return (
          <div
            key={g.mesKey}
            className={`rounded-2xl bg-white shadow-darc-soft border overflow-hidden ${accent}`}
          >
            <button
              type="button"
              onClick={() => toggleMonth(g.mesKey)}
              className="w-full text-left px-4 py-3 hover:bg-darc-cream/30 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0 text-darc-raspberry">
                  {collapsed ? (
                    <ChevronRight className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-semibold text-darc-velvet capitalize">
                      {g.mesLabel}
                    </span>
                    {g.isCurrentMonth && (
                      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-darc-velvet text-white font-bold">
                        Atual
                      </span>
                    )}
                    <span className="text-[10px] text-darc-velvet/50">
                      {g.items.length}{' '}
                      {g.items.length === 1 ? 'item' : 'itens'}
                    </span>
                  </div>

                  {/* Barra de progresso compacta */}
                  {g.total > 0 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-darc-linen overflow-hidden max-w-[180px]">
                        <div
                          className="h-full bg-darc-velvet/70 rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.min(100, progressPct)}%`,
                          }}
                        />
                      </div>
                      <span className="text-[10px] text-darc-velvet/60 tabular-nums">
                        {Math.round(progressPct)}%
                      </span>
                    </div>
                  )}
                </div>

                <div className="text-right flex-shrink-0">
                  <p className="font-bold text-darc-velvet tabular-nums text-sm">
                    {formatCurrency(g.total / 100)}
                  </p>
                  <p className="text-[10px] text-darc-velvet/60 tabular-nums mt-0.5">
                    <span className="text-emerald-700">
                      {formatCurrency(g.totalEmCaixa / 100)}
                    </span>
                    {g.totalPrevisto > 0 && (
                      <>
                        <span className="mx-1 text-darc-velvet/30">·</span>
                        <span className="text-darc-raspberry">
                          {formatCurrency(g.totalPrevisto / 100)}
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            </button>

            {!collapsed && (
              <div className="divide-y divide-darc-linen border-t border-darc-linen">
                {g.items.map((r) => {
                  const isEditing = editingId === r.id;
                  const canEdit = !r.id.startsWith('alloc-');

                  return (
                    <div
                      key={r.id}
                      className="px-4 py-2.5 hover:bg-darc-cream/30 transition-colors group"
                    >
                      {isEditing ? (
                        // Modo de edição inline
                        <div className="flex items-center gap-2">
                          <div className="flex-shrink-0 w-9" />
                          <input
                            type="number"
                            step="0.01"
                            value={editValor}
                            onChange={(e) => setEditValor(e.target.value)}
                            placeholder="Valor"
                            className="w-24 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                            autoFocus
                          />
                          <input
                            type="date"
                            value={editData}
                            onChange={(e) => setEditData(e.target.value)}
                            className="w-32 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const valor = parseFloat(editValor);
                              if (valor && editData) {
                                onQuickUpdate(r.id, valor, editData);
                                setEditingId(null);
                              }
                            }}
                            className="p-1.5 rounded-full hover:bg-emerald-100"
                            title="Salvar"
                          >
                            <Check className="w-4 h-4 text-emerald-700" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="p-1.5 rounded-full hover:bg-darc-linen/60"
                            title="Cancelar"
                          >
                            <X className="w-4 h-4 text-darc-velvet/60" />
                          </button>
                        </div>
                      ) : (
                        // Modo de visualização normal
                        <div className="flex items-center gap-3">
                          {/* Dia (apenas o número) */}
                          <div className="flex-shrink-0 w-9 text-center">
                            <p className="text-[10px] text-darc-velvet/50 uppercase">
                              {formatDateBR(r.data).slice(3, 6).replace('/', '')}
                            </p>
                            <p className="text-base font-semibold text-darc-velvet tabular-nums leading-none">
                              {formatDateBR(r.data).slice(0, 2)}
                            </p>
                          </div>

                          {/* Tipo + Status (clicável para toggle) */}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-darc-velvet font-medium truncate">
                              {tipoLabel(r.tipo)}
                            </p>
                            <div className="mt-0.5">
                              {canEdit ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const newStatus = r.status === 'EM_CAIXA' ? 'PREVISTO' : 'EM_CAIXA';
                                    onToggleStatus(r.id, newStatus);
                                  }}
                                  className="hover:opacity-70 transition-opacity"
                                  title="Clique para alternar status"
                                >
                                  <StatusInline status={r.status} />
                                </button>
                              ) : (
                                <StatusInline status={r.status} />
                              )}
                            </div>
                          </div>

                          {/* Valor */}
                          <p
                            className={`font-semibold tabular-nums text-sm flex-shrink-0 ${
                              r.status === 'EM_CAIXA'
                                ? 'text-darc-velvet'
                                : 'text-darc-velvet/60'
                            }`}
                          >
                            {formatCurrency(r.valor / 100)}
                          </p>

                          {/* Ações (escondem em hover) */}
                          <div className="flex items-center gap-0.5 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                            {canEdit && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingId(r.id);
                                    setEditValor((r.valor / 100).toFixed(2));
                                    setEditData(r.data.slice(0, 10));
                                  }}
                                  aria-label="Editar rápido"
                                  className="p-1.5 rounded-full hover:bg-darc-linen/60"
                                  title="Edição rápida"
                                >
                                  <Pencil className="w-3.5 h-3.5 text-darc-velvet/70" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onDelete(r.id)}
                                  aria-label="Excluir"
                                  className="p-1.5 rounded-full hover:bg-darc-red-bright/10"
                                >
                                  <Trash2 className="w-3.5 h-3.5 text-darc-red" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const MonthlyView = React.memo(MonthlyViewImpl);
