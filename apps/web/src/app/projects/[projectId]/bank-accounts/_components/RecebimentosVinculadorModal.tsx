'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { X, Check } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';

export interface ReceiptWithoutAccount {
  id: string;
  valor: number; // centavos
  data: string; // ISO date
  tipo: string;
  descricao?: string;
  status: 'PREVISTO' | 'EM_CAIXA';
}

interface Props {
  projectId: string;
  accountId: string;
  receipts: ReceiptWithoutAccount[];
  onClose: () => void;
  onSuccess: () => void;
}

const RECEIPT_TYPE_LABELS: Record<string, string> = {
  PAGAMENTO: 'Pagamento',
  BONUS: 'Bônus',
  VENDA_ACAO: 'Venda de ação',
  ORCAMENTO_INICIAL: 'Orçamento inicial',
  RENDIMENTO: 'Rendimento',
  TRANSFERENCIA: 'Transferência',
  RESGATE: 'Resgate',
  JUROS_RENDA_FIXA: 'Juros',
  OUTROS: 'Outros',
};

export default function RecebimentosVinculadorModal({
  projectId,
  accountId,
  receipts,
  onClose,
  onSuccess,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(receipts.map((r) => r.id)));
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLinkAll() {
    if (selected.size === 0) {
      setError('Selecione pelo menos um recebimento');
      return;
    }

    setError(null);
    setLinking(true);

    try {
      const selectedReceipts = receipts.filter((r) => selected.has(r.id));

      // Link each receipt to the account
      await Promise.all(
        selectedReceipts.map((receipt) =>
          api.patch(`/projects/${projectId}/receipts/${receipt.id}`, {
            accountId,
            origin: 'account',
          }),
        ),
      );

      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao vincular recebimentos');
    } finally {
      setLinking(false);
    }
  }

  function toggleReceipt(id: string) {
    const newSelected = new Set(selected);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelected(newSelected);
  }

  function toggleAll() {
    if (selected.size === receipts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(receipts.map((r) => r.id)));
    }
  }

  const scrollableClass = receipts.length > 5 ? 'max-h-96 overflow-y-auto' : '';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-md p-6 shadow-lg">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold text-gray-900">Vincular recebimentos</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Você tem {receipts.length} recebimento{receipts.length !== 1 ? 's' : ''} sem conta. Selecione
          quais deseja vincular:
        </p>

        {/* Header com checkbox "Selecionar tudo" */}
        <div className="mb-3 pb-3 border-b border-gray-200">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.size === receipts.length && receipts.length > 0}
              onChange={toggleAll}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer"
            />
            <span className="text-sm font-medium text-gray-700">
              Selecionar tudo ({selected.size}/{receipts.length})
            </span>
          </label>
        </div>

        {/* Lista de recebimentos */}
        <div className={`space-y-2 mb-4 ${scrollableClass}`}>
          {receipts.map((receipt) => (
            <label
              key={receipt.id}
              className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                checked={selected.has(receipt.id)}
                onChange={() => toggleReceipt(receipt.id)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer mt-1 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {RECEIPT_TYPE_LABELS[receipt.tipo] || receipt.tipo}
                  </p>
                  <p className="text-sm font-bold text-gray-900 whitespace-nowrap">
                    {formatCurrency(receipt.valor / 100)}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-gray-500">{formatDateBR(receipt.data)}</p>
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      receipt.status === 'EM_CAIXA'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {receipt.status === 'EM_CAIXA' ? 'Em caixa' : 'Previsto'}
                  </span>
                </div>
                {receipt.descricao && (
                  <p className="text-xs text-gray-500 mt-1 truncate">{receipt.descricao}</p>
                )}
              </div>
            </label>
          ))}
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={linking}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleLinkAll}
            disabled={linking || selected.size === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {linking ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Vinculando…
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                Vincular ({selected.size})
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
