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
  Copy,
} from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { Expense } from '@/types';
import type { ExpenseCategoryGroup } from '../_hooks/useExpenseFilters';
import { effectiveDate } from '../_lib/grouping-by-month';

interface Props {
  categorias: ExpenseCategoryGroup[];
  collapsedCategories: Set<string>;
  toggleCategory: (tipo: string) => void;
  tipoLabel: (tipo: string) => string;
  openEdit: (expense: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, newStatus: 'PAGO' | 'PLANEJADO') => void;
  onQuickUpdate: (id: string, valor: number, data: string) => void;
  onQuickCreate: (data: {
    tipoDespesa: string;
    valor: number;
    dataPagamento: string;
    status: 'PAGO' | 'PLANEJADO';
  }) => void;
  emptyMsg: string;
}

function CategoryExpenseViewImpl({
  categorias,
  collapsedCategories,
  toggleCategory,
  tipoLabel,
  openEdit,
  onDelete,
  onToggleStatus,
  onQuickUpdate,
  onQuickCreate,
  emptyMsg,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValor, setEditValor] = useState('');
  const [editData, setEditData] = useState('');
  const [addingToCategoria, setAddingToCategoria] = useState<string | null>(null);
  const [newValor, setNewValor] = useState('');
  const [newData, setNewData] = useState('');
  const [newStatus, setNewStatus] = useState<'PAGO' | 'PLANEJADO'>('PLANEJADO');
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyData, setCopyData] = useState('');

  if (categorias.length === 0) {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen px-4 py-8 text-center text-darc-velvet/50 text-sm italic">
        {emptyMsg}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {categorias.map((cat) => {
        const collapsed = collapsedCategories.has(cat.tipo);
        const progressPct = cat.total > 0 ? (cat.totalPago / cat.total) * 100 : 0;

        return (
          <div
            key={cat.tipo}
            className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleCategory(cat.tipo)}
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
                      {cat.label}
                    </span>
                    <span className="text-[10px] text-darc-velvet/50">
                      {cat.expenses.length}{' '}
                      {cat.expenses.length === 1 ? 'item' : 'itens'}
                    </span>
                  </div>

                  {cat.total > 0 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-darc-linen overflow-hidden max-w-[180px]">
                        <div
                          className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(100, progressPct)}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-darc-velvet/60 tabular-nums">
                        {Math.round(progressPct)}% pago
                      </span>
                    </div>
                  )}
                </div>

                <div className="text-right flex-shrink-0">
                  <p className="font-bold text-darc-velvet tabular-nums text-sm">
                    {formatCurrency(cat.total / 100)}
                  </p>
                  <p className="text-[10px] text-darc-velvet/60 tabular-nums mt-0.5">
                    <span className="text-emerald-700">
                      {formatCurrency(cat.totalPago / 100)}
                    </span>
                    {cat.totalPlanejado > 0 && (
                      <>
                        <span className="mx-1 text-darc-velvet/30">·</span>
                        <span className="text-amber-700">
                          {formatCurrency(cat.totalPlanejado / 100)}
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            </button>

            {!collapsed && (
              <div className="divide-y divide-darc-linen border-t border-darc-linen">
                {cat.expenses.map((e) => {
                  const isEditing = editingId === e.id;
                  const isCopying = copyingId === e.id;
                  const dateStr = effectiveDate(e) || '';
                  const parcelas = e.quantidadeParcela ?? 1;
                  const isInstallment =
                    (e.formaPagamento === 'PARCELADO' ||
                      e.formaPagamento === 'QUINZENAL') &&
                    parcelas > 1;

                  return (
                    <div
                      key={e.id}
                      className="px-4 py-2.5 hover:bg-darc-cream/30 transition-colors group"
                    >
                      {isCopying ? (
                        <div className="flex items-center gap-2 bg-blue-50 -mx-4 -my-2.5 px-4 py-2.5">
                          <div className="flex-shrink-0 w-9" />
                          <div className="flex items-center gap-2 flex-1">
                            <span className="text-xs text-blue-700 font-medium flex-shrink-0">
                              Copiar para:
                            </span>
                            <input
                              type="date"
                              value={copyData}
                              onChange={(ev) => setCopyData(ev.target.value)}
                              className="w-36 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                              autoFocus
                            />
                            <span className="text-xs text-darc-velvet/70 truncate">
                              {formatCurrency(e.valorTotal / 100)} ·{' '}
                              {e.titulo || tipoLabel(e.tipoDespesa)}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (copyData) {
                                onQuickCreate({
                                  tipoDespesa: e.tipoDespesa,
                                  valor: e.valorTotal / 100,
                                  dataPagamento: copyData,
                                  status: e.status as 'PAGO' | 'PLANEJADO',
                                });
                                setCopyingId(null);
                                setCopyData('');
                              }
                            }}
                            className="p-1.5 rounded-full hover:bg-blue-200 flex-shrink-0"
                            title="Confirmar cópia"
                          >
                            <Check className="w-4 h-4 text-blue-700" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setCopyingId(null)}
                            className="p-1.5 rounded-full hover:bg-darc-linen/60 flex-shrink-0"
                            title="Cancelar"
                          >
                            <X className="w-4 h-4 text-darc-velvet/60" />
                          </button>
                        </div>
                      ) : isEditing ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-shrink-0 w-9" />
                          <input
                            type="number"
                            step="0.01"
                            value={editValor}
                            onChange={(ev) => setEditValor(ev.target.value)}
                            placeholder="Valor"
                            className="w-24 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                            autoFocus
                          />
                          <input
                            type="date"
                            value={editData}
                            onChange={(ev) => setEditData(ev.target.value)}
                            className="w-32 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const valor = parseFloat(editValor);
                              if (valor && editData) {
                                onQuickUpdate(e.id, valor, editData);
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
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0 w-9 text-center">
                            {dateStr ? (
                              <>
                                <p className="text-[10px] text-darc-velvet/50 uppercase">
                                  {formatDateBR(dateStr).slice(3, 6).replace('/', '')}
                                </p>
                                <p className="text-base font-semibold text-darc-velvet tabular-nums leading-none">
                                  {formatDateBR(dateStr).slice(0, 2)}
                                </p>
                              </>
                            ) : (
                              <p className="text-[10px] text-darc-velvet/40">—</p>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-darc-velvet font-medium truncate">
                              {e.titulo || tipoLabel(e.tipoDespesa)}
                            </p>
                            <div className="mt-0.5 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  const newStatusVal =
                                    e.status === 'PAGO' ? 'PLANEJADO' : 'PAGO';
                                  onToggleStatus(e.id, newStatusVal);
                                }}
                                className="inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 transition-all hover:scale-105 active:scale-95 cursor-pointer"
                                style={{
                                  backgroundColor:
                                    e.status === 'PAGO'
                                      ? 'rgb(209 250 229)'
                                      : 'rgb(254 243 199)',
                                  color:
                                    e.status === 'PAGO'
                                      ? 'rgb(22 101 52)'
                                      : 'rgb(146 64 14)',
                                }}
                                title="Clique para alternar entre Planejado e Pago"
                              >
                                {e.status === 'PAGO' ? (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    <span className="hidden sm:inline font-medium">
                                      Pago
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <Clock className="w-3.5 h-3.5" />
                                    <span className="hidden sm:inline font-medium">
                                      Planejado
                                    </span>
                                  </>
                                )}
                              </button>
                              {e.fornecedor && (
                                <span className="text-[10px] text-darc-velvet/50 truncate">
                                  {e.fornecedor}
                                </span>
                              )}
                              {isInstallment && (
                                <span className="text-[10px] font-medium text-darc-raspberry/80 bg-darc-raspberry/10 rounded-full px-1.5 py-0.5 flex-shrink-0">
                                  {e.formaPagamento === 'QUINZENAL'
                                    ? `${parcelas}x quinzenal`
                                    : `${parcelas}x`}
                                </span>
                              )}
                            </div>
                          </div>

                          <p
                            className={`font-semibold tabular-nums text-sm flex-shrink-0 ${
                              e.status === 'PAGO'
                                ? 'text-darc-velvet'
                                : 'text-darc-velvet/60'
                            }`}
                          >
                            {formatCurrency(e.valorTotal / 100)}
                          </p>

                          <div className="flex items-center gap-0.5 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={() => {
                                setCopyingId(e.id);
                                const cur = new Date(
                                  dateStr || new Date().toISOString().slice(0, 10),
                                );
                                cur.setMonth(cur.getMonth() + 1);
                                setCopyData(cur.toISOString().slice(0, 10));
                              }}
                              aria-label="Copiar despesa"
                              className="p-1.5 rounded-full hover:bg-blue-100"
                              title="Copiar despesa para outra data"
                            >
                              <Copy className="w-3.5 h-3.5 text-blue-600" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(e.id);
                                setEditValor((e.valorTotal / 100).toFixed(2));
                                setEditData((dateStr || '').slice(0, 10));
                              }}
                              aria-label="Editar rápido"
                              className="p-1.5 rounded-full hover:bg-darc-linen/60"
                              title="Edição rápida"
                            >
                              <Pencil className="w-3.5 h-3.5 text-darc-velvet/70" />
                            </button>
                            <button
                              type="button"
                              onClick={() => openEdit(e)}
                              aria-label="Editar completo"
                              className="p-1.5 rounded-full hover:bg-darc-linen/60 hidden md:inline-flex"
                              title="Edição completa"
                            >
                              <Pencil className="w-3.5 h-3.5 text-darc-velvet/40" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDelete(e.id)}
                              aria-label="Excluir"
                              className="p-1.5 rounded-full hover:bg-darc-red-bright/10"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-darc-red" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Linha de adição rápida */}
                {addingToCategoria === cat.tipo ? (
                  <div className="px-4 py-2.5 bg-darc-mist/10 border-t-2 border-darc-mist">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex-shrink-0 w-9" />
                      <input
                        type="number"
                        step="0.01"
                        value={newValor}
                        onChange={(ev) => setNewValor(ev.target.value)}
                        placeholder="Valor (R$)"
                        className="w-28 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                        autoFocus
                      />
                      <input
                        type="date"
                        value={newData}
                        onChange={(ev) => setNewData(ev.target.value)}
                        className="w-36 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      />
                      <span className="flex-1 min-w-[120px] text-xs text-darc-velvet/60 italic truncate">
                        em {cat.label}
                      </span>
                      <select
                        value={newStatus}
                        onChange={(ev) =>
                          setNewStatus(ev.target.value as 'PAGO' | 'PLANEJADO')
                        }
                        className="w-28 border border-darc-mist rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      >
                        <option value="PLANEJADO">Planejado</option>
                        <option value="PAGO">Pago</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const valor = parseFloat(newValor);
                          if (valor && newData) {
                            onQuickCreate({
                              tipoDespesa: cat.tipo,
                              valor,
                              dataPagamento: newData,
                              status: newStatus,
                            });
                            setAddingToCategoria(null);
                            setNewValor('');
                            setNewData('');
                            setNewStatus('PLANEJADO');
                          }
                        }}
                        className="p-1.5 rounded-full hover:bg-emerald-100 flex-shrink-0"
                        title="Salvar"
                      >
                        <Check className="w-4 h-4 text-emerald-700" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddingToCategoria(null)}
                        className="p-1.5 rounded-full hover:bg-darc-linen/60 flex-shrink-0"
                        title="Cancelar"
                      >
                        <X className="w-4 h-4 text-darc-velvet/60" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setAddingToCategoria(cat.tipo);
                      setNewData(new Date().toISOString().slice(0, 10));
                    }}
                    className="w-full px-4 py-2 text-left text-xs text-darc-velvet/50 hover:bg-darc-mist/10 hover:text-darc-velvet transition-colors border-t border-darc-linen"
                  >
                    + Adicionar despesa rápida em {cat.label}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const CategoryExpenseView = React.memo(CategoryExpenseViewImpl);
