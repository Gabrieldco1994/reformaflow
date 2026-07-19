'use client';

import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  Link2,
  MoreHorizontal,
  Pencil,
  SlidersHorizontal,
  Split,
  Trash2,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { getExpenseIcon, getReceiptIcon } from '@/lib/expense-icons';
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

/** Extrai { dia, mes } de uma data ISO/‑string, em UTC, para a linha de metadados. */
function dateParts(value: string): { dia: string; mes: string } {
  const part = (value ?? '').slice(0, 10);
  const [, m, d] = part.split('-');
  const mi = parseInt(m ?? '', 10);
  return {
    dia: (d ?? '').padStart(2, '0') || '--',
    mes: mi >= 1 && mi <= 12 ? MESES_ABREV[mi - 1]! : '',
  };
}

interface RowAction {
  key: string;
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  danger?: boolean;
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
  onRatear,
  onVincular,
  expandable = false,
  expanded = false,
  onToggleExpand,
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
  /** Ratear uma compra PESSOAL entre planejadas de outro projeto. */
  onRatear?: (item: AccountViewSaida) => void;
  /** Vincular (espelhar) uma compra PESSOAL em outro projeto. */
  onVincular?: (item: AccountViewSaida) => void;
  /** Linha de fatura pode revelar as compras inline (chevron no título). */
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isEntrada = item.kind === 'entrada';
  const isInvoiceRow = item.kind === 'saida' && item.isInvoice;
  const canExpand = isInvoiceRow && expandable && !!onToggleExpand;

  const titulo =
    item.kind === 'saida' && !item.isInvoice
      ? item.descricao || tipoLabel(item.tipoDespesa)
      : item.descricao;

  const origem =
    item.kind === 'saida'
      ? originLabel(item.cardLast4, item.bankLast4)
      : originLabel(null, item.bankLast4);

  const dp = dateParts(item.data);
  const dateStr = dp.mes ? `${dp.dia} ${dp.mes}` : dp.dia;

  const meta = [
    dateStr,
    item.kind === 'saida' && !item.isInvoice ? tipoLabel(item.tipoDespesa) : null,
    item.kind === 'saida' &&
    item.isInvoice &&
    (item.invoicePaidAmount ?? 0) > 0 &&
    !item.realizado
      ? `Parcial: ${formatCurrency((item.invoicePaidAmount ?? 0) / 100)} de ${formatCurrency(item.valor / 100)}`
      : null,
    item.kind === 'saida' && item.isInvoice && item.invoiceHasManualIntervention ? 'Ajuste manual' : null,
    origem,
  ]
    .filter(Boolean)
    .join(' · ');

  // Ícone semântico do avatar: recebimento → tipo de receita; fatura → cartão;
  // despesa → tipo de despesa (mesmo mapa da lista Geral).
  const iconCfg =
    item.kind === 'entrada'
      ? getReceiptIcon(item.tipo)
      : item.isInvoice
        ? { Icon: CreditCard, color: 'text-[#7A3FC2]', bgColor: 'bg-[#EFE6FA]' }
        : getExpenseIcon(item.tipoDespesa);
  const AvatarIcon = iconCfg.Icon;

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

  const canToggle = item.kind === 'saida' && item.editavel && !item.isInvoice;
  const canEditInvoicePayment =
    item.kind === 'saida' && item.isInvoice && item.editavel && !!item.id;
  // Parcela cross-project ainda PENDENTE: precisa ser QUITADA (gera espelho + concilia).
  const isPendingForeignParcela =
    item.kind === 'saida' &&
    !item.isInvoice &&
    !item.realizado &&
    item.parcelaIndex != null &&
    !!item.foreignExpenseId;
  const canEdit = canToggle || canEditInvoicePayment || (isEntrada && !!item.id);
  const canToggleReceita = item.kind === 'entrada' && !!item.id;
  // Compra PESSOAL "solta" (não fatura, editável, sem vínculo cross) → pode ratear/vincular.
  const canCrossLink =
    item.kind === 'saida' && !item.isInvoice && item.editavel && !!item.id && item.projetoOrigem == null;
  const projOrigem =
    item.kind === 'saida' && item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL'
      ? item.projetoOrigem
      : null;

  const doEdit = () => {
    if (item.kind === 'saida') onEditExpense(item);
    else if (item.kind === 'entrada') onEditReceita(item);
  };
  const doDelete = () => {
    if (!item.id) return;
    if (item.kind === 'saida') {
      if (confirm('Excluir lançamento?')) onRemoveExpense(item.id);
    } else if (item.kind === 'entrada') {
      if (confirm('Excluir recebimento?')) onRemoveReceita(item.id);
    }
  };

  // Ações secundárias (single-source): ícones inline no desktop, sheet "⋯" no mobile.
  const actions: RowAction[] = [];
  if (canEdit) actions.push({ key: 'edit', label: 'Editar', Icon: Pencil, onClick: doEdit });
  if (canCrossLink && onRatear)
    actions.push({ key: 'ratear', label: 'Ratear entre projetos', Icon: Split, onClick: () => onRatear(item) });
  if (canCrossLink && onVincular)
    actions.push({ key: 'vincular', label: 'Vincular a um projeto', Icon: Link2, onClick: () => onVincular(item) });
  if (item.kind === 'saida' && item.isInvoice && item.cardLast4) {
    const card = item.cardLast4;
    actions.push({ key: 'ajustar', label: 'Ajustar fatura', Icon: SlidersHorizontal, onClick: () => onAdjustInvoice(card) });
    if (!item.realizado)
      actions.push({ key: 'residuo', label: 'Quitar com resíduo', Icon: CircleDollarSign, onClick: () => onSettleWithResidual(card) });
  }
  if (canEdit)
    actions.push({
      key: 'delete',
      label: isEntrada ? 'Excluir recebimento' : 'Excluir',
      Icon: Trash2,
      onClick: doDelete,
      danger: true,
    });

