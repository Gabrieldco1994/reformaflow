'use client';
import React from 'react';
import { Check, X } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { CATEGORIA_MAO_DE_OBRA_OPTIONS, FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import type { InlineNewRow } from '../_types';

interface OptionItem {
  value: string;
  label: string;
}

interface Props {
  newRow: InlineNewRow;
  setNewRow: (row: InlineNewRow) => void;
  tipoDespesaOptions: OptionItem[];
  showRooms: boolean;
  roomOptions: OptionItem[];
  onSubmit: () => void;
  onCancel: () => void;
  inlineKeyDown: (e: React.KeyboardEvent) => void;
}

const inputCls =
  'border border-gray-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300';

/**
 * Criação rápida de despesa em formato de card (div), usada nas visões em que a
 * tabela com linha inline não está presente (Mês e Pessoal/consolidada).
 */
export function QuickAddCard({
  newRow,
  setNewRow,
  tipoDespesaOptions,
  showRooms,
  roomOptions,
  onSubmit,
  onCancel,
  inlineKeyDown,
}: Props) {
  const valorTotal = (parseFloat(newRow.valor) || 0) * (parseInt(newRow.quantidade) || 1);
  return (
    <div className="rounded-lg border-2 border-blue-200 bg-blue-50/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-blue-700">Adicionar rápido</span>
        <span className="inline-flex gap-1">
          <button onClick={onSubmit} className="p-1 rounded hover:bg-green-100" title="Salvar (Enter)">
            <Check className="w-4 h-4 text-green-600" />
          </button>
          <button onClick={onCancel} className="p-1 rounded hover:bg-gray-200" title="Cancelar (Esc)">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={newRow.tipoDespesa}
          onChange={(e) => setNewRow({ ...newRow, tipoDespesa: e.target.value })}
          onKeyDown={inlineKeyDown}
          className={inputCls}
          autoFocus
        >
          {tipoDespesaOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Título"
          value={newRow.titulo}
          onChange={(e) => setNewRow({ ...newRow, titulo: e.target.value })}
          onKeyDown={inlineKeyDown}
          className={`${inputCls} flex-1 min-w-[120px]`}
        />
        <input
          type="text"
          placeholder="Fornecedor"
          value={newRow.fornecedor}
          onChange={(e) => setNewRow({ ...newRow, fornecedor: e.target.value })}
          onKeyDown={inlineKeyDown}
          className={`${inputCls} flex-1 min-w-[120px]`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500">
          Valor
          <input
            type="number"
            step="0.01"
            placeholder="0,00"
            value={newRow.valor}
            onChange={(e) => setNewRow({ ...newRow, valor: e.target.value })}
            onKeyDown={inlineKeyDown}
            className={`${inputCls} w-24 text-right`}
          />
        </label>
        <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500">
          Qtd
          <input
            type="number"
            min="1"
            value={newRow.quantidade}
            onChange={(e) => setNewRow({ ...newRow, quantidade: e.target.value })}
            onKeyDown={inlineKeyDown}
            className={`${inputCls} w-16 text-right`}
          />
        </label>
        <span className="text-xs text-gray-500 font-medium">= {formatCurrency(valorTotal)}</span>

        <select
          value={newRow.formaPagamento}
          onChange={(e) => setNewRow({ ...newRow, formaPagamento: e.target.value })}
          onKeyDown={inlineKeyDown}
          className={inputCls}
        >
          {FORMA_PAGAMENTO_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={newRow.status}
          onChange={(e) => setNewRow({ ...newRow, status: e.target.value })}
          onKeyDown={inlineKeyDown}
          className={inputCls}
        >
          <option value="PLANEJADO">Planejado</option>
          <option value="PAGO">Pago</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {showRooms && (
          <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500">
            Ambiente
            <select
              value={newRow.roomId}
              onChange={(e) => setNewRow({ ...newRow, roomId: e.target.value })}
              onKeyDown={inlineKeyDown}
              className={inputCls}
            >
              <option value="">-</option>
              {roomOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        {newRow.tipoDespesa === 'MAO_DE_OBRA' && (
          <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500">
            Cat. Mão de Obra
            <select
              value={newRow.categoriaMaoDeObra}
              onChange={(e) => setNewRow({ ...newRow, categoriaMaoDeObra: e.target.value })}
              onKeyDown={inlineKeyDown}
              className={inputCls}
            >
              <option value="">Selecione...</option>
              {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        {newRow.formaPagamento === 'A_VISTA' && (
          <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500">
            Data Pagto
            <input
              type="date"
              value={newRow.dataPagamento}
              onChange={(e) => setNewRow({ ...newRow, dataPagamento: e.target.value })}
              onKeyDown={inlineKeyDown}
              className={inputCls}
            />
          </label>
        )}
        {(newRow.formaPagamento === 'PARCELADO' || newRow.formaPagamento === 'QUINZENAL') && (
          <>
            <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500">
              {newRow.formaPagamento === 'PARCELADO' ? 'Parcelas' : 'Quinzenas'}
              <input
                type="number"
                min="1"
                placeholder="1"
                value={newRow.quantidadeParcela}
                onChange={(e) => setNewRow({ ...newRow, quantidadeParcela: e.target.value })}
                onKeyDown={inlineKeyDown}
                className={`${inputCls} w-16`}
              />
            </label>
            <label className="flex items-center gap-1 text-[10px] font-medium text-gray-500">
              Início
              <input
                type="date"
                value={newRow.dataInicioParcela}
                onChange={(e) => setNewRow({ ...newRow, dataInicioParcela: e.target.value })}
                onKeyDown={inlineKeyDown}
                className={inputCls}
              />
            </label>
            {newRow.quantidadeParcela && parseFloat(newRow.valor) > 0 && (
              <span className="text-[10px] text-gray-400">
                ={' '}
                <span className="font-medium text-gray-600">
                  {formatCurrency(valorTotal / (parseInt(newRow.quantidadeParcela) || 1))}
                </span>{' '}
                / {newRow.formaPagamento === 'PARCELADO' ? 'parcela' : 'quinzena'}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
