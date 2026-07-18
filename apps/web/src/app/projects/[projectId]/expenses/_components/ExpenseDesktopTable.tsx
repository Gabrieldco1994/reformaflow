import React from 'react';
import { Pencil, Trash2, ChevronDown, ChevronRight, ExternalLink, Check, X } from 'lucide-react';
import { buildInstallments, isSinglePaymentForm } from '@reformaflow/domain';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import {
  CATEGORIA_MAO_DE_OBRA_OPTIONS,
  FORMA_PAGAMENTO_OPTIONS,
  catMaoLabel,
  formaLabel,
  tipoLabel,
} from '@/lib/expense-options';
import { getExpenseIcon } from '@/lib/expense-icons';
import type { Expense } from '@/types';
import { StatusBadge } from './StatusBadge';
import type { ExpenseCategoryGroup } from '../_hooks/useExpenseFilters';
import type { InlineNewRow } from '../_types';
import { maskReaisInput, reaisToCents } from '../_lib/money';

interface ExpenseOption {
  value: string;
  label: string;
}

interface RoomOption {
  value: string;
  label: string;
}

interface ExpenseDesktopTableProps {
  categorias: ExpenseCategoryGroup[];
  filteredExpenses: Expense[];
  collapsedCategories: Set<string>;
  toggleCategory: (tipo: string) => void;
  expandedExpenses: Set<string>;
  toggleExpand: (id: string) => void;
  showRooms: boolean;
  colSpan: number;
  totalGeral: number;
  hasActiveFilters: boolean;

  // Row actions
  openInlineEdit: (exp: Expense) => void;
  openEdit: (exp: Expense) => void;
  onDelete: (id: string) => void;

  // Inline edit state
  editingInlineId: string | null;
  editingInlineRow: InlineNewRow;
  setEditingInlineRow: (row: InlineNewRow) => void;
  handleInlineUpdateSubmit: () => void;
  closeInlineEdit: () => void;
  inlineEditKeyDown: (e: React.KeyboardEvent) => void;

  // Inline new row state
  showNewRow: boolean;
  setShowNewRow: (v: boolean) => void;
  newRow: InlineNewRow;
  setNewRow: (row: InlineNewRow) => void;
  handleInlineSubmit: () => void;
  inlineKeyDown: (e: React.KeyboardEvent) => void;

  tipoDespesaOptions: ExpenseOption[];
  roomOptions: RoomOption[];
}

