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
import { centsToReaisInput, currencyInputToNumber, maskCurrencyInput } from '@/lib/currency-input';
import type { Receipt } from '@/types';
import type { GrupoPorMes } from '../_types';

interface Props {
  grouped: GrupoPorMes[];
  collapsedMonths: Set<string>;
  toggleMonth: (key: string) => void;
  tipoLabel: (tipo: string) => string;
  tipoOptions: Array<{ value: string; label: string }>;
  openEdit: (receipt: Receipt) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, newStatus: 'EM_CAIXA' | 'PREVISTO') => void;
  onQuickUpdate: (id: string, valor: number, data: string) => void;
  onQuickCreate: (valor: number, data: string, tipo: string, status: string) => void;
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
  tipoOptions,
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
  const [addingToMonth, setAddingToMonth] = useState<string | null>(null);
  const [newValor, setNewValor] = useState('');
  const [newData, setNewData] = useState('');
  const [newTipo, setNewTipo] = useState(tipoOptions[0]?.value || '');
  const [newStatus, setNewStatus] = useState('PREVISTO');
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
                  const isCopying = copyingId === r.id;
                  const canEdit = !r.id.startsWith('alloc-');

                  return (
                    <div
                      key={r.id}
                      className="px-4 py-2.5 hover:bg-darc-cream/30 transition-colors group"
                    >
                      {isCopying ? (
                        // Modo de cópia - apenas altera a data
                        <div className="flex items-center gap-2 bg-blue-50 -mx-4 -my-2.5 px-4 py-2.5">
                          <div className="flex-shrink-0 w-9" />
                          <div className="flex items-center gap-2 flex-1">
                            <span className="text-xs text-blue-700 font-medium flex-shrink-0">
                              Copiar para:
                            </span>
                            <input
                              type="date"
                              value={copyData}
                              onChange={(e) => setCopyData(e.target.value)}
                              className="w-36 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                              autoFocus
                            />
                            <span className="text-xs text-darc-velvet/70">
                              {formatCurrency(r.valor / 100)} · {tipoLabel(r.tipo)}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (copyData) {
                                onQuickCreate(r.valor / 100, copyData, r.tipo, r.status);
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
                        // Modo de edição inline
                        <div className="flex items-center gap-2">
                          <div className="flex-shrink-0 w-9" />
                          <input
                            type="text"
                            inputMode="numeric"
                            value={editValor}
                            onChange={(e) => setEditValor(maskCurrencyInput(e.target.value))}
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
                              const valor = currencyInputToNumber(editValor);
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
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const newStatus = r.status === 'EM_CAIXA' ? 'PREVISTO' : 'EM_CAIXA';
                                    onToggleStatus(r.id, newStatus);
                                  }}
                                  className="inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-0.5 transition-all hover:scale-105 active:scale-95 cursor-pointer"
                                  style={{
                                    backgroundColor: r.status === 'EM_CAIXA' ? 'rgb(209 250 229)' : 'rgb(254 242 242)',
                                    color: r.status === 'EM_CAIXA' ? 'rgb(22 101 52)' : 'rgb(153 27 27)',
                                  }}
                                  title="Clique para alternar entre Previsto e Recebido"
                                >
                                  {r.status === 'EM_CAIXA' ? (
                                    <>
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline font-medium">Recebido</span>
                                    </>
                                  ) : (
                                    <>
                                      <Clock className="w-3.5 h-3.5" />
                                      <span className="hidden sm:inline font-medium">Previsto</span>
                                    </>
                                  )}
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
                                    setCopyingId(r.id);
                                    // Sugere próximo mês
                                    const currentDate = new Date(r.data);
                                    currentDate.setMonth(currentDate.getMonth() + 1);
                                    setCopyData(currentDate.toISOString().slice(0, 10));
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
                                    setEditingId(r.id);
                                    setEditValor(centsToReaisInput(r.valor));
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
                
                {/* Linha de adição rápida */}
                {addingToMonth === g.mesKey ? (
                  <div className="px-4 py-2.5 bg-darc-mist/10 border-t-2 border-darc-mist">
                    <div className="flex items-center gap-2">
                      <div className="flex-shrink-0 w-9" />
                      <input
                        type="text"
                        inputMode="numeric"
                        value={newValor}
                        onChange={(e) => setNewValor(maskCurrencyInput(e.target.value))}
                        placeholder="Valor (R$)"
                        className="w-28 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                        autoFocus
                      />
                      <input
                        type="date"
                        value={newData}
                        onChange={(e) => setNewData(e.target.value)}
                        className="w-36 border border-darc-mist rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      />
                      <select
                        value={newTipo}
                        onChange={(e) => setNewTipo(e.target.value)}
                        className="flex-1 border border-darc-mist rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      >
                        {tipoOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <select
                        value={newStatus}
                        onChange={(e) => setNewStatus(e.target.value)}
                        className="w-28 border border-darc-mist rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-darc-mist"
                      >
                        <option value="PREVISTO">Previsto</option>
                        <option value="EM_CAIXA">Em Caixa</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const valor = currencyInputToNumber(newValor);
                          if (valor && newData && newTipo) {
                            onQuickCreate(valor, newData, newTipo, newStatus);
                            setAddingToMonth(null);
                            setNewValor('');
                            setNewData('');
                            setNewTipo(tipoOptions[0]?.value || '');
                            setNewStatus('PREVISTO');
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
                    + Adicionar recebimento rápido neste mês
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

export const MonthlyView = React.memo(MonthlyViewImpl);
