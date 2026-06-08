'use client';

import { formatCurrency, formatDateBR } from '@/lib/utils';
import { Trash2, Link2, RotateCcw, Check } from 'lucide-react';
import type { PreviewTx, CrossProjectMatch } from '../_types';
import type { ImportDecision, TxState } from './ImportStatementModal';

const PESSOAL_CATEGORIES = [
  { value: 'MORADIA', label: 'Moradia' },
  { value: 'ALIMENTACAO', label: 'Alimentação' },
  { value: 'TRANSPORTE', label: 'Transporte' },
  { value: 'SAUDE', label: 'Saúde' },
  { value: 'EDUCACAO', label: 'Educação' },
  { value: 'LAZER', label: 'Lazer' },
  { value: 'BELEZA', label: 'Beleza' },
  { value: 'PETS', label: 'Pets' },
  { value: 'SUPERMERCADO', label: 'Supermercado' },
  { value: 'FAXINEIRA', label: 'Faxineira' },
  { value: 'AJUDA', label: 'Ajuda' },
  { value: 'REEMBOLSO_MEDICO', label: 'Reembolso Médico' },
  { value: 'ACADEMIA', label: 'Academia' },
  { value: 'ASSINATURAS', label: 'Assinaturas' },
  { value: 'INVESTIMENTOS', label: 'Investimentos' },
  { value: 'SEGUROS_PESSOAIS', label: 'Seguros' },
  { value: 'IMPREVISTOS', label: 'Imprevistos' },
  { value: 'OUTROS', label: 'Outros' },
];

interface RowProps {
  tx: PreviewTx;
  state: TxState;
  onChange: (patch: Partial<TxState>) => void;
  onClearDecision: () => void;
}

export function PreviewTxRow({ tx, state, onChange, onClearDecision }: RowProps) {
  const isSkipped = state.decision?.action === 'skip';
  const isLinked = state.decision?.action === 'link';
  const matches = tx.crossProjectMatches ?? [];
  const valorCents = state.decision?.overrides?.valorCents ?? tx.amountCents;
  const titulo = state.decision?.overrides?.titulo ?? tx.merchant;
  const category = state.decision?.overrides?.category ?? tx.suggestedCategory ?? 'OUTROS';

  function setOverride(patch: Partial<NonNullable<ImportDecision['overrides']>>) {
    onChange({
      decision: {
        ...(state.decision ?? { externalId: tx.externalId, action: 'create' }),
        externalId: tx.externalId,
        overrides: { ...(state.decision?.overrides ?? {}), ...patch },
      },
    });
  }

  function setAction(action: 'skip' | 'link' | 'create', linkToExpenseId?: string) {
    onChange({
      decision: {
        ...(state.decision ?? { externalId: tx.externalId }),
        externalId: tx.externalId,
        action,
        linkToExpenseId,
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
        <div className="flex-1 min-w-[200px]">
          <input
            type="text"
            value={titulo}
            disabled={isSkipped}
            onChange={(e) => setOverride({ titulo: e.target.value })}
            className="w-full px-2 py-1 border rounded text-sm disabled:bg-transparent disabled:border-transparent"
          />
          <div className="text-xs text-gray-500 mt-1">
            {formatDateBR(tx.date)}
            {tx.installmentCurrent && tx.installmentTotal
              ? ` · parc. ${tx.installmentCurrent}/${tx.installmentTotal}`
              : ''}
          </div>
        </div>

        <div className="w-32">
          <input
            type="number"
            step="0.01"
            value={(valorCents / 100).toFixed(2)}
            disabled={isSkipped}
            onChange={(e) => setOverride({ valorCents: Math.round(parseFloat(e.target.value) * 100) || 0 })}
            className="w-full px-2 py-1 border rounded text-sm text-right font-mono"
          />
        </div>

        <div className="w-40">
          <select
            value={category}
            disabled={isSkipped}
            onChange={(e) => setOverride({ category: e.target.value })}
            className="w-full px-2 py-1 border rounded text-sm"
          >
            {PESSOAL_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
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

      {matches.length > 0 && !isSkipped && (
        <div className="mt-2 pl-3 border-l-2 border-blue-300 space-y-1">
          <div className="text-xs text-blue-700 font-medium">
            📌 Encontrado em outro(s) projeto(s):
          </div>
          {matches.map((m) => {
            const isThisLinked = isLinked && state.decision?.linkToExpenseId === m.expenseId;
            return (
              <MatchChip
                key={m.expenseId}
                match={m}
                isLinked={isThisLinked}
                onLink={() => setAction('link', m.expenseId)}
                onUnlink={onClearDecision}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function MatchChip({
  match,
  isLinked,
  onLink,
  onUnlink,
}: {
  match: CrossProjectMatch;
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
          title="Marcar a despesa planejada como PAGA (vincula esta importação a ela)"
          className="flex items-center gap-1 px-2 py-0.5 border border-blue-600 text-blue-600 hover:bg-blue-50 rounded text-xs"
        >
          <Link2 className="w-3 h-3" /> Vincular como pago
        </button>
      )}
    </div>
  );
}
