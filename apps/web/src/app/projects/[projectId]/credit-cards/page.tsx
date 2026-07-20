'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import { formatCurrency } from '@/lib/utils';
import { CreditCard, Plus, Trash2, Link2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonList } from '@/components/ui/Skeleton';
import { CreditCardVisual } from '@/components/CreditCardVisual';
import CardFormModal from './_components/CardFormModal';
import LinkSuggestionsPanel from './_components/LinkSuggestionsPanel';
import AccountFormModal from '../_components/AccountFormModal';
import type { CardRow } from './_types';

function limitLabel(percent: number) {
  if (percent >= 100) return 'Limite estourado';
  if (percent >= 80) return 'Atenção';
  if (percent >= 60) return 'Uso moderado';
  return 'Dentro do limite';
}

export default function CreditCardsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = String(params?.projectId ?? '');
  const { projectType } = useProject();
  const [cards, setCards] = useState<CardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CardRow | null>(null);
  const [linksFor, setLinksFor] = useState<CardRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const scopedCards = await api.get<CardRow[]>(`/projects/${projectId}/credit-cards`);
      if (projectType === 'PESSOAL' && scopedCards.length === 0) {
        const tenantCards = await api.get<CardRow[]>('/tenant/credit-cards');
        setCards(tenantCards);
        return;
      }
      setCards(scopedCards);
    } catch (error) {
      setCards([]);
      setLoadError(error instanceof Error ? error.message : 'Não foi possível carregar os cartões.');
    } finally {
      setLoading(false);
    }
  }, [projectId, projectType]);

  useEffect(() => {
    if (projectId) void load();
  }, [projectId, load]);

  // Deep-link: ?focus=closingDay&last4=XXXX auto-opens card edit
  useEffect(() => {
    if (loading || searchParams.get('focus') !== 'closingDay') return;
    const targetLast4 = searchParams.get('last4');
    const target = targetLast4 ? cards.find((c) => c.last4 === targetLast4) : cards[0];
    if (target) {
      setEditing(target);
      setFormOpen(true);
    } else if (cards.length === 0) {
      setEditing(null);
      setFormOpen(true);
    }
  }, [loading, cards, searchParams]);

  async function handleDelete(card: CardRow) {
    const cardProjectId = card.projectId ?? projectId;
    if (!confirm(`Excluir cartão "${card.nickname ?? card.last4}"? As despesas importadas serão mantidas.`)) return;
    await api.delete(`/projects/${cardProjectId}/credit-cards/${card.id}`);
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
      ) : loadError ? (
        <EmptyState
          icon={CreditCard}
          title="Não foi possível carregar os cartões"
          description={loadError}
          action={{
            label: 'Tentar novamente',
            onClick: () => void load(),
          }}
        />
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => {
            const usedCents = c.limitUsedCents ?? 0;
            const availableCents = c.limitAvailableComputedCents ?? (c.limitTotalCents != null ? c.limitTotalCents - usedCents : 0);
            const usagePercent = c.limitUsagePercent ?? (c.limitTotalCents && c.limitTotalCents > 0 ? Math.round((usedCents / c.limitTotalCents) * 100) : 0);
            const hasLimit = c.limitTotalCents != null;

            return (
              <div key={c.id} className="flex flex-col gap-2">
                <CreditCardVisual
                  last4={c.last4}
                  nickname={c.nickname ?? c.institution}
                  brand={c.brand}
                  topRight={
                    hasLimit ? (
                      <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                        {limitLabel(usagePercent)}
                      </span>
                    ) : undefined
                  }
                  footer={
                    <div className="flex items-end justify-between gap-2">
                      <div className="min-w-0">
                        {hasLimit ? (
                          <>
                            <p className="text-[10px] uppercase tracking-wide text-white/60">Disponível</p>
                            <p className="font-geist text-[18px] font-bold tabular-nums leading-tight">
                              {formatCurrency(availableCents / 100)}
                            </p>
                          </>
                        ) : (
                          <p className="text-[11px] uppercase tracking-[0.12em] text-white/60">
                            {c.institution}
                          </p>
                        )}
                      </div>
                      <p className="shrink-0 text-[11px] text-white/70">
                        {c.closingDay != null ? `fecha dia ${c.closingDay}` : 'fechamento —'}
                        {' · '}
                        {c.dueDay != null ? `vence dia ${c.dueDay}` : 'vence —'}
                      </p>
                    </div>
                  }
                  limit={hasLimit ? { pct: usagePercent, used: usedCents, total: c.limitTotalCents } : undefined}
                />

                <div className="flex gap-2">
                  <button
                    onClick={() => setLinksFor(c)}
                    className="flex flex-1 items-center justify-center gap-1 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    <Link2 className="h-4 w-4" /> Vincular
                  </button>
                  <button
                    onClick={() => { setEditing(c); setFormOpen(true); }}
                    className="flex-1 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleDelete(c)}
                    aria-label="Excluir cartão"
                    className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {formOpen && (
        editing ? (
          <CardFormModal
            projectId={editing.projectId ?? projectId}
            card={editing}
            onClose={() => { setFormOpen(false); setEditing(null); }}
            onSaved={() => { setFormOpen(false); setEditing(null); void load(); }}
          />
        ) : (
          <AccountFormModal
            projectId={projectId}
            defaultType="CARD"
            onClose={() => setFormOpen(false)}
            onSaved={() => { setFormOpen(false); void load(); }}
          />
        )
      )}
      {linksFor && (
        <LinkSuggestionsPanel
          projectId={linksFor.projectId ?? projectId}
          card={linksFor}
          onClose={() => setLinksFor(null)}
        />
      )}
    </div>
  );
}
