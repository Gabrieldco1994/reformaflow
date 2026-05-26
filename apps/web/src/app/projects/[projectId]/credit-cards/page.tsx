'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { CreditCard, Plus, Trash2, Link2 } from 'lucide-react';
import CardFormModal from './_components/CardFormModal';
import LinkSuggestionsPanel from './_components/LinkSuggestionsPanel';
import type { CardRow } from './_types';

export default function CreditCardsPage() {
  const params = useParams();
  const projectId = String(params?.projectId ?? '');
  const [cards, setCards] = useState<CardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CardRow | null>(null);
  const [linksFor, setLinksFor] = useState<CardRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<CardRow[]>(`/projects/${projectId}/credit-cards`);
      setCards(data);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) void load();
  }, [projectId, load]);

  async function handleDelete(card: CardRow) {
    if (!confirm(`Excluir cartão "${card.nickname ?? card.last4}"? As despesas importadas serão mantidas.`)) return;
    await api.delete(`/projects/${projectId}/credit-cards/${card.id}`);
    void load();
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <CreditCard className="w-6 h-6" /> Cartões de Crédito
        </h1>
        <button
          onClick={() => { setEditing(null); setFormOpen(true); }}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Novo cartão
        </button>
      </div>

      <p className="text-sm text-gray-600 mb-6">
        Importe faturas em <strong>OFX</strong> ou <strong>CSV</strong> (Itaú/Nubank). Parcelas futuras
        são criadas como planejadas e viram pagas automaticamente quando você importar a fatura do mês seguinte.
      </p>

      {loading ? (
        <div className="text-gray-500">Carregando…</div>
      ) : cards.length === 0 ? (
        <div className="bg-gray-50 rounded-lg p-12 text-center text-gray-500">
          Nenhum cartão cadastrado. Comece adicionando um.
        </div>
      ) : (
        <div className="grid gap-3">
          {cards.map((c) => (
            <div key={c.id} className="border rounded-lg p-4 bg-white flex items-center justify-between">
              <div>
                <div className="font-semibold">
                  {c.nickname ?? `${c.brand} ****${c.last4}`}
                </div>
                <div className="text-xs text-gray-500">
                  {c.institution} · {c.brand} · final {c.last4}
                  {c.limitTotalCents != null && (
                    <> · limite {formatCurrency(c.limitTotalCents / 100)}</>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setLinksFor(c)}
                  className="px-3 py-2 text-sm border rounded-lg flex items-center gap-1 hover:bg-gray-50"
                >
                  <Link2 className="w-4 h-4" /> Vincular
                </button>
                <button
                  onClick={() => { setEditing(c); setFormOpen(true); }}
                  className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50"
                >
                  Editar
                </button>
                <button
                  onClick={() => handleDelete(c)}
                  className="px-3 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <CardFormModal
          projectId={projectId}
          card={editing}
          onClose={() => { setFormOpen(false); setEditing(null); }}
          onSaved={() => { setFormOpen(false); setEditing(null); void load(); }}
        />
      )}
      {linksFor && (
        <LinkSuggestionsPanel
          projectId={projectId}
          card={linksFor}
          onClose={() => setLinksFor(null)}
        />
      )}
    </div>
  );
}
