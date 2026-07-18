'use client';
import React from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { getExpenseIcon } from '@/lib/expense-icons';
import type { Expense } from '@/types';
import { StatusBadge } from './StatusBadge';

interface Categoria {
  tipo: string;
  label: string;
  expenses: Expense[];
  total: number;
  totalPlanejado: number;
  totalPago: number;
}

interface Props {
  categorias: Categoria[];
  collapsedCategories: Set<string>;
  toggleCategory: (cat: string) => void;
  tipoLabel: (t: string) => string;
  formaLabel: (f: string) => string;
  catMaoLabel: (c: string) => string;
  openEdit: (exp: Expense) => void;
  onDelete: (id: string) => void;
  totalGeral: number;
  hasActiveFilters: boolean;
  emptyMsg: string;
}

function MobileExpenseListImpl({
  categorias,
  collapsedCategories,
  toggleCategory,
  tipoLabel,
  formaLabel,
  catMaoLabel,
  openEdit,
  onDelete,
  totalGeral,
  hasActiveFilters,
  emptyMsg,
}: Props) {
  const totalItems = categorias.reduce((sum, c) => sum + c.expenses.length, 0);

  return (
    <div className="md:hidden space-y-3">
      {categorias.map((cat) => {
        const collapsed = collapsedCategories.has(cat.tipo);
        return (
          <div key={cat.tipo} className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen overflow-hidden">
            <button
              type="button"
              onClick={() => toggleCategory(cat.tipo)}
              className="w-full flex items-center justify-between px-4 py-3 bg-darc-pink-logo/40 active:bg-darc-pink-logo/70 transition-colors text-left"
            >
              <div className="flex items-center gap-2 min-w-0">
                {collapsed ? (
                  <ChevronRight className="w-4 h-4 text-darc-raspberry flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-darc-raspberry flex-shrink-0" />
                )}
                <span className="font-semibold uppercase tracking-[0.15em] text-[11px] text-darc-velvet truncate">
                  {cat.label}
                </span>
                <span className="text-[10px] text-darc-raspberry/80 flex-shrink-0">({cat.expenses.length})</span>
              </div>
              <span className="text-sm font-bold text-darc-velvet tabular-nums ml-2">
                {formatCurrency(cat.total / 100)}
              </span>
            </button>

            {!collapsed && (
              <div className="divide-y divide-darc-linen">
                {cat.expenses.map((exp) => {
                  const totalParcelas = exp.quantidadeParcela ?? 0;
                  const dataExibir = exp.dataInicioParcela
                    ? `1ª ${formatDateBR(exp.dataInicioParcela)}`
                    : exp.dataPagamento
                    ? formatDateBR(exp.dataPagamento)
                    : null;
                  return (
                    <div key={exp.id} className="px-4 py-3 active:bg-darc-linen/40 transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {(() => {
                              const { Icon, color } = getExpenseIcon(exp.tipoDespesa);
                              return <Icon className={`w-3.5 h-3.5 ${color} shrink-0`} />;
                            })()}
                            <p className="font-medium text-darc-velvet leading-snug truncate">
                              {exp.titulo || tipoLabel(exp.tipoDespesa)}
                            </p>
                          </div>
                          {exp.tipoDespesa === 'MAO_DE_OBRA' && exp.categoriaMaoDeObra && (
                            <span className="inline-block mt-1 text-[10px] text-darc-velvet bg-darc-mist/40 px-2 py-0.5 rounded-full">
                              {catMaoLabel(exp.categoriaMaoDeObra)}
                            </span>
                          )}
                          {(exp.fornecedor || exp.room?.name) && (
                            <p className="text-xs text-darc-velvet/60 mt-1 truncate">
                              {exp.fornecedor || '—'}
                              {exp.room?.name ? ` · ${exp.room.name}` : ''}
                            </p>
                          )}
                          {(exp.cardLast4 || exp.bankLast4) && (
                            <p className="text-[10px] text-darc-velvet/50 mt-0.5">
                              {exp.cardLast4 && `💳 ••${exp.cardLast4}`}
                              {exp.bankLast4 && `🏦 ••${exp.bankLast4}`}
                            </p>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-sm font-bold text-darc-velvet tabular-nums">
                            {formatCurrency(exp.valorTotal / 100)}
                          </p>
                          {exp.quantidade > 1 && (
                            <p className="text-[10px] text-darc-velvet/50 tabular-nums">
                              {exp.quantidade}× {formatCurrency(exp.valor / 100)}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 flex items-center flex-wrap gap-2">
                        <StatusBadge status={exp.status} />
                        <span className="text-[10px] text-darc-velvet/70 bg-darc-linen/60 px-2 py-0.5 rounded-full">
                          {formaLabel(exp.formaPagamento)}
                        </span>
                        {totalParcelas > 1 && (
                          <span className="text-[10px] font-bold text-darc-velvet bg-darc-pink-logo/60 px-2 py-0.5 rounded-full">
                            {totalParcelas}×
                          </span>
                        )}
                        {dataExibir && (
                          <span className="text-[10px] text-darc-velvet/60 tabular-nums">
                            {dataExibir}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(exp)}
                            aria-label="Editar"
                            className="p-1.5 rounded-full hover:bg-darc-linen/60 active:bg-darc-linen"
                          >
                            <Pencil className="w-4 h-4 text-darc-velvet/70" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(exp.id)}
                            aria-label="Excluir"
                            className="p-1.5 rounded-full hover:bg-darc-red-bright/10 active:bg-darc-red-bright/20"
                          >
                            <Trash2 className="w-4 h-4 text-darc-red" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {totalItems === 0 && (
        <div className="text-center text-darc-velvet/50 text-sm py-8 rounded-2xl bg-white shadow-darc-soft border border-darc-linen">
          {hasActiveFilters ? 'Nenhuma despesa com esses filtros.' : emptyMsg}
        </div>
      )}

      {totalItems > 0 && (
        <div className="flex items-center justify-between rounded-2xl bg-darc-velvet text-darc-linen px-4 py-3 shadow-darc-soft">
          <span className="text-[10px] uppercase tracking-[0.2em] text-darc-linen/80">Total geral</span>
          <span className="text-base font-bold tabular-nums">{formatCurrency(totalGeral / 100)}</span>
        </div>
      )}
    </div>
  );
}

export const MobileExpenseList = React.memo(MobileExpenseListImpl);
