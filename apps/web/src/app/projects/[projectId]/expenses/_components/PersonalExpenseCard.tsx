'use client';

import { Edit2, Trash2 } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { caixaMonthForCardPurchase } from '@reformaflow/domain';
import type { Expense, ExpenseStatus } from '@/types';
import { effectiveDate } from '../_lib/grouping-by-month';

export interface PersonalCardInfo {
  label: string;
  closingDay: number | null;
  dueDay: number | null;
}

function parsePaidCount(raw: string | null | undefined, total: number, status: Expense['status']): number {
  if (status === 'PAGO') return total;
  if (!raw) return 0;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return 0;
    return arr.filter((v) => Number.isInteger(v) && v >= 0 && v < total).length;
  } catch {
    return 0;
  }
}

function statusTone(status: Expense['status']) {
  return status === 'PAGO'
    ? 'bg-emerald-500 text-white'
    : 'bg-amber-500 text-white';
}

export default function PersonalExpenseCard({
  expense,
  tipoLabel,
  cardInfoByLast4,
  onEdit,
  onDelete,
  onToggleStatus,
}: {
  expense: Expense;
  tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
  onEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  const isPago = expense.status === 'PAGO';
  const parcelasTotais =
    (expense.formaPagamento === 'PARCELADO' || expense.formaPagamento === 'QUINZENAL')
      ? (expense.quantidadeParcela ?? 1)
      : 1;
  const parcelasPagas = parsePaidCount(expense.paidParcelas, parcelasTotais, expense.status);

  const cardInfo = expense.cardLast4 ? cardInfoByLast4?.get(expense.cardLast4) : undefined;
  const dt = effectiveDate(expense);
  const venceMes = (() => {
    if (!expense.cardLast4 || !dt || !cardInfo) return null;
    const ym = caixaMonthForCardPurchase(
      dt,
      cardInfo.closingDay ?? null,
      cardInfo.dueDay ?? null,
    );
    const [y, m] = ym.split('-');
    return `${m}/${String(y).slice(-2)}`;
  })();

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs border-t border-gray-100 hover:bg-orange-50/40">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 truncate">
          {expense.titulo || expense.fornecedor || tipoLabel(expense.tipoDespesa)}
        </div>
        <div className="text-[10px] text-gray-500 truncate">
          {tipoLabel(expense.tipoDespesa)}
          {expense.room?.name ? ` · ${expense.room.name}` : ''}
          {dt ? ` · ${formatDateBR(dt)}` : ''}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className="text-[10px] rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">
            {expense.formaPagamento}
          </span>
          {parcelasTotais > 1 && (
            <span className="text-[10px] rounded bg-teal-100 px-1.5 py-0.5 text-teal-800 font-semibold">
              {parcelasPagas}/{parcelasTotais}
            </span>
          )}
          {expense.cardLast4 && (
            <span className="text-[10px] rounded bg-purple-100 px-1.5 py-0.5 text-purple-800">
              {cardInfo?.label ?? `Cartão ••${expense.cardLast4}`}
            </span>
          )}
          {!expense.cardLast4 && expense.bankLast4 && (
            <span className="text-[10px] rounded bg-cyan-100 px-1.5 py-0.5 text-cyan-800">
              Conta ••{expense.bankLast4}
            </span>
          )}
          {venceMes && (
            <span className="text-[10px] rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 font-semibold">
              vence em {venceMes}
            </span>
          )}
          <span className={`text-[10px] rounded px-1.5 py-0.5 font-semibold ${statusTone(expense.status)}`}>
            {expense.status}
          </span>
        </div>
      </div>

      <div className="flex flex-col items-end whitespace-nowrap">
        <span className="font-mono text-gray-900 text-xs">{formatCurrency(expense.valorTotal / 100)}</span>
        {parcelasTotais > 1 && (
          <span className="text-[10px] text-gray-500">
            {parcelasTotais}x de {formatCurrency(Math.round(expense.valorTotal / parcelasTotais) / 100)}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation();
          onToggleStatus(expense.id, isPago ? 'PLANEJADO' : 'PAGO');
        }}
        title="Alternar status"
        className={`rounded px-2 py-1 text-[10px] font-semibold ${isPago ? 'bg-emerald-600 text-white' : 'bg-amber-600 text-white'}`}
      >
        {isPago ? 'PAGO' : 'PLAN'}
      </button>
      <button
        type="button"
        onClick={() => onEdit(expense)}
        className="text-blue-600 hover:bg-blue-50 rounded p-1"
        title="Editar"
      >
        <Edit2 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => { if (confirm('Excluir despesa?')) onDelete(expense.id); }}
        className="text-red-500 hover:bg-red-50 rounded p-1"
        title="Excluir"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
