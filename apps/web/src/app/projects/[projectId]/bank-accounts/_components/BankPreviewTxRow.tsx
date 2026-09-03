'use client';

import { formatCurrency, formatDateBR } from '@/lib/utils';
import { centsToReaisInput, currencyInputToCents, maskCurrencyInputPositive } from '@/lib/currency-input';
import { Trash2, Link2, RotateCcw, Check, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import type { BankPreviewTx, BankCrossProjectMatch, BankCardCandidate } from '../_types';
import type { BankImportDecision, BankTxState } from './ImportBankStatementModal';
import { CategoriaFonteChip } from '@/components/import/ImportClassificationNotice';
import { CREDIT_CATEGORIES, DEBIT_CATEGORIES, categoryLabel } from '../_lib/import-categories';

/** "2026-08" → "ago/2026". */
function formatDueMonth(dueMonth: string): string {
  const [year, month] = dueMonth.split('-').map(Number);
  if (!year || !month) return dueMonth;
  const nome = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${nome[month - 1] ?? month}/${year}`;
}

/**
 * Uma opção por cartão (a fatura mais próxima do valor pago, que vem primeiro),
 * garantindo que o cartão já selecionado esteja sempre na lista — ele pode ter
 * vindo do last4 do texto do extrato, sem fatura em aberto para casar.
 */
function dedupeByCard(
  candidates: BankCardCandidate[],
  selected: string | null,
): BankCardCandidate[] {
  const seen = new Set<string>();
  const out: BankCardCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.cardLast4)) continue;
    seen.add(c.cardLast4);
    out.push(c);
  }
  if (selected && !seen.has(selected)) {
    out.unshift({
      cardLast4: selected,
      nickname: 'Cartão',
      dueMonth: '',
      invoiceTotalCents: 0,
      deltaCents: 0,
    });
  }
  return out;
}

interface RowProps {
  tx: BankPreviewTx;
  state: BankTxState;
  onChange: (patch: Partial<BankTxState>) => void;
  onClearDecision: () => void;
}

export function BankPreviewTxRow({ tx, state, onChange, onClearDecision }: RowProps) {
  const isCredit = tx.amountCents < 0;
  const isSkipped = state.decision?.action === 'skip';
  const isLinked = state.decision?.action === 'link';
  const matches = tx.crossProjectMatches ?? [];
  const valorCents = state.decision?.overrides?.valorCents ?? Math.abs(tx.amountCents);
  const titulo = state.decision?.overrides?.titulo ?? tx.merchant;
  const categories = isCredit ? CREDIT_CATEGORIES : DEBIT_CATEGORIES;
  const categoryOverridden = state.decision?.overrides?.category != null;
  const category = state.decision?.overrides?.category ?? tx.suggestedCategory ?? (isCredit ? 'OUTROS' : 'OUTROS');
  // O <select> tem lista fixa; um `suggestedCategory` fora dela (ex.: TRANSFERENCIA_TED
  // vindo de uma regra, RECEITA numa entrada) deixaria o campo em branco — injeta a
  // opção correspondente para o valor selecionado ficar sempre visível.
  const knownCategoryValues = new Set(categories.map((c) => c.value));
  const showDynamicCategoryOption = !!category && !knownCategoryValues.has(category);
  const cardLast4 = state.decision?.overrides?.cardLast4 ?? null;
  // Mostra o seletor sempre que a linha for tratada como pagamento de fatura —
  // seja por detecção do backend (que já sugere a categoria) ou por escolha
  // manual. Some se o usuário recategorizar a linha.
  const isCardPaymentRow = !isCredit && category === 'PAGAMENTO_FATURA_CARTAO';
  const cardOptions = dedupeByCard(tx.cardCandidates ?? [], cardLast4);

  function setOverride(patch: Partial<NonNullable<BankImportDecision['overrides']>>) {
    onChange({
      decision: {
        ...(state.decision ?? { externalId: tx.externalId, action: 'create' }),
        externalId: tx.externalId,
        overrides: { ...(state.decision?.overrides ?? {}), ...patch },
      },
    });
  }

  function setAction(
    action: 'skip' | 'link' | 'create',
    linkToExpenseId?: string,
    linkToReceiptId?: string,
  ) {
    onChange({
      decision: {
        ...(state.decision ?? { externalId: tx.externalId }),
        externalId: tx.externalId,
        action,
        linkToExpenseId,
        linkToReceiptId,
      },
    });
  }

  const rowClass = isSkipped
    ? 'bg-red-50 line-through text-gray-400'
    : isLinked
      ? 'bg-green-50'
      : tx.duplicate
        ? 'bg-yellow-50 text-gray-500'
        : '';

  return (
    <div className={`border-b p-3 ${rowClass}`}>
      <div className="flex items-start gap-2 flex-wrap">
        <div className="flex items-center justify-center w-7" title={isCredit ? 'Crédito (entrada)' : 'Débito (saída)'}>
          {isCredit
            ? <ArrowDownCircle className="w-5 h-5 text-green-600" />
            : <ArrowUpCircle className="w-5 h-5 text-red-600" />}
        </div>

        <div className="flex-1 min-w-[200px]">
          <input
            type="text"
            value={titulo}
            disabled={isSkipped}
            onChange={(e) => setOverride({ titulo: e.target.value })}
            className="w-full px-2 py-1 border rounded text-sm disabled:bg-transparent disabled:border-transparent"
          />
          <div className="text-xs text-gray-500 mt-1">{formatDateBR(tx.date)}</div>
        </div>

        <div className="w-32">
          <input
            type="text"
            inputMode="numeric"
            value={centsToReaisInput(valorCents)}
            disabled={isSkipped}
            onChange={(e) => setOverride({ valorCents: currencyInputToCents(maskCurrencyInputPositive(e.target.value)) || 0 })}
            className={`w-full px-2 py-1 border rounded text-sm text-right font-mono ${isCredit ? 'text-green-700' : 'text-red-700'}`}
          />
        </div>

        <div className="w-44">
          <select
            value={category}
            disabled={isSkipped}
            onChange={(e) => setOverride({ category: e.target.value })}
            className="w-full px-2 py-1 border rounded text-sm"
          >
            {showDynamicCategoryOption && (
              <option value={category}>{categoryLabel(category)}</option>
            )}
            {categories.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          {!categoryOverridden && <CategoriaFonteChip fonte={tx.categoriaFonte} />}
        </div>

        <div className="flex gap-1">
          {!isSkipped ? (
            <button
              onClick={() => setAction('skip')}
              title="Excluir desta importação"
              className="p-1.5 text-red-600 hover:bg-red-100 rounded"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={onClearDecision}
              title="Restaurar"
              className="p-1.5 text-gray-600 hover:bg-gray-100 rounded"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {tx.duplicate && (
        <div className="text-xs text-yellow-700 mt-1 italic">
          ↻ Já importada anteriormente (será ignorada)
        </div>
      )}

      {isCardPaymentRow && !isSkipped && (
        <div className="mt-2 pl-3 border-l-2 border-purple-300 space-y-1">
          <div className="text-xs text-purple-800 font-medium">
            💳 Pagamento de fatura — qual cartão isso quita?
          </div>
          <select
            value={cardLast4 ?? ''}
            onChange={(e) => setOverride({ cardLast4: e.target.value || undefined })}
            className="w-full px-2 py-1.5 border rounded text-sm min-h-11"
          >
            <option value="">Não identificado — não quita fatura nenhuma</option>
            {cardOptions.map((c) => (
              <option key={`${c.cardLast4}-${c.dueMonth}`} value={c.cardLast4}>
                {c.dueMonth
                  ? `${c.nickname} ••${c.cardLast4} · fatura ${formatDueMonth(c.dueMonth)} · ${formatCurrency(c.invoiceTotalCents / 100)}${
                      c.deltaCents === 0
                        ? ' (valor exato)'
                        : ` (dif. ${formatCurrency(Math.abs(c.deltaCents) / 100)})`
                    }`
                  : `${c.nickname} ••${c.cardLast4} · sem fatura em aberto para casar`}
              </option>
            ))}
          </select>
          {!cardLast4 && (
            <div className="text-xs text-amber-700">
              ⚠ Sem cartão, o valor sai do seu saldo mas a fatura continua em aberto — o
              mesmo dinheiro conta duas vezes.
            </div>
          )}
        </div>
      )}

      {matches.length > 0 && !isSkipped && (
        <div className="mt-2 pl-3 border-l-2 border-blue-300 space-y-1">
          <div className="text-xs text-blue-700 font-medium">
            📌 {isCredit ? 'Recebimento previsto' : 'Despesa planejada'} em outro(s) projeto(s):
          </div>
          {matches.map((m) => {
            const id = m.kind === 'expense' ? m.expenseId : m.receiptId;
            const isThisLinked = isLinked && (
              (m.kind === 'expense' && state.decision?.linkToExpenseId === id) ||
              (m.kind === 'receipt' && state.decision?.linkToReceiptId === id)
            );
            return (
              <BankMatchChip
                key={id}
                match={m}
                isLinked={isThisLinked}
                onLink={() => setAction(
                  'link',
                  m.kind === 'expense' ? m.expenseId : undefined,
                  m.kind === 'receipt' ? m.receiptId : undefined,
                )}
                onUnlink={onClearDecision}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function BankMatchChip({
  match,
  isLinked,
  onLink,
  onUnlink,
}: {
  match: BankCrossProjectMatch;
  isLinked: boolean;
  onLink: () => void;
  onUnlink: () => void;
}) {
  const delta = match.deltaCents;
  const deltaTxt = delta === 0 ? 'igual' : `${delta > 0 ? '+' : ''}${formatCurrency(delta / 100)}`;
  return (
    <div className="flex items-center justify-between text-xs bg-white rounded px-2 py-1">
      <div className="flex-1">
        <span className="font-semibold">{match.projectName}</span>
        <span className="text-gray-500"> · {match.titulo ?? '(sem título)'}</span>
        {match.kind === 'expense' && match.installmentCurrent && match.installmentTotal && (
          <span className="text-gray-500"> · parcela {match.installmentCurrent}/{match.installmentTotal}</span>
        )}
        <span className="text-gray-500"> · {formatCurrency(match.valorCents / 100)}</span>
        <span className="text-gray-400"> · {formatDateBR(match.data)} · Δ {deltaTxt}</span>
      </div>
      {isLinked ? (
        <button
          onClick={onUnlink}
          className="flex items-center gap-1 px-2 py-0.5 bg-green-600 text-white rounded text-xs"
        >
          <Check className="w-3 h-3" /> Vinculado
        </button>
      ) : (
        <button
          onClick={onLink}
          title={match.kind === 'expense'
            ? 'Marcar despesa planejada como PAGA'
            : 'Marcar recebimento previsto como EM CAIXA'}
          className="flex items-center gap-1 px-2 py-0.5 border border-blue-600 text-blue-600 hover:bg-blue-50 rounded text-xs"
        >
          <Link2 className="w-3 h-3" />
          {match.kind === 'expense' ? 'Vincular como pago' : 'Vincular como recebido'}
        </button>
      )}
    </div>
  );
}
