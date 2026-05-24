'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { X, Link2, Unlink, ExternalLink } from 'lucide-react';
import type { CardRow, SuggestionRow } from '../_types';

interface Props {
  projectId: string;
  card: CardRow;
  onClose: () => void;
}

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  REFORMA: { label: 'Reforma', color: 'bg-orange-100 text-orange-700' },
  COMPRA: { label: 'Compra', color: 'bg-purple-100 text-purple-700' },
  CASA: { label: 'Casa', color: 'bg-green-100 text-green-700' },
  CARRO: { label: 'Carro', color: 'bg-blue-100 text-blue-700' },
  PESSOAL: { label: 'Pessoal', color: 'bg-gray-100 text-gray-700' },
};

export default function LinkSuggestionsPanel({ projectId, card, onClose }: Props) {
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<SuggestionRow[]>(
        `/projects/${projectId}/credit-cards/${card.id}/suggest-links`,
      );
      setRows(data);
    } finally {
      setLoading(false);
    }
  }, [projectId, card.id]);

  useEffect(() => { void load(); }, [load]);

  async function handleLink(expenseId: string, targetId: string) {
    setActingOn(expenseId);
    try {
      await api.post(`/projects/${projectId}/credit-cards/transactions/${expenseId}/link`, {
        targetExpenseId: targetId,
      });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erro ao vincular');
    } finally {
      setActingOn(null);
    }
  }

  async function handleUnlink(expenseId: string) {
    setActingOn(expenseId);
    try {
      await api.delete(`/projects/${projectId}/credit-cards/transactions/${expenseId}/link`);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Erro ao desvincular');
    } finally {
      setActingOn(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Link2 className="w-5 h-5" /> Vincular transações — {card.nickname ?? card.last4}
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Vincule transações do cartão a despesas planejadas de outros projetos (reforma, casa, carro).
          A despesa alvo vira PAGA e a transação aqui deixa de contar como pessoal (evita dupla contagem).
        </p>

        {loading ? (
          <div className="text-gray-500">Carregando…</div>
        ) : rows.length === 0 ? (
          <div className="bg-gray-50 rounded-lg p-12 text-center text-gray-500">
            Nenhuma transação importada para este cartão ainda.
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map(({ expense, suggestions }) => (
              <div key={expense.id} className="border rounded-lg p-3 bg-white">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{expense.titulo ?? expense.fornecedor}</div>
                    <div className="text-xs text-gray-500">
                      {new Date(expense.data).toLocaleDateString('pt-BR')} ·
                      <span className="font-mono ml-1">{formatCurrency(expense.valor / 100)}</span>
                      {expense.status === 'PAGO' && <span className="ml-1 text-green-700">· pago</span>}
                    </div>
                  </div>
                  {expense.linkedExpenseId && (
                    <button
                      onClick={() => handleUnlink(expense.id)}
                      disabled={actingOn === expense.id}
                      className="text-xs px-2 py-1 border border-red-200 text-red-600 rounded hover:bg-red-50 flex items-center gap-1 disabled:opacity-50"
                    >
                      <Unlink className="w-3 h-3" /> Desvincular
                    </button>
                  )}
                </div>

                {!expense.linkedExpenseId && suggestions.length > 0 && (
                  <div className="mt-2 pl-3 border-l-2 border-blue-200 space-y-1">
                    <div className="text-xs text-gray-500">Possíveis correspondências:</div>
                    {suggestions.map((s) => {
                      const badge = TYPE_BADGE[s.projectType] ?? { label: s.projectType, color: 'bg-gray-100 text-gray-700' };
                      return (
                        <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
                          <div className="min-w-0 flex-1">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${badge.color} mr-1`}>{badge.label}</span>
                            <span className="text-gray-700">{s.projectName} · {s.titulo ?? s.fornecedor}</span>
                            <span className="text-xs text-gray-500 ml-2">
                              {formatCurrency(s.valor / 100)} · {new Date(s.data).toLocaleDateString('pt-BR')}
                            </span>
                          </div>
                          <button
                            onClick={() => handleLink(expense.id, s.id)}
                            disabled={actingOn === expense.id}
                            className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1 disabled:opacity-50"
                          >
                            <ExternalLink className="w-3 h-3" /> Vincular
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!expense.linkedExpenseId && suggestions.length === 0 && (
                  <div className="mt-1 text-xs text-gray-400">Sem sugestões.</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