  // Controle primário de status (visível em ambos): pagar fatura / quitar / alternar.
  const statusControl = isInvoiceRow ? (
    <button
      type="button"
      onClick={() => {
        if (item.kind === 'saida' && !item.realizado && item.cardLast4) onPayInvoice(item.cardLast4);
      }}
      disabled={realizado || !(item.kind === 'saida' && item.cardLast4)}
      className={`inline-flex min-h-[44px] items-center justify-center rounded-full px-3 text-[11px] font-semibold md:min-h-[30px] ${badge.cls} ${
        !realizado ? 'cursor-pointer hover:brightness-95' : 'cursor-default'
      }`}
      title={!realizado ? 'Pagar fatura' : undefined}
    >
      {badge.txt}
    </button>
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
      className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-lifeone-blue px-3.5 text-[11px] font-semibold text-white transition hover:brightness-95 md:min-h-[30px]"
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
      disabled={!(canToggle || canToggleReceita)}
      className={`inline-flex min-h-[44px] items-center justify-center rounded-full px-3 text-[11px] font-semibold md:min-h-[30px] ${badge.cls} ${
        canToggle || canToggleReceita ? 'cursor-pointer hover:brightness-95' : 'cursor-default'
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
  );

  return (
    <div className="rounded-2xl border border-lifeone-hairline bg-lifeone-card transition-colors hover:border-lifeone-blue hover:shadow-lifeone-card">
      <div className="flex items-center gap-3 px-3 py-2.5 md:px-4 md:py-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconCfg.bgColor} ${iconCfg.color}`}
        >
          <AvatarIcon className="h-[18px] w-[18px]" />
        </span>

        <button
          type="button"
          onClick={() => {
            if (canExpand) onToggleExpand!();
            else if (canEdit) doEdit();
          }}
          className="min-w-0 flex-1 text-left"
          title={canExpand ? (expanded ? 'Recolher compras' : 'Ver compras da fatura') : canEdit ? 'Editar' : undefined}
        >
          <div className="flex items-center gap-1">
            {canExpand &&
              (expanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
              ))}
            <span className="truncate text-[15px] font-semibold leading-tight text-lifeone-ink">{titulo}</span>
          </div>
          <div className={`mt-0.5 flex items-center gap-1.5 ${canExpand ? 'pl-5' : ''}`}>
            <span className="truncate text-[11px] text-lifeone-ink-3">{meta}</span>
            {projOrigem && (
              <span className="shrink-0 rounded-full bg-[#E6EFFE] px-1.5 py-0.5 text-[11px] font-semibold text-lifeone-blue">
                {projOrigem.name}
              </span>
            )}
          </div>
        </button>

        {/* Cluster à direita: valor SEMPRE isolado (nowrap), status abaixo (mobile) ou ao lado (desktop). */}
        <div className="flex shrink-0 flex-col items-end gap-1 md:flex-row md:items-center md:gap-2.5">
          <span
            className={`whitespace-nowrap text-[15px] font-semibold tabular-nums font-geist ${
              isEntrada ? 'text-[#1E924A]' : 'text-lifeone-ink'
            }`}
          >
            {isEntrada ? '+' : '−'} {formatCurrency(item.valor / 100)}
          </span>
          {statusControl}
        </div>

        {/* Ações secundárias: ícones inline no desktop; "⋯" sheet no mobile. */}
        {actions.length > 0 && (
          <>
            <div className="hidden shrink-0 items-center gap-0.5 md:flex">
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  aria-label={a.label}
                  title={a.label}
                  onClick={a.onClick}
                  className={`rounded-lg p-2 transition-colors ${
                    a.danger
                      ? 'text-lifeone-ink-4 hover:bg-[#FCEBE9] hover:text-[#D92D20]'
                      : 'text-lifeone-ink-4 hover:bg-[#E6EFFE] hover:text-lifeone-blue'
                  }`}
                >
                  <a.Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label="Mais ações"
              onClick={() => setMenuOpen(true)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-lifeone-ink-4 transition-colors hover:bg-lifeone-sidebar hover:text-lifeone-ink-2 md:hidden"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      {menuOpen && (
        <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title={titulo} variant="sheet" size="sm">
          <div className="flex flex-col gap-1 pb-2">
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  a.onClick();
                }}
                className={`flex min-h-[52px] items-center gap-3 rounded-xl px-3 text-left text-[15px] font-medium transition-colors ${
                  a.danger
                    ? 'text-[#D92D20] hover:bg-[#FCEBE9]'
                    : 'text-lifeone-ink hover:bg-lifeone-sidebar'
                }`}
              >
                <a.Icon className="h-5 w-5 shrink-0" />
                {a.label}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
