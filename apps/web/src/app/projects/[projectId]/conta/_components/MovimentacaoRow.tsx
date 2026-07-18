'use client';

import { CreditCard, Pencil, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import type {
  AccountViewEntrada,
  AccountViewMovimentacao,
  AccountViewSaida,
} from '../_types';

export interface QuitarTarget {
  foreignExpenseId: string;
  parcelaIndex: number;
  valorSugerido: number;
  descricao: string;
  dataSugerida: string;
}

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Extrai { dia, mes } de uma data ISO/‑string, em UTC, para o badge do avatar. */
function dateParts(value: string): { dia: string; mes: string } {
  const part = (value ?? '').slice(0, 10);
  const [, m, d] = part.split('-');
  const mi = parseInt(m ?? '', 10);
  return {
    dia: (d ?? '').padStart(2, '0') || '--',
    mes: mi >= 1 && mi <= 12 ? MESES_ABREV[mi - 1]! : '',
  };
}

export function MovimentacaoRow({
  item,
  originLabel,
  onEditExpense,
  onEditReceita,
  onToggleExpense,
  onToggleReceita,
  onPayInvoice,
  onAdjustInvoice,
  onSettleWithResidual,
  onQuitar,
  onRemoveExpense,
  onRemoveReceita,
}: {
  item: AccountViewMovimentacao;
  originLabel: (cardLast4: string | null, bankLast4: string | null) => string | null;
  onEditExpense: (item: AccountViewSaida) => void;
  onEditReceita: (item: AccountViewEntrada) => void;
  onToggleExpense: (id: string, realizado: boolean) => void;
  onToggleReceita: (id: string, nextStatus: 'EM_CAIXA' | 'PREVISTO') => void;
  onPayInvoice: (cardLast4: string) => void;
  onAdjustInvoice: (cardLast4: string) => void;
  onSettleWithResidual: (cardLast4: string) => void;
  onQuitar: (target: QuitarTarget) => void;
  onRemoveExpense: (id: string) => void;
  onRemoveReceita: (id: string) => void;
}) {
  const isEntrada = item.kind === 'entrada';

  const titulo =
    !isEntrada && item.kind === 'saida' && !item.isInvoice
      ? item.descricao || tipoLabel(item.tipoDespesa)
      : item.descricao;

  const origem =
    item.kind === 'saida'
      ? originLabel(item.cardLast4, item.bankLast4)
      : originLabel(null, item.bankLast4);

  const meta = [
    item.kind === 'saida' && !item.isInvoice ? tipoLabel(item.tipoDespesa) : null,
    item.kind === 'saida' &&
    item.isInvoice &&
    (item.invoicePaidAmount ?? 0) > 0 &&
    !item.realizado
      ? `Parcialmente paga (${formatCurrency((item.invoicePaidAmount ?? 0) / 100)} de ${formatCurrency(item.valor / 100)})`
      : null,
    origem,
  ]
    .filter(Boolean)
    .join(' · ');

  // Entrada realizada = já caiu na conta (EM_CAIXA); PREVISTO ainda não é caixa.
  const realizado = item.kind === 'saida' ? item.realizado : item.status === 'EM_CAIXA';
  const invoiceStatusText =
    item.kind === 'saida' && item.isInvoice && (item.invoicePaidAmount ?? 0) > 0 && !item.realizado
      ? 'Parcial'
      : realizado
        ? 'Paga'
        : 'A pagar';
  const badge = isEntrada
    ? realizado
      ? { txt: 'Recebido', cls: 'bg-[#E3F6EA] text-[#1E924A]' }
      : { txt: 'Previsto', cls: 'bg-[#FBEBDC] text-[#B5803A]' }
    : invoiceStatusText === 'Parcial'
      ? { txt: 'Parcial', cls: 'bg-[#FBEBDC] text-[#B5803A]' }
      : realizado
        ? { txt: 'Paga', cls: 'bg-[#E3F6EA] text-[#1E924A]' }
        : { txt: 'A pagar', cls: 'bg-[#FBEBDC] text-[#B5803A]' };

  const isInvoiceRow = !isEntrada && item.kind === 'saida' && item.isInvoice;
  const canToggle = !isEntrada && item.kind === 'saida' && item.editavel && !item.isInvoice;
  const canEditInvoicePayment =
    !isEntrada &&
    item.kind === 'saida' &&
    item.isInvoice &&
    item.editavel &&
    !!item.id;
  // Parcela cross-project ainda PENDENTE: não é editável nem toggl-ável;
  // precisa ser QUITADA (gera espelho + concilia) para não sumir da Visão Conta.
  const isPendingForeignParcela =
    item.kind === 'saida' &&
    !item.isInvoice &&
    !item.realizado &&
    item.parcelaIndex != null &&
    !!item.foreignExpenseId;
  // Saída editável (despesa PESSOAL) ou entrada (recebimento) → abre modal completo.
  const canEdit = canToggle || canEditInvoicePayment || (isEntrada && !!item.id);
  // Entrada com id pode alternar recebido/previsto direto pelo badge.
  const canToggleReceita = isEntrada && item.kind === 'entrada' && !!item.id;
  const projOrigem =
    item.kind === 'saida' && item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL'
      ? item.projetoOrigem
      : null;

  return (
    <div className="rounded-2xl border border-lifeone-hairline bg-lifeone-card transition-colors hover:border-lifeone-blue hover:shadow-lifeone-card">
      <div className="group flex items-center gap-3 px-3 py-2.5 md:px-4 md:py-3">
        <span
          className={`flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-full leading-none md:h-10 md:w-10 ${
            isEntrada
              ? 'bg-[#E3F6EA] text-[#1E924A]'
              : isInvoiceRow
                ? 'bg-[#EFE6FA] text-[#7A3FC2]'
                : 'bg-[#E6EFFE] text-lifeone-blue'
          }`}
        >
          {isInvoiceRow ? (
            <CreditCard className="h-4 w-4" />
          ) : (
            <>
              <span className="text-sm font-bold tabular-nums font-geist">{dateParts(item.data).dia}</span>
              <span className="text-[8px] font-semibold uppercase tracking-wide opacity-70">
                {dateParts(item.data).mes}
              </span>
            </>
          )}
        </span>

        <button
          type="button"
          onClick={() => {
            if (!canEdit) return;
            if (item.kind === 'saida') onEditExpense(item);
            else if (item.kind === 'entrada') onEditReceita(item);
          }}
          className="min-w-0 flex-1 text-left"
          title={canEdit ? 'Editar' : undefined}
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-lifeone-ink">{titulo}</span>
            {projOrigem && (
              <span className="shrink-0 rounded-full bg-[#E6EFFE] px-2 py-0.5 text-[10px] font-semibold text-lifeone-blue">
                {projOrigem.name}
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-lifeone-ink-3">{meta}</div>
        </button>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <span
            className={`text-sm font-semibold tabular-nums font-geist ${
              isEntrada ? 'text-[#1E924A]' : 'text-lifeone-ink'
            }`}
          >
            {isEntrada ? '+' : '−'} {formatCurrency(item.valor / 100)}
          </span>
          {isInvoiceRow ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (item.kind === 'saida' && !item.realizado && item.cardLast4)
                    onPayInvoice(item.cardLast4);
                }}
                disabled={realizado || !(item.kind === 'saida' && item.cardLast4)}
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls} ${
                  !realizado ? 'cursor-pointer hover:brightness-95' : ''
                }`}
                title={!realizado ? 'Pagar fatura' : undefined}
              >
                {badge.txt}
              </button>
              {item.kind === 'saida' && item.invoiceHasManualIntervention && (
                <span className="rounded-full bg-[#EFE6FA] px-2 py-0.5 text-[10px] font-semibold text-[#7A3FC2]">
                  Ajuste manual
                </span>
              )}
              {item.kind === 'saida' && item.cardLast4 && (
                <>
                  <button
                    type="button"
                    onClick={() => onAdjustInvoice(item.cardLast4!)}
                    className="rounded-full border border-lifeone-hairline px-2 py-0.5 text-[10px] font-semibold text-lifeone-ink-3 hover:border-lifeone-blue hover:text-lifeone-blue"
                  >
                    Ajustar
                  </button>
                  {!item.realizado && (
                    <button
                      type="button"
                      onClick={() => onSettleWithResidual(item.cardLast4!)}
                      className="rounded-full border border-lifeone-hairline px-2 py-0.5 text-[10px] font-semibold text-lifeone-ink-3 hover:border-lifeone-blue hover:text-lifeone-blue"
                    >
                      Resíduo
                    </button>
                  )}
                </>
              )}
            </div>
          ) : isPendingForeignParcela ? (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                if (item.kind === 'saida' && item.foreignExpenseId && item.parcelaIndex != null) {
                  onQuitar({
                    foreignExpenseId: item.foreignExpenseId,
                    parcelaIndex: item.parcelaIndex,
                    valorSugerido: item.valor,
                    descricao: item.descricao,
                    dataSugerida: item.data.slice(0, 10),
                  });
                }
              }}
              className="rounded-full bg-lifeone-blue px-2.5 py-0.5 text-[10px] font-semibold text-white transition hover:brightness-95"
              title="Quitar parcela pela conta pessoal"
            >
              Quitar
            </button>
          ) : (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                if (canToggleReceita && item.kind === 'entrada' && item.id) {
                  onToggleReceita(item.id, realizado ? 'PREVISTO' : 'EM_CAIXA');
                } else if (canToggle && item.kind === 'saida' && item.id) {
                  onToggleExpense(item.id, realizado);
                }
              }}
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.cls} ${
                canToggle || canToggleReceita ? 'cursor-pointer hover:brightness-95' : ''
              }`}
              title={
                canToggleReceita
                  ? realizado
                    ? 'Marcar como previsto'
                    : 'Marcar como recebido'
                  : canToggle
                    ? 'Alternar status'
                    : undefined
              }
            >
              {badge.txt}
            </button>
          )}
        </div>

        {canEdit && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Editar"
              onClick={() => {
                if (item.kind === 'saida') onEditExpense(item);
                else if (item.kind === 'entrada') onEditReceita(item);
              }}
              className="rounded-lg p-1.5 text-lifeone-ink-4 transition-colors hover:bg-[#E6EFFE] hover:text-lifeone-blue"
              title="Editar"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Excluir"
              onClick={() => {
                if (!item.id) return;
                if (item.kind === 'saida') {
                  if (confirm('Excluir lançamento?')) onRemoveExpense(item.id);
                } else if (item.kind === 'entrada') {
                  if (confirm('Excluir recebimento?')) onRemoveReceita(item.id);
                }
              }}
              className="rounded-lg p-1.5 text-lifeone-ink-4 transition-colors hover:bg-[#FCEBE9] hover:text-[#D92D20]"
              title="Excluir"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
