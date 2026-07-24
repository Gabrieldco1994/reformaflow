'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { getExpenseIcon } from '@/lib/expense-icons';
import type { Expense } from '@/types';

/**
 * Linha enxuta de despesa para CASA/CARRO — mesmo padrão visual do
 * MovimentacaoRow (Conta/PESSOAL): avatar por tipo, valor SEMPRE nowrap à
 * direita, ações de editar/excluir. Sem vínculo cross-project, sem fatura,
 * sem parcela cross — esses tipos não têm essa complexidade (issue #292).
 */
export function SimpleExpenseRow({
  expense,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  expense: Expense;
  onEdit: (expense: Expense) => void;
  onToggleStatus: (id: string, currentStatus: string) => void;
  onDelete: (id: string) => void;
}) {
  const iconCfg = getExpenseIcon(expense.tipoDespesa);
  const AvatarIcon = iconCfg.Icon;
  const titulo = expense.titulo || tipoLabel(expense.tipoDespesa);
  const isPago = expense.status === 'PAGO';
  const dataFmt = expense.dataPagamento ? formatDateBR(expense.dataPagamento) : null;
  const meta = [dataFmt, tipoLabel(expense.tipoDespesa)].filter(Boolean).join(' · ');

  return (
    <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card transition-colors hover:border-lifeone-blue hover:shadow-lifeone-card md:rounded-2xl">
      <div className="flex items-center gap-2.5 px-2.5 py-2 md:gap-3 md:px-4 md:py-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full md:h-10 md:w-10 ${iconCfg.bgColor} ${iconCfg.color}`}
        >
          <AvatarIcon className="h-4 w-4 md:h-[18px] md:w-[18px]" />
        </span>

        <button
          type="button"
          onClick={() => onEdit(expense)}
          className="min-w-0 flex-1 text-left"
          title="Editar despesa"
        >
          <p className="truncate text-[14px] font-semibold leading-tight text-lifeone-ink md:text-[15px]">
            {titulo}
          </p>
          <p className="truncate text-[11px] text-lifeone-ink-3">{meta}</p>
        </button>

        <div className="flex shrink-0 flex-col items-end gap-0">
          <span className="whitespace-nowrap text-[14px] font-semibold tabular-nums font-geist text-lifeone-ink md:text-[15px]">
            − {formatCurrency(expense.valorTotal / 100)}
          </span>
          <button
            type="button"
            onClick={() => expense.id && onToggleStatus(expense.id, expense.status)}
            className={`inline-flex min-h-6 items-center justify-end text-[11px] font-semibold leading-none md:min-h-[30px] ${
              isPago ? 'text-[#1E924A]' : 'text-[#B5803A]'
            } cursor-pointer hover:brightness-90`}
            title="Alternar status"
          >
            {isPago ? 'Paga' : 'A pagar'}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="Editar"
            title="Editar"
            onClick={() => onEdit(expense)}
            className="rounded-lg p-2 text-lifeone-ink-4 transition-colors hover:bg-[#E6EFFE] hover:text-lifeone-blue"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Excluir"
            title="Excluir"
            onClick={() => {
              if (expense.id && confirm('Excluir despesa?')) onDelete(expense.id);
            }}
            className="rounded-lg p-2 text-lifeone-ink-4 transition-colors hover:bg-[#FCEBE9] hover:text-[#D92D20]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
