'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { CreditCard, Plus, Trash2, Link2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonList } from '@/components/ui/Skeleton';
import CardFormModal from './_components/CardFormModal';
import LinkSuggestionsPanel from './_components/LinkSuggestionsPanel';
import type { CardRow } from './_types';

function limitStatus(percent: number) {
  if (percent >= 100) {
    return {
      label: 'Limite estourado',
      badgeClass: 'bg-red-100 text-red-700 border-red-200',
      barClass: 'bg-red-600',
    };
  }
  if (percent >= 80) {
    return {
      label: 'Atenção',
      badgeClass: 'bg-amber-100 text-amber-700 border-amber-200',
      barClass: 'bg-amber-500',
    };
  }
  if (percent >= 60) {
    return {
      label: 'Uso moderado',
      badgeClass: 'bg-orange-100 text-orange-700 border-orange-200',
      barClass: 'bg-orange-500',
    };
  }
  return {
    label: 'Dentro do limite',
    badgeClass: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    barClass: 'bg-emerald-500',
  };
}

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
        <SkeletonList rows={2} />
      ) : cards.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="Nenhum cartão cadastrado"
          description="Comece adicionando um cartão para importar faturas e acompanhar o limite."
          action={{
            label: 'Novo cartão',
            onClick: () => { setEditing(null); setFormOpen(true); },
          }}
        />
      ) : (
        <div className="grid gap-3">
          {cards.map((c) => {
            const usedCents = c.limitUsedCents ?? 0;
            const availableCents = c.limitAvailableComputedCents ?? (c.limitTotalCents != null ? c.limitTotalCents - usedCents : 0);
            const usagePercent = c.limitUsagePercent ?? (c.limitTotalCents && c.limitTotalCents > 0 ? Math.round((usedCents / c.limitTotalCents) * 100) : 0);
            const status = limitStatus(usagePercent);

            return (
              <div key={c.id} className="border rounded-lg p-4 bg-white flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {c.nickname ?? `${c.brand} ****${c.last4}`}
                  </div>
                  <div className="text-xs text-gray-500">
                    {c.institution} · {c.brand} · final {c.last4}
                    {c.limitTotalCents != null && (
                      <> · limite {formatCurrency(c.limitTotalCents / 100)}</>
                    )}
                  </div>
                  {c.limitTotalCents != null && (
                    <div className="mt-3 max-w-xl">
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-slate-800">
                          {formatCurrency(usedCents / 100)} de {formatCurrency(c.limitTotalCents / 100)}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 font-medium ${status.badgeClass}`}>
                          {status.label}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${status.barClass}`}
                          style={{ width: `${Math.min(Math.max(usagePercent, 0), 100)}%` }}
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-gray-500">
                        <span>{usagePercent}% usado</span>
                        <span>disponível {formatCurrency(availableCents / 100)}</span>
                      </div>
                    </div>
                  )}
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
            );
          })}
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
