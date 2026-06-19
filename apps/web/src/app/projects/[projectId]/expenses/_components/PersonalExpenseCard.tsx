'use client';

import { Trash2 } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { caixaMonthForCardPurchase } from '@reformaflow/domain';
import type { Expense, ExpenseStatus } from '@/types';
import { effectiveDate } from '../_lib/grouping-by-month';
import { BulkCheckbox } from './BulkDateSelection';

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

export default function PersonalExpenseCard({
  expense,
  tipoLabel,
  cardInfoByLast4,
  cashMode = 'competencia',
  onEdit,
  onDelete,
  onToggleStatus,
}: {
  expense: Expense;
  tipoLabel: (t: string) => string;
  cardInfoByLast4?: Map<string, PersonalCardInfo>;
  /**
   * 'competencia' (Gastos Controle): selos de origem/destino —
   * "→ fatura <mês>" (cartão), "débito" (conta), "planejado".
   * 'caixa' (Conta Real): selos de conta — "paga"/"a pagar".
   */
  cashMode?: 'competencia' | 'caixa';
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

  const titulo = expense.titulo || expense.fornecedor || tipoLabel(expense.tipoDespesa);
  const initial = (titulo.trim()[0] || '?').toUpperCase();

  // Selo único de status (estilo mock): cor por situação.
  const statusSelo = (() => {
    if (cashMode === 'caixa') {
      return isPago
        ? { txt: 'Paga', cls: 'bg-emerald-100 text-emerald-700' }
        : { txt: 'A pagar', cls: 'bg-amber-100 text-amber-700' };
    }
    if (expense.cardLast4) {
      return { txt: venceMes ? `Fatura ${venceMes}` : 'No cartão', cls: 'bg-violet-100 text-violet-700' };
    }
    return isPago
      ? { txt: 'Pago', cls: 'bg-emerald-100 text-emerald-700' }
      : { txt: 'Planejado', cls: 'bg-amber-100 text-amber-700' };
  })();

  // Linha de meta enxuta (texto leve, sem chips coloridos múltiplos).
  const origem = expense.cardLast4
    ? (cardInfo?.label ?? `Cartão ••${expense.cardLast4}`)
    : expense.bankLast4
      ? `Conta ••${expense.bankLast4}`
      : null;
  const meta = [
    tipoLabel(expense.tipoDespesa),
    dt ? formatDateBR(dt).slice(0, 5) : null,
    parcelasTotais > 1 ? `${parcelasPagas}/${parcelasTotais}x` : null,
    origem,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`group flex items-center gap-3 rounded-2xl border border-darc-linen bg-white px-3 py-2.5 transition-colors hover:border-orange-200 hover:shadow-darc-soft md:px-4 md:py-3 ${isPago ? 'opacity-80' : ''}`}>
      <BulkCheckbox id={expense.id} />
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-100 text-sm font-bold text-orange-700 md:h-10 md:w-10">
        {initial}
      </span>
      <button
        type="button"
        onClick={() => onEdit(expense)}
        className="flex-1 min-w-0 text-left"
        title="Editar"
      >
        <div className="font-semibold text-sm text-darc-velvet truncate">{titulo}</div>
        <div className="text-[11px] text-darc-velvet/50 truncate">{meta}</div>
      </button>

      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="font-semibold tabular-nums text-sm text-darc-velvet">
          {formatCurrency(expense.valorTotal / 100)}
        </span>
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            if (cashMode === 'caixa' || !expense.cardLast4) onToggleStatus(expense.id, isPago ? 'PLANEJADO' : 'PAGO');
          }}
          title="Alternar status"
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusSelo.cls}`}
        >
          {statusSelo.txt}
        </button>
      </div>

      <button
        type="button"
        onClick={() => { if (confirm('Excluir despesa?')) onDelete(expense.id); }}
        className="shrink-0 rounded-lg p-1.5 text-darc-velvet/30 transition-colors hover:bg-red-50 hover:text-red-500"
        title="Excluir"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
