'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { isConsumptionNeutralExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { moneyDetail } from '@/lib/money';
import { tipoLabel } from '@/lib/expense-options';
import { addMonthKey, currentMonthKey, monthLabelLong, monthLabelShort } from '../../conta/_lib';
import type { AccountViewResponse, OriginItemsYearlyResponse } from '../../conta/_types';
import { deriveCardWalletStatus } from '../_lib/card-wallet-status';

function total(items: Array<{ valor: number }>) {
  return items.reduce((acc, item) => acc + item.valor, 0);
}

function groupByDay<T extends { data: string }>(items: T[]) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const day = item.data.slice(8, 10);
    map.set(day, [...(map.get(day) ?? []), item]);
  }
  return Array.from(map.entries()).sort((a, b) => Number(b[0]) - Number(a[0]));
}

export function MobileExpensesScreen() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [month, setMonth] = useState(currentMonthKey());
  const [originFilter, setOriginFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showNeutral, setShowNeutral] = useState(true);

  const year = month.slice(0, 4);

  const { data: accountView } = useQuery<AccountViewResponse>({
    queryKey: ['account-view', projectId, month],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview/account-view?month=${month}`),
    enabled: !!projectId,
  });

  // account-view sempre preenche dueMonth/vencimento (mesmo sem closingDay cadastrado);
  // buscar o cadastro do cartão para saber de verdade se falta configurar o fechamento
  // e não confundir "sem fechamento" com "fatura zerada / paga".
  const { data: creditCards } = useQuery<Array<{ last4: string; closingDay: number | null }>>({
    queryKey: ['tenant-credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
  });

  const { data: yearlyItems } = useQuery<OriginItemsYearlyResponse>({
    queryKey: ['origin-items-yearly', projectId, year, 'all'],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview/origin-items-yearly?year=${year}&kind=all`),
    enabled: !!projectId,
  });

  const monthItems = useMemo(
    () => (yearlyItems?.items ?? []).filter((item) => item.mes === month),
    [yearlyItems?.items, month],
  );

  const origins = useMemo(() => {
    const map = new Map<string, { key: string; label: string }>();
    for (const item of monthItems) {
      if (!item.origem) continue;
      const key = `${item.origem.kind}:${item.origem.last4}`;
      map.set(key, {
        key,
        label: `${item.origem.nickname} •${item.origem.last4}`,
      });
    }
    return Array.from(map.values());
  }, [monthItems]);

  const categories = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of monthItems) {
      if (!item.tipoDespesa) continue;
      map.set(item.tipoDespesa, tipoLabel(item.tipoDespesa));
    }
    return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
  }, [monthItems]);

  const filtered = monthItems.filter((item) => {
    const isNeutral = isConsumptionNeutralExpenseType(item.tipoDespesa);
    if (!showNeutral && isNeutral) return false;
    if (originFilter !== 'all') {
      const key = item.origem ? `${item.origem.kind}:${item.origem.last4}` : 'none';
      if (key !== originFilter) return false;
    }
    if (categoryFilter !== 'all' && item.tipoDespesa !== categoryFilter) return false;
    return true;
  });

  const spentItems = monthItems.filter((item) => !isConsumptionNeutralExpenseType(item.tipoDespesa));
  const neutralItems = monthItems.filter((item) => isConsumptionNeutralExpenseType(item.tipoDespesa));
  const cardSpent = spentItems.filter((item) => item.origem?.kind === 'card');
  // Usar spentItems (não monthItems) para não somar neutros (fatura/aporte) no "saiu da conta".
  const accountOut = spentItems.filter((item) => item.origem?.kind === 'conta');

  return (
    <section className="space-y-3 lg:hidden">
      <header className="flex items-center justify-between rounded-2xl border border-lifeone-hairline bg-white px-3 py-2 shadow-lifeone-card">
        <div className="flex items-center gap-2">
          <Link
            href={`/projects/${projectId}/monthly`}
            aria-label="Voltar para hoje"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-lg font-bold text-lifeone-ink">Despesas</h1>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-lifeone-hairline bg-lifeone-surface p-1">
          <button type="button" aria-label="Mês anterior" onClick={() => setMonth((current) => addMonthKey(current, -1))} className="h-8 w-8 rounded-lg text-lifeone-ink-2">
            <ChevronLeft className="mx-auto h-4 w-4" />
          </button>
          <span className="min-w-[64px] text-center text-xs font-semibold uppercase text-lifeone-ink-2">{monthLabelShort(month)} {month.slice(2, 4)}</span>
          <button type="button" aria-label="Próximo mês" onClick={() => setMonth((current) => addMonthKey(current, 1))} className="h-8 w-8 rounded-lg text-lifeone-ink-2">
            <ChevronRight className="mx-auto h-4 w-4" />
          </button>
        </div>
      </header>

      <section className="rounded-3xl border border-lifeone-hairline bg-white p-4 shadow-lifeone-card">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-lifeone-ink-3">Gastei de verdade · {monthLabelShort(month)}</p>
        <p className="pt-1 text-3xl font-bold tracking-tight text-lifeone-ink">{moneyDetail(total(spentItems))}</p>
        <div className="mt-3 divide-y divide-lifeone-hairline text-sm">
          <div className="flex items-center justify-between py-2"><span className="text-lifeone-ink-2">No cartão</span><strong className="text-amber-700">{moneyDetail(total(cardSpent))}</strong></div>
          <div className="flex items-center justify-between py-2"><span className="text-lifeone-ink-2">Saiu da conta</span><strong className="text-emerald-700">{moneyDetail(total(accountOut))}</strong></div>
          <div className="flex items-center justify-between py-2"><span className="text-lifeone-ink-2">Neutros (não somam)</span><strong className="text-lifeone-ink-3">{moneyDetail(total(neutralItems))}</strong></div>
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <button type="button" onClick={() => setOriginFilter('all')} className={`min-h-[44px] rounded-full border px-4 text-xs font-semibold ${originFilter === 'all' ? 'border-darc-velvet bg-darc-velvet text-white' : 'border-lifeone-hairline bg-white text-lifeone-ink-2'}`}>Todos</button>
        {origins.map((origin) => (
          <button key={origin.key} type="button" onClick={() => setOriginFilter(origin.key)} className={`min-h-[44px] whitespace-nowrap rounded-full border px-4 text-xs font-semibold ${originFilter === origin.key ? 'border-darc-velvet bg-darc-velvet text-white' : 'border-lifeone-hairline bg-white text-lifeone-ink-2'}`}>
            {origin.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <button type="button" onClick={() => setCategoryFilter('all')} className={`min-h-[40px] rounded-full border px-4 text-xs font-semibold ${categoryFilter === 'all' ? 'border-darc-velvet bg-darc-velvet text-white' : 'border-lifeone-hairline bg-white text-lifeone-ink-2'}`}>Todas</button>
        {categories.map((category) => (
          <button key={category.key} type="button" onClick={() => setCategoryFilter(category.key)} className={`min-h-[40px] whitespace-nowrap rounded-full border px-4 text-xs font-semibold ${categoryFilter === category.key ? 'border-darc-velvet bg-darc-velvet text-white' : 'border-lifeone-hairline bg-white text-lifeone-ink-2'}`}>
            {category.label}
          </button>
        ))}
      </div>

      <label className="flex items-center justify-between rounded-2xl border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-xs text-lifeone-ink-2">
        <span>
          <strong className="text-sm text-lifeone-ink">Mostrar neutros</strong>
          <span className="block text-[11px] text-lifeone-ink-3">pagamento de fatura, movimentação e aporte</span>
        </span>
        <input type="checkbox" checked={showNeutral} onChange={(event) => setShowNeutral(event.target.checked)} className="h-4 w-4" />
      </label>

      <section className="space-y-3 pb-24">
        {groupByDay(filtered).map(([day, entries]) => (
          <article key={day}>
            <header className="mb-2 flex items-center justify-between px-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-lifeone-ink-3">dia {day}</p>
              <p className="text-xs font-semibold text-lifeone-ink-2">{moneyDetail(total(entries.filter((item) => !isConsumptionNeutralExpenseType(item.tipoDespesa))))}</p>
            </header>
            <div className="space-y-2">
              {entries.map((entry, index) => {
                const neutral = isConsumptionNeutralExpenseType(entry.tipoDespesa);
                return (
                  <div key={`${entry.data}-${entry.descricao}-${index}`} className={`flex items-center justify-between gap-3 rounded-2xl border px-3 py-3 ${neutral ? 'border-dashed border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-3' : 'border-lifeone-hairline bg-white text-lifeone-ink'}`}>
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold">{entry.descricao}</p>
                      <p className="mt-1 text-[11px] text-lifeone-ink-3">{tipoLabel(entry.tipoDespesa)}{entry.origem ? ` · ${entry.origem.nickname} •${entry.origem.last4}` : ''}</p>
                    </div>
                    <strong className={`shrink-0 text-[15px] ${entry.valor < 0 ? 'text-emerald-700' : ''}`}>{moneyDetail(entry.valor)}</strong>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
        {filtered.length === 0 && (
          <div className="rounded-2xl border border-lifeone-hairline bg-white p-6 text-center text-sm text-lifeone-ink-3">
            Nenhuma despesa para os filtros selecionados.
          </div>
        )}
      </section>

      {(accountView?.cartoes?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-lifeone-ink-3">Carteira</p>
          <div className="flex gap-2 overflow-x-auto pb-2">
            {accountView!.cartoes.map((card) => {
              const cardMeta = creditCards?.find((c) => c.last4 === card.last4);
              const status = deriveCardWalletStatus(card, cardMeta);
              return (
                <article key={card.last4} className="min-w-[248px] rounded-2xl bg-darc-velvet p-4 text-white shadow-darc-hero">
                  <div className="flex items-center justify-between text-xs">
                    <span>{card.nickname} •{card.last4}</span>
                    <span className={`rounded-md px-2 py-1 text-[11px] font-bold uppercase ${status === 'paga' ? 'bg-emerald-500 text-white' : status === 'aberta' ? 'bg-amber-400 text-darc-velvet' : 'bg-red-500 text-white'}`}>
                      {status}
                    </span>
                  </div>
                  <p className="mt-4 text-lg font-bold">{status === 'configurar' ? '—' : moneyDetail(card.faturaAtual)}</p>
                  <p className="text-xs text-white/70">
                    {status === 'configurar'
                      ? 'sem dia de fechamento cadastrado'
                      : `fatura de ${monthLabelLong(card.dueMonth)} · vence ${card.vencimento.slice(8, 10)}`}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