export function ExpenseDesktopTable({
  categorias,
  filteredExpenses,
  collapsedCategories,
  toggleCategory,
  expandedExpenses,
  toggleExpand,
  showRooms,
  colSpan,
  totalGeral,
  hasActiveFilters,
  openInlineEdit,
  openEdit,
  onDelete,
  editingInlineId,
  editingInlineRow,
  setEditingInlineRow,
  handleInlineUpdateSubmit,
  closeInlineEdit,
  inlineEditKeyDown,
  showNewRow,
  setShowNewRow,
  newRow,
  setNewRow,
  handleInlineSubmit,
  inlineKeyDown,
  tipoDespesaOptions,
  roomOptions,
}: ExpenseDesktopTableProps) {
  return (
    <div className="hidden md:block border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="w-8 px-2 py-2" />
              <th className="text-left px-2 py-2 font-medium text-gray-600">Título</th>
              <th className="text-left px-2 py-2 font-medium text-gray-600">Fornecedor</th>
              {showRooms && <th className="text-left px-2 py-2 font-medium text-gray-600">Ambiente</th>}
              <th className="text-right px-2 py-2 font-medium text-gray-600">Valor Unit.</th>
              <th className="text-right px-2 py-2 font-medium text-gray-600">Qtd</th>
              <th className="text-right px-2 py-2 font-medium text-gray-600">Valor Total</th>
              <th className="text-center px-2 py-2 font-medium text-gray-600 min-w-[200px]">Pagamento</th>
              <th className="text-right px-2 py-2 font-medium text-gray-600">Ações</th>
            </tr>
          </thead>
          <tbody>
            {categorias.map((cat) => {
              const isCatCollapsed = collapsedCategories.has(cat.tipo);
              return (
                <React.Fragment key={cat.tipo}>
                  <tr
                    className="bg-darc-pink-logo/60 border-y border-darc-pink-logo cursor-pointer hover:bg-darc-pink-logo"
                    onClick={() => toggleCategory(cat.tipo)}
                  >
                    <td className="px-2 py-2 text-center text-darc-raspberry">
                      {isCatCollapsed ? <ChevronRight className="w-3.5 h-3.5 inline" /> : <ChevronDown className="w-3.5 h-3.5 inline" />}
                    </td>
                    <td colSpan={showRooms ? 3 : 2} className="px-2 py-2 font-bold uppercase tracking-wider text-darc-velvet text-xs">
                      {cat.label}
                      <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-darc-raspberry/70">({cat.expenses.length} itens)</span>
                    </td>
                    <td colSpan={2} className="px-2 py-2 text-right text-[10px] text-darc-raspberry">
                      <span className="inline-flex items-center gap-2">
                        {cat.totalPlanejado > 0 && (
                          <span className="bg-darc-sunfire/20 text-darc-raspberry px-1.5 py-0.5 rounded">Plan: {formatCurrency(cat.totalPlanejado / 100)}</span>
                        )}
                        {cat.totalPago > 0 && (
                          <span className="bg-darc-mist/30 text-darc-velvet px-1.5 py-0.5 rounded">Pago: {formatCurrency(cat.totalPago / 100)}</span>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-bold text-darc-velvet text-xs tabular-nums">
                      {formatCurrency(cat.total / 100)}
                    </td>
                    <td colSpan={2} />
                  </tr>

                  {!isCatCollapsed && cat.expenses.map((exp) => {
                    const hasDetail = (exp.formaPagamento === 'PARCELADO' || exp.formaPagamento === 'QUINZENAL') && (exp.quantidadeParcela ?? 0) > 1;
                    const isExpanded = expandedExpenses.has(exp.id);

                    return (
                      <React.Fragment key={exp.id}>
                        <tr className="hover:bg-gray-50 border-b border-gray-100">
                          <td className="px-2 py-1.5 text-center">
                            {hasDetail ? (
                              <button onClick={() => toggleExpand(exp.id)} className="text-gray-400 hover:text-gray-600">
                                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              </button>
                            ) : null}
                          </td>
                          <td className="px-2 py-1.5 font-medium text-gray-800">
                            <div className="flex items-center gap-2">
                              {(() => {
                                const { Icon, color } = getExpenseIcon(exp.tipoDespesa);
                                return <Icon className={`w-3.5 h-3.5 ${color} shrink-0`} />;
                              })()}
                              <span>{exp.titulo || tipoLabel(exp.tipoDespesa)}</span>
                            </div>
                            {exp.tipoDespesa === 'MAO_DE_OBRA' && exp.categoriaMaoDeObra && (
                              <span className="ml-1.5 text-[10px] text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded">{catMaoLabel(exp.categoriaMaoDeObra)}</span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-gray-600 max-w-[120px]" title={exp.fornecedor || ''}>
                            <div className="truncate">{exp.fornecedor || '—'}</div>
                            {(exp.cardLast4 || exp.bankLast4) && (
                              <div className="text-[10px] text-gray-500 mt-0.5">
                                {exp.cardLast4 ? `💳 ••${exp.cardLast4}` : `🏦 ••${exp.bankLast4}`}
                              </div>
                            )}
                          </td>
                          {showRooms && (
                            <td className="px-2 py-1.5 text-gray-600 max-w-[110px] truncate" title={exp.room?.name || ''}>{exp.room?.name || '—'}</td>
                          )}
                          <td className="px-2 py-1.5 text-right text-gray-600 tabular-nums">{formatCurrency(exp.valor / 100)}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600 tabular-nums">{exp.quantidade}</td>
                          <td className="px-2 py-1.5 text-right font-medium text-gray-800 tabular-nums">{formatCurrency(exp.valorTotal / 100)}</td>
                          <td className="px-3 py-1.5 text-center align-middle">
                            <div className="flex flex-col items-center gap-0.5 leading-tight">
                              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                                <span className="text-gray-600">{formaLabel(exp.formaPagamento)}</span>
                                {(exp.quantidadeParcela ?? 0) > 1 && (
                                  <span className="text-[11px] font-bold text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded">{exp.quantidadeParcela}×</span>
                                )}
                                <StatusBadge status={exp.status} />
                              </span>
                              {(exp.dataInicioParcela || exp.dataPagamento) && (
                                <span className="text-[11px] text-gray-400 tabular-nums">
                                  {exp.dataInicioParcela
                                    ? `1ª ${formatDateBR(exp.dataInicioParcela)}`
                                    : formatDateBR(exp.dataPagamento!)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <span className="inline-flex gap-0.5">
                              <button onClick={() => openInlineEdit(exp)} className="p-1 rounded hover:bg-blue-100" title="Editar rápido">
                                <Pencil className="w-3.5 h-3.5 text-gray-500" />
                              </button>
                              <button onClick={() => openEdit(exp)} className="p-1 rounded hover:bg-gray-200" title="Editar completo">
                                <ExternalLink className="w-3.5 h-3.5 text-gray-500" />
                              </button>
                              <button onClick={() => onDelete(exp.id)} className="p-1 rounded hover:bg-red-100" title="Excluir">
                                <Trash2 className="w-3.5 h-3.5 text-red-500" />
                              </button>
                            </span>
                          </td>
                        </tr>

                        {editingInlineId === exp.id && (
                          <>
                            <tr className="bg-blue-50/40 border-b border-blue-100">
                              <td className="px-2 py-2 text-center">
                                <Pencil className="w-3.5 h-3.5 text-blue-500 inline" />
                              </td>
                              <td className="px-3 py-2" colSpan={2}>
                                <div className="flex gap-2">
                                  <select value={editingInlineRow.tipoDespesa} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, tipoDespesa: e.target.value })}
                                    onKeyDown={inlineEditKeyDown}
                                    className="border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                                    {tipoDespesaOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                  <input type="text" placeholder="Título" value={editingInlineRow.titulo}
                                    onChange={(e) => setEditingInlineRow({ ...editingInlineRow, titulo: e.target.value })} onKeyDown={inlineEditKeyDown}
                                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <input type="text" placeholder="Fornecedor" value={editingInlineRow.fornecedor}
                                  onChange={(e) => setEditingInlineRow({ ...editingInlineRow, fornecedor: e.target.value })} onKeyDown={inlineEditKeyDown}
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                              </td>
                              <td className="px-3 py-2">
                                <input type="text" inputMode="numeric" placeholder="Valor" value={editingInlineRow.valor}
                                  onChange={(e) => setEditingInlineRow({ ...editingInlineRow, valor: maskReaisInput(e.target.value) })} onKeyDown={inlineEditKeyDown}
                                  className="w-20 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                              </td>
                              <td className="px-3 py-2">
                                <input type="number" min="1" value={editingInlineRow.quantidade}
                                  onChange={(e) => setEditingInlineRow({ ...editingInlineRow, quantidade: e.target.value })} onKeyDown={inlineEditKeyDown}
                                  className="w-14 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                              </td>
                              <td className="px-3 py-2 text-right text-xs text-gray-500 font-medium">
                                {formatCurrency(((reaisToCents(editingInlineRow.valor) / 100) || 0) * (parseInt(editingInlineRow.quantidade) || 1))}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex gap-1">
                                  <select value={editingInlineRow.formaPagamento} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, formaPagamento: e.target.value })}
                                    onKeyDown={inlineEditKeyDown}
                                    className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                                    {FORMA_PAGAMENTO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </select>
                                  <select value={editingInlineRow.status} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, status: e.target.value })}
                                    onKeyDown={inlineEditKeyDown}
                                    className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                                    <option value="PLANEJADO">Plan.</option>
                                    <option value="PAGO">Pago</option>
                                  </select>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-right">
                                <span className="inline-flex gap-0.5">
                                  <button onClick={handleInlineUpdateSubmit} className="p-1 rounded hover:bg-green-100" title="Salvar (Enter)">
                                    <Check className="w-3.5 h-3.5 text-green-600" />
                                  </button>
                                  <button onClick={closeInlineEdit} className="p-1 rounded hover:bg-gray-200" title="Cancelar (Esc)">
                                    <X className="w-3.5 h-3.5 text-gray-500" />
                                  </button>
                                </span>
                              </td>
                            </tr>
                            <tr className="bg-blue-50/20 border-b border-blue-100">
                              <td />
                              <td colSpan={colSpan - 1} className="px-3 py-1.5">
                                <div className="flex items-center gap-4 flex-wrap">
                                  {showRooms && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-gray-500 font-medium">Ambiente:</span>
                                      <select value={editingInlineRow.roomId} onChange={(e) => setEditingInlineRow({ ...editingInlineRow, roomId: e.target.value })}
                                        onKeyDown={inlineEditKeyDown}
                                        className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                                        <option value="">-</option>
                                        {roomOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                      </select>
                                    </div>
                                  )}
                                  {editingInlineRow.tipoDespesa === 'MAO_DE_OBRA' && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-gray-500 font-medium">Cat. Mão de Obra:</span>
                                      <select value={editingInlineRow.categoriaMaoDeObra}
                                        onChange={(e) => setEditingInlineRow({ ...editingInlineRow, categoriaMaoDeObra: e.target.value })}
                                        onKeyDown={inlineEditKeyDown}
                                        className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                                        <option value="">Selecione...</option>
                                        {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                      </select>
                                    </div>
                                  )}
                                  {isSinglePaymentForm(editingInlineRow.formaPagamento) && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] text-gray-500 font-medium">Data Pagto:</span>
                                      <input type="date" value={editingInlineRow.dataPagamento}
                                        onChange={(e) => setEditingInlineRow({ ...editingInlineRow, dataPagamento: e.target.value })} onKeyDown={inlineEditKeyDown}
                                        className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                                    </div>
                                  )}
                                  {(editingInlineRow.formaPagamento === 'PARCELADO' || editingInlineRow.formaPagamento === 'QUINZENAL') && (
                                    <>
                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-gray-500 font-medium">
                                          {editingInlineRow.formaPagamento === 'PARCELADO' ? 'Parcelas:' : 'Quinzenas:'}
                                        </span>
                                        <input type="number" min="1" placeholder="1" value={editingInlineRow.quantidadeParcela}
                                          onChange={(e) => setEditingInlineRow({ ...editingInlineRow, quantidadeParcela: e.target.value })} onKeyDown={inlineEditKeyDown}
                                          className="w-14 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-gray-500 font-medium">Início:</span>
                                        <input type="date" value={editingInlineRow.dataInicioParcela}
                                          onChange={(e) => setEditingInlineRow({ ...editingInlineRow, dataInicioParcela: e.target.value })} onKeyDown={inlineEditKeyDown}
                                          className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                                      </div>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          </>
                        )}

                        {isExpanded && hasDetail && buildInstallments({
                          valorTotal: exp.valorTotal,
                          formaPagamento: exp.formaPagamento,
                          dataPagamento: exp.dataPagamento ? new Date(exp.dataPagamento) : null,
                          quantidadeParcela: exp.quantidadeParcela,
                          dataInicioParcela: exp.dataInicioParcela ? new Date(exp.dataInicioParcela) : null,
                        }).map((p) => (
                          <tr key={`${exp.id}-${p.parcela}`} className="bg-gray-50/50">
                            <td />
                            <td className="px-2 py-1 pl-8 text-gray-500">
                              ↳ Parcela {p.parcela}
                            </td>
                            <td className="px-2 py-1 text-gray-400 tabular-nums">
                              {formatDateBR(p.data.toISOString().slice(0, 10))}
                            </td>
                            <td />
                            <td />
                            <td />
                            <td className="px-2 py-1 text-right text-gray-500 tabular-nums">{formatCurrency(p.valor / 100)}</td>
                            <td colSpan={2} />
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}

            {showNewRow && (
              <>
                <tr className="bg-blue-50/40 border-t-2 border-blue-200">
                  <td className="px-2 py-2 text-center">
                    <span className="text-blue-400 text-xs font-bold">+</span>
                  </td>
                  <td className="px-3 py-2" colSpan={2}>
                    <div className="flex gap-2">
                      <select value={newRow.tipoDespesa} onChange={(e) => setNewRow({ ...newRow, tipoDespesa: e.target.value })}
                        onKeyDown={inlineKeyDown}
                        className="border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300" autoFocus>
                        {tipoDespesaOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <input type="text" placeholder="Título" value={newRow.titulo}
                        onChange={(e) => setNewRow({ ...newRow, titulo: e.target.value })} onKeyDown={inlineKeyDown}
                        className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <input type="text" placeholder="Fornecedor" value={newRow.fornecedor}
                      onChange={(e) => setNewRow({ ...newRow, fornecedor: e.target.value })} onKeyDown={inlineKeyDown}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="text" inputMode="numeric" placeholder="Valor" value={newRow.valor}
                      onChange={(e) => setNewRow({ ...newRow, valor: maskReaisInput(e.target.value) })} onKeyDown={inlineKeyDown}
                      className="w-20 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" min="1" value={newRow.quantidade}
                      onChange={(e) => setNewRow({ ...newRow, quantidade: e.target.value })} onKeyDown={inlineKeyDown}
                      className="w-14 border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-2 focus:ring-blue-300" />
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-gray-500 font-medium">
                    {formatCurrency(((reaisToCents(newRow.valor) / 100) || 0) * (parseInt(newRow.quantidade) || 1))}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <select value={newRow.formaPagamento} onChange={(e) => setNewRow({ ...newRow, formaPagamento: e.target.value })}
                        onKeyDown={inlineKeyDown}
                        className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                        {FORMA_PAGAMENTO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <select value={newRow.status} onChange={(e) => setNewRow({ ...newRow, status: e.target.value })}
                        onKeyDown={inlineKeyDown}
                        className="border border-gray-300 rounded px-1 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                        <option value="PLANEJADO">Plan.</option>
                        <option value="PAGO">Pago</option>
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex gap-0.5">
                      <button onClick={handleInlineSubmit} className="p-1 rounded hover:bg-green-100" title="Salvar (Enter)">
                        <Check className="w-3.5 h-3.5 text-green-600" />
                      </button>
                      <button onClick={() => setShowNewRow(false)} className="p-1 rounded hover:bg-gray-200" title="Cancelar (Esc)">
                        <X className="w-3.5 h-3.5 text-gray-500" />
                      </button>
                    </span>
                  </td>
                </tr>
                <tr className="bg-blue-50/20">
                  <td />
                  <td colSpan={colSpan - 1} className="px-3 py-1.5">
                    <div className="flex items-center gap-4 flex-wrap">
                      {showRooms && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 font-medium">Ambiente:</span>
                          <select value={newRow.roomId} onChange={(e) => setNewRow({ ...newRow, roomId: e.target.value })}
                            onKeyDown={inlineKeyDown}
                            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                            <option value="">-</option>
                            {roomOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      )}
                      {newRow.tipoDespesa === 'MAO_DE_OBRA' && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 font-medium">Cat. Mão de Obra:</span>
                          <select value={newRow.categoriaMaoDeObra}
                            onChange={(e) => setNewRow({ ...newRow, categoriaMaoDeObra: e.target.value })}
                            onKeyDown={inlineKeyDown}
                            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                            <option value="">Selecione...</option>
                            {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      )}
                      {isSinglePaymentForm(newRow.formaPagamento) && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-500 font-medium">Data Pagto:</span>
                          <input type="date" value={newRow.dataPagamento}
                            onChange={(e) => setNewRow({ ...newRow, dataPagamento: e.target.value })} onKeyDown={inlineKeyDown}
                            className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                        </div>
                      )}
                      {(newRow.formaPagamento === 'PARCELADO' || newRow.formaPagamento === 'QUINZENAL') && (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 font-medium">
                              {newRow.formaPagamento === 'PARCELADO' ? 'Parcelas:' : 'Quinzenas:'}
                            </span>
                            <input type="number" min="1" placeholder="1" value={newRow.quantidadeParcela}
                              onChange={(e) => setNewRow({ ...newRow, quantidadeParcela: e.target.value })} onKeyDown={inlineKeyDown}
                              className="w-14 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 font-medium">Início:</span>
                            <input type="date" value={newRow.dataInicioParcela}
                              onChange={(e) => setNewRow({ ...newRow, dataInicioParcela: e.target.value })} onKeyDown={inlineKeyDown}
                              className="border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                          </div>
                          {newRow.quantidadeParcela && reaisToCents(newRow.valor) > 0 && (
                            <span className="text-[10px] text-gray-400">
                              = <span className="font-medium text-gray-600">
                                {formatCurrency((((reaisToCents(newRow.valor) / 100) || 0) * (parseInt(newRow.quantidade) || 1)) / (parseInt(newRow.quantidadeParcela) || 1))}
                              </span> / {newRow.formaPagamento === 'PARCELADO' ? 'parcela' : 'quinzena'}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              </>
            )}

            {filteredExpenses.length === 0 && !showNewRow && (
              <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-gray-400">
                {hasActiveFilters ? 'Nenhuma despesa encontrada com os filtros aplicados.' : 'Nenhuma despesa cadastrada.'}
              </td></tr>
            )}
          </tbody>
          <tfoot className="bg-gray-50 border-t">
            <tr className="font-semibold text-xs">
              <td />
              <td className="px-2 py-2 text-gray-700">Total</td>
              <td />
              <td />
              <td />
              <td />
              <td className="px-2 py-2 text-right font-bold text-gray-800 tabular-nums">{formatCurrency(totalGeral / 100)}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
