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
  RotateCcw,
  SlidersHorizontal,
  Split,
  Trash2,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { getExpenseIcon, getReceiptIcon } from '@/lib/expense-icons';
import { invoiceActionAllowed } from '../_lib';
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
  onUndoPayment,
  onQuitar,
  onRemoveExpense,
  onRemoveReceita,
  onRatear,
  onVincular,
  onConfirmSuggestion,
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
  /** Desfazer pagamento de fatura já registrado (linha de fatura paga/parcial). */
  onUndoPayment?: (cardLast4: string) => void;
  onQuitar: (target: QuitarTarget) => void;
  onRemoveExpense: (id: string, projectId?: string) => void;
  onRemoveReceita: (id: string) => void;
  /** Ratear uma compra PESSOAL entre planejadas de outro projeto. */
  onRatear?: (item: AccountViewSaida) => void;
  /** Vincular (espelhar) uma compra PESSOAL em outro projeto. */
  onVincular?: (item: AccountViewSaida) => void;
  /** Confirma sugestão de categoria e aprende regra manual. */
  onConfirmSuggestion?: (item: AccountViewSaida, tipoDespesa: string) => void;
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
      ? item.title || item.descricao || tipoLabel(item.tipoDespesa)
      : item.title || item.descricao;

  // Saída sem cartão nem conta bancária → pseudo-origem Carteira.
  // NÃO incluir o retorno de originLabel no meta text — chip separado.
  const isCarteira = item.kind === 'saida' && !item.isInvoice && !item.cardLast4 && !item.bankLast4;

  const origem =
    item.kind === 'saida'
      ? originLabel(item.cardLast4, item.bankLast4)
      : originLabel(null, item.bankLast4);

  const dp = dateParts(item.data);
  const dateStr = dp.mes ? `${dp.dia} ${dp.mes}` : dp.dia;

  const meta = [
    dateStr,
    item.kind === 'saida' && !item.isInvoice ? (item.purposeLabel || tipoLabel(item.tipoDespesa)) : null,
    item.kind === 'entrada' && item.purposeLabel ? item.purposeLabel : null,
    item.kind === 'saida' && item.supplier ? item.supplier : null,
    item.kind === 'saida' &&
    item.isInvoice &&
    (item.invoicePaidAmount ?? 0) > 0 &&
    !item.realizado
      ? `Parcial: ${formatCurrency((item.invoicePaidAmount ?? 0) / 100)} de ${formatCurrency(item.valor / 100)}`
      : null,
    isCarteira ? null : origem,
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
  const status = isEntrada
    ? realizado
      ? { txt: 'Recebido', cls: 'text-[#1E924A]' }
      : { txt: 'Previsto', cls: 'text-[#B5803A]' }
    : invoiceStatusText === 'Parcial'
      ? { txt: 'Parcial', cls: 'text-[#B5803A]' }
      : realizado
        ? { txt: 'Paga', cls: 'text-[#1E924A]' }
        : { txt: 'A pagar', cls: 'text-[#B5803A]' };

  // Linha "saída" com edição/exclusão habilitadas no backend (item.editavel).
  const isSaidaEditavelBase = item.kind === 'saida' && item.editavel && !item.isInvoice;
  // Despesa de OUTRO projeto mostrada aqui só porque saiu/sai da carteira PESSOAL
  // (Carteira/"Sem conta"). Editar/excluir é permitido (feature "sem conta"), mas o
  // toggle RÁPIDO de status fica bloqueado: ele faria um PATCH {status} cru sem gerar
  // nenhum espelho de caixa, sumindo dinheiro do consolidado (regra de ouro 14) — só
  // "Quitar" (que gera o espelho) ou a edição feita no projeto de origem podem marcar
  // PAGO/PLANEJADO essas linhas.
  const belongsToForeignProject =
    item.kind === 'saida' && item.foreignExpenseId != null && item.projetoOrigem != null;
  const canToggle = isSaidaEditavelBase && !belongsToForeignProject;
  const canEditInvoicePayment =
    item.kind === 'saida' && item.isInvoice && item.editavel && !!item.id;
  // Parcela cross-project ainda PENDENTE: precisa ser QUITADA (gera espelho + concilia).
  const isPendingForeignParcela =
    item.kind === 'saida' &&
    !item.isInvoice &&
    !item.realizado &&
    item.parcelaIndex != null &&
    !!item.foreignExpenseId;
  const canEdit = isSaidaEditavelBase || canEditInvoicePayment || (isEntrada && !!item.id);
  const canToggleReceita = item.kind === 'entrada' && !!item.id;
  // Linhas de outro projeto usam `id` composto (`${expenseId}#${parcelaIndex}`) só p/
  // key de React; a API precisa do id REAL da despesa + do projeto DONO dela (não o
  // PESSOAL). foreignExpenseId sempre carrega o id real quando a linha é foreign.
  const effectiveExpenseId =
    item.kind === 'saida' && item.foreignExpenseId ? item.foreignExpenseId : item.id;
  const effectiveProjectId =
    item.kind === 'saida' && belongsToForeignProject ? (item.projetoOrigem?.id ?? undefined) : undefined;
  // Compra PESSOAL "solta" (não fatura, editável, sem vínculo cross) → pode ratear/vincular.
  const canCrossLink =
    item.kind === 'saida' && !item.isInvoice && item.editavel && !!item.id && item.projetoOrigem == null;
  const projOrigem =
    item.kind === 'saida' && item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL'
      ? item.projetoOrigem
      : null;
  const suggestionLabel =
    item.kind === 'saida' && !item.isInvoice && item.tipoDespesa === 'OUTROS' && item.suggestionTipoDespesa
      ? `${tipoLabel(item.suggestionTipoDespesa)}?`
      : null;

  const doEdit = () => {
    if (item.kind === 'saida') onEditExpense(item);
    else if (item.kind === 'entrada') onEditReceita(item);
  };
  const doDelete = () => {
    if (!item.id) return;
    if (item.kind === 'saida') {
      if (confirm('Excluir lançamento?')) onRemoveExpense(effectiveExpenseId!, effectiveProjectId);
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
    // "Ajustar" e "Quitar com resíduo" caem em `/invoice-adjustments`, que
    // deliberadamente NÃO tem 409 de final ambíguo (só lê o último4 e grava
    // `cardLast4`), então continuam com a regra local pura. Só o "Desfazer",
    // que vai para `undo-invoice-payment`, respeita o veto do servidor.
    actions.push({ key: 'ajustar', label: 'Ajustar fatura', Icon: SlidersHorizontal, onClick: () => onAdjustInvoice(card) });
    if (!item.realizado)
      actions.push({ key: 'residuo', label: 'Quitar com resíduo', Icon: CircleDollarSign, onClick: () => onSettleWithResidual(card) });
    if (invoiceActionAllowed(item, 'undo', Boolean(item.realizado && onUndoPayment)))
      actions.push({ key: 'desfazer', label: 'Desfazer pagamento', Icon: RotateCcw, onClick: () => onUndoPayment!(card) });
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
  const statusBaseClass =
    'inline-flex min-h-6 items-center justify-end text-[11px] font-semibold leading-none md:min-h-[30px]';
  // O chip de status da fatura É a CTA "Pagar fatura". Com veto do servidor
  // (`actions` sem 'pay' — final ambíguo, 409 garantido) ele degrada para chip
  // informativo: continua mostrando o status, deixa de prometer uma ação que a
  // API recusaria. Sem `actions`, comportamento idêntico ao de sempre.
  const canPayInvoiceRow = invoiceActionAllowed(
    item.kind === 'saida' ? item : null,
    'pay',
    !realizado && item.kind === 'saida' && Boolean(item.cardLast4),
  );
  const statusControl = isInvoiceRow ? (
    <button
      type="button"
      onClick={() => {
        if (canPayInvoiceRow && item.kind === 'saida' && item.cardLast4) onPayInvoice(item.cardLast4);
      }}
      disabled={!canPayInvoiceRow}
      className={`${statusBaseClass} ${status.cls} ${
        canPayInvoiceRow ? 'cursor-pointer hover:brightness-90' : 'cursor-default'
      }`}
      title={canPayInvoiceRow ? 'Pagar fatura' : undefined}
    >
      {status.txt}
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
      className="inline-flex min-h-6 items-center justify-end text-[11px] font-semibold text-lifeone-blue transition hover:brightness-90 md:min-h-[30px] md:justify-center md:rounded-full md:bg-lifeone-blue md:px-3.5 md:text-white"
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
      className={`${statusBaseClass} ${status.cls} ${
        canToggle || canToggleReceita ? 'cursor-pointer hover:brightness-90' : 'cursor-default'
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
      {status.txt}
    </button>
  );

  return (
    <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card transition-colors hover:border-lifeone-blue hover:shadow-lifeone-card md:rounded-2xl">
      <div className="flex items-start gap-2.5 px-2.5 py-2 md:items-center md:gap-3 md:px-4 md:py-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full md:h-10 md:w-10 ${iconCfg.bgColor} ${iconCfg.color}`}
        >
          <AvatarIcon className="h-4 w-4 md:h-[18px] md:w-[18px]" />
        </span>

        {/* Título + metadados: separados para o chip "Sem conta" não aninhar <button> dentro de <button>. */}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => {
              if (canExpand) onToggleExpand!();
              else if (canEdit) doEdit();
            }}
            className="w-full text-left"
            title={canExpand ? (expanded ? 'Recolher compras' : 'Ver compras da fatura') : canEdit ? 'Editar' : undefined}
          >
            <div className="flex items-center gap-1">
              {canExpand &&
                (expanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
                ))}
              <span className="truncate pr-1 text-[14px] font-semibold leading-tight text-lifeone-ink md:text-[15px]">{titulo}</span>
            </div>
          </button>
          <div className={`mt-0.5 flex min-w-0 items-center gap-1.5 ${canExpand ? 'pl-5' : ''}`}>
            <span className="truncate text-[11px] text-lifeone-ink-3">{meta}</span>
            {/* Chip "Sem conta" é redundante quando já há o controle "Quitar" (parcela
                foreign pendente): ambos abrem o mesmo fluxo de quitação. Esconder libera
                a linha para o nome do projeto respirar no mobile. */}
            {isCarteira && !isPendingForeignParcela && (
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (item.kind !== 'saida') return;
                  if (item.foreignExpenseId && item.parcelaIndex != null) {
                    onQuitar({
                      foreignExpenseId: item.foreignExpenseId,
                      parcelaIndex: item.parcelaIndex,
                      valorSugerido: item.valor,
                      descricao: item.descricao,
                      dataSugerida: item.data.slice(0, 10),
                    });
                    return;
                  }
                  if (onVincular) onVincular(item);
                }}
                className="shrink-0 rounded-full bg-[#F3F3F3] px-1.5 py-0.5 text-[11px] font-semibold text-lifeone-ink-3 transition-colors hover:bg-[#E6EFFE] hover:text-lifeone-blue"
                title="De onde saiu esse pagamento?"
              >
                Sem conta
              </button>
            )}
            {projOrigem && (
              <span className="min-w-0 shrink truncate rounded-full bg-[#E6EFFE] px-1.5 py-0.5 text-[11px] font-semibold text-lifeone-blue">
                {projOrigem.name}
              </span>
            )}
            {item.kind === 'saida' && item.isEspelho && (
              <span className="shrink-0 rounded-full bg-[#F3F3F3] px-1.5 py-0.5 text-[11px] font-semibold text-lifeone-ink-3">
                Espelho
              </span>
            )}
            {item.kind === 'saida' && item.installment && (
              <span className="shrink-0 text-[11px] text-lifeone-ink-3">
                {item.installment}
              </span>
            )}
            {suggestionLabel && onConfirmSuggestion && item.kind === 'saida' && item.suggestionTipoDespesa && (
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onConfirmSuggestion(item, item.suggestionTipoDespesa!);
                }}
                className="shrink-0 rounded-full bg-[#EAF7EE] px-1.5 py-0.5 text-[11px] font-semibold text-[#1E924A] transition-colors hover:bg-[#D9F1E1]"
                title="Confirmar categoria e criar regra"
              >
                {suggestionLabel}
              </button>
            )}
          </div>
        </div>

        {/* Cluster à direita: valor SEMPRE isolado (nowrap), status abaixo (mobile) ou ao lado (desktop). */}
        <div className="flex shrink-0 flex-col items-end gap-0">
          <span
            className={`whitespace-nowrap text-[14px] font-semibold tabular-nums font-geist md:text-[15px] ${
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
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lifeone-ink-4 transition-colors hover:bg-lifeone-sidebar hover:text-lifeone-ink-2 md:hidden"
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
