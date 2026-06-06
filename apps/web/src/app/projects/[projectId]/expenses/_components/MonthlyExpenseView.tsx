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
import type { GrupoDespesaPorMes } from '../_lib/grouping-by-month';
import { effectiveDate } from '../_lib/grouping-by-month';

interface Props {
  grouped: GrupoDespesaPorMes[];
  collapsedMonths: Set<string>;
  toggleMonth: (key: string) => void;
  tipoLabel: (tipo: string) => string;
  tipoOptions: Array<{ value: string; label: string }>;
  openEdit: (expense: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, newStatus: 'PAGO' | 'PLANEJADO') => void;
  /** Marca/desmarca uma parcela específica (0-based) como paga. */
  onToggleParcela?: (id: string, parcela: number, paid: boolean) => void;
  onQuickUpdate: (id: string, valor: number, data: string) => void;
  onQuickCreate: (data: {
    tipoDespesa: string;
    valor: number;
    dataPagamento: string;
    status: 'PAGO' | 'PLANEJADO';
  }) => void;
  emptyMsg: string;
}

function StatusInline({ status }: { status: string }) {
  if (status === 'PAGO') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] text-darc-velvet/70"
        title="Pago"
      >
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
        <span className="hidden sm:inline">Pago</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-amber-700"
      title="Planejado"
    >
      <Clock className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">Planejado</span>
    </span>
  );
}

function MonthlyExpenseViewImpl({
  grouped,
  collapsedMonths,
  toggleMonth,
  tipoLabel,
  tipoOptions,
  openEdit,
  onDelete,
  onToggleStatus,
  onToggleParcela,
  onQuickUpdate,
  onQuickCreate,
  emptyMsg,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValor, setEditValor] = useState('');
  const [editData, setEditData] = useState('');
  const [addingToMonth, setAddingToMonth] = useState<string | null>(null);
  const [newValor, setNewValor] = useState('');
  const [newData, setNewData] = useState('');
  const [newTipo, setNewTipo] = useState(tipoOptions[0]?.value || '');
  const [newStatus, setNewStatus] = useState<'PAGO' | 'PLANEJADO'>('PLANEJADO');
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyData, setCopyData] = useState('');

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
        const progressPct = g.total > 0 ? (g.totalPago / g.total) * 100 : 0;
        const accent = g.isCurrentMonth
          ? 'border-orange-300 ring-1 ring-orange-200'
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
                      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-500 text-white font-bold">
                        Atual
                      </span>
                    )}
                    <span className="text-[10px] text-darc-velvet/50">
                      {g.items.length}{' '}
                      {g.items.length === 1 ? 'item' : 'itens'}
                    </span>
                  </div>

                  {g.total > 0 && (
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
                    {formatCurrency(g.total / 100)}
                  </p>
                  <p className="text-[10px] text-darc-velvet/60 tabular-nums mt-0.5">
                    <span className="text-emerald-700">
                      {formatCurrency(g.totalPago / 100)}
                    </span>
                    {g.totalPlanejado > 0 && (
                      <>
                        <span className="mx-1 text-darc-velvet/30">·</span>
                        <span className="text-amber-700">
                          {formatCurrency(g.totalPlanejado / 100)}
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            </button>

            {!collapsed && (
              <div className="divide-y divide-darc-linen border-t border-darc-linen">
                {g.items.map((e) => {
                  const isEditing = editingId === e.occKey;
                  const isCopying = copyingId === e.occKey;
                  const dateStr = e.occDate || effectiveDate(e) || '';
                  const origDate = effectiveDate(e) || '';

                  return (
                    <div
                      key={e.occKey}
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
                              {formatCurrency(e.valorTotal / 100)} · {e.titulo || tipoLabel(e.tipoDespesa)}
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
                                  const newStatus = e.status === 'PAGO' ? 'PLANEJADO' : 'PAGO';
                                  if (e.occTotalParcelas > 1 && onToggleParcela) {
                                    onToggleParcela(e.id, e.occIndex - 1, newStatus === 'PAGO');
                                  } else {
                                    onToggleStatus(e.id, newStatus);
                                  }
                                }}
                                className="inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 transition-all hover:scale-105 active:scale-95 cursor-pointer"
                                style={{
                                  backgroundColor: e.status === 'PAGO' ? 'rgb(209 250 229)' : 'rgb(254 243 199)',
                                  color: e.status === 'PAGO' ? 'rgb(22 101 52)' : 'rgb(146 64 14)',
                                }}
                                title="Clique para alternar entre Planejado e Pago"
                              >
                                {e.status === 'PAGO' ? (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                    <span className="hidden sm:inline font-medium">Pago</span>
                                  </>
                                ) : (
                                  <>
                                    <Clock className="w-3.5 h-3.5" />
                                    <span className="hidden sm:inline font-medium">Planejado</span>
                                  </>
                                )}
                              </button>
                              {e.tipoDespesa && (
                                <span className="text-[10px] text-darc-velvet/50 truncate">
                                  {tipoLabel(e.tipoDespesa)}
                                </span>
                              )}
                              {e.occTotalParcelas > 1 && (
                                <span className="text-[10px] font-medium text-darc-raspberry/80 bg-darc-raspberry/10 rounded-full px-1.5 py-0.5 flex-shrink-0">
                                  {e.formaPagamento === 'QUINZENAL' ? 'quinzena' : 'parcela'} {e.occIndex}/{e.occTotalParcelas}
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
                            {formatCurrency(e.occValue / 100)}
                          </p>

                          <div className="flex items-center gap-0.5 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={() => {
                                setCopyingId(e.occKey);
                                const cur = new Date(dateStr || new Date().toISOString().slice(0, 10));
                                cur.setMonth(cur.getMonth() + 1);
                                setCopyData(cur.toISOString().slice(0, 10));
                              }}
                              aria-label="Copiar para outro mês"
                              className="p-1.5 rounded-full hover:bg-blue-100"
                              title="Copiar para outro mês"
                            >
                              <Copy className="w-3.5 h-3.5 text-blue-600" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(e.occKey);
                                setEditValor((e.valorTotal / 100).toFixed(2));
                                setEditData((origDate || '').slice(0, 10));
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
                {g.mesKey !== 'sem-data' && (addingToMonth === g.mesKey ? (
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
                      <select
                        value={newTipo}
                        onChange={(ev) => setNewTipo(ev.target.value)}
                        className="flex-1 min-w-[140px] border border-darc-mist rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      >
                        {tipoOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <select
                        value={newStatus}
                        onChange={(ev) => setNewStatus(ev.target.value as 'PAGO' | 'PLANEJADO')}
                        className="w-28 border border-darc-mist rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      >
                        <option value="PLANEJADO">Planejado</option>
                        <option value="PAGO">Pago</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const valor = parseFloat(newValor);
                          if (valor && newData && newTipo) {
                            onQuickCreate({
                              tipoDespesa: newTipo,
                              valor,
                              dataPagamento: newData,
                              status: newStatus,
                            });
                            setAddingToMonth(null);
                            setNewValor('');
                            setNewData('');
                            setNewTipo(tipoOptions[0]?.value || '');
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
                        onClick={() => setAddingToMonth(null)}
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
                      setAddingToMonth(g.mesKey);
                      setNewData(`${g.mesKey}-01`);
                    }}
                    className="w-full px-4 py-2 text-left text-xs text-darc-velvet/50 hover:bg-darc-mist/10 hover:text-darc-velvet transition-colors border-t border-darc-linen"
                  >
                    + Adicionar despesa rápida neste mês
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const MonthlyExpenseView = React.memo(MonthlyExpenseViewImpl);
