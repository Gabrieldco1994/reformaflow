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

function cardGradient(brand: string | null | undefined): string {
  const b = (brand ?? '').toLowerCase();
  if (b.includes('master')) return 'linear-gradient(135deg,#221F1B 0%,#3A332B 55%,#4E4437 100%)';
  if (b.includes('visa')) return 'linear-gradient(135deg,#101318 0%,#1E2430 60%,#2B3648 100%)';
  return 'linear-gradient(135deg,#1F2937 0%,#111827 60%,#0B1220 100%)';
}

function BrandMark({ brand }: { brand: string | null | undefined }) {
  const b = (brand ?? '').toLowerCase();
  if (b.includes('master')) {
    return (
      <span className="relative inline-block h-6 w-10" aria-hidden>
        <span className="absolute left-0 top-0 h-6 w-6 rounded-full bg-[#EB001B]/90" />
        <span className="absolute right-0 top-0 h-6 w-6 rounded-full bg-[#F79E1B]/90 mix-blend-screen" />
      </span>
    );
  }
  if (b.includes('visa')) {
    return <span className="text-[13px] font-extrabold italic tracking-wide opacity-90">VISA</span>;
  }
  return null;
}

function total(items: Array<{ valor: number }>) {
  return items.reduce((acc, item) => acc + item.valor, 0);
}

const filterChipClass = (active: boolean) =>
  `min-h-[44px] whitespace-nowrap rounded-full border px-4 text-xs font-semibold ${
    active
      ? 'border-darc-velvet bg-darc-velvet text-white'
      : 'border-lifeone-hairline bg-white text-lifeone-ink-2'
  }`;

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
  // buscar o cadastro do cartão (do PROJETO ATUAL) para saber de verdade se falta
  // configurar o fechamento e para o gradiente/bandeira do cartão físico.
  const { data: creditCards } = useQuery<
    Array<{ last4: string; closingDay: number | null; brand: string | null; institution: string | null; nickname: string | null }>
  >({
    queryKey: ['project', projectId, 'credit-cards'],
    queryFn: () => api.get(`/projects/${projectId}/credit-cards`),
    enabled: !!projectId,
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
      <header className="flex min-w-0 items-center justify-between gap-2 rounded-2xl border border-lifeone-hairline bg-white px-3 py-2 shadow-lifeone-card">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/projects/${projectId}/monthly`}
            aria-label="Voltar para hoje"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h1 className="truncate text-lg font-bold text-lifeone-ink">Despesas</h1>
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
          <div className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 text-lifeone-ink-2">No cartão</span><strong className="shrink-0 whitespace-nowrap text-amber-700">{moneyDetail(total(cardSpent))}</strong></div>
          <div className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 text-lifeone-ink-2">Saiu da conta</span><strong className="shrink-0 whitespace-nowrap text-emerald-700">{moneyDetail(total(accountOut))}</strong></div>
          <div className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 text-lifeone-ink-2">Neutros (não somam)</span><strong className="shrink-0 whitespace-nowrap text-lifeone-ink-3">{moneyDetail(total(neutralItems))}</strong></div>
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto pb-1">
        <button type="button" onClick={() => setOriginFilter('all')} className={filterChipClass(originFilter === 'all')}>Todos</button>
        {origins.map((origin) => (
          <button key={origin.key} type="button" onClick={() => setOriginFilter(origin.key)} className={filterChipClass(originFilter === origin.key)}>
            {origin.label}
          </button>
        ))}
      </div>

      {((accountView?.cartoes?.length ?? 0) > 0 || (accountView?.contas?.length ?? 0) > 0) && (
        <section className="space-y-2">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-lifeone-ink-3">Carteira · faturas espelham o banco</p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {(accountView?.cartoes ?? []).map((card) => {
              const cardMeta = creditCards?.find((c) => c.last4 === card.last4);
              const status = deriveCardWalletStatus(card, cardMeta);
              const badge =
                status === 'paga'
                  ? { cls: 'bg-[#2FA97C] text-white', label: 'paga ✓' }
                  : status === 'aberta'
                    ? { cls: 'bg-[#E8B04B] text-[#201D19]', label: 'fatura aberta' }
                    : { cls: 'bg-[#E2574B] text-white', label: 'configurar' };
              return (
                <article
                  key={card.last4}
                  className="relative flex min-h-[172px] min-w-[286px] flex-col overflow-hidden rounded-[20px] p-4 text-white shadow-darc-hero"
                  style={{ background: cardGradient(cardMeta?.brand) }}
                >
                  <div className="flex items-center justify-between">
                    <span className="min-w-0 truncate text-[12.5px] font-bold">{card.nickname}</span>
                    <div className="flex items-center gap-2.5">
                      <span className={`rounded-lg px-2.5 py-1 text-[10.5px] font-extrabold uppercase ${badge.cls}`}>{badge.label}</span>
                      <BrandMark brand={cardMeta?.brand} />
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2.5">
                    <span className="h-[23px] w-8 rounded-[5px] bg-gradient-to-br from-[#E8CC7A] to-[#B98F3E]" aria-hidden />
                    <span className="text-[14.5px] font-semibold tracking-[0.14em] opacity-90">•••• {card.last4}</span>
                  </div>
                  <div className="mt-auto pt-3">
                    <p className="text-[10px] font-extrabold uppercase tracking-wide opacity-60">
                      {status === 'configurar' ? 'fatura' : `fatura de ${monthLabelLong(card.dueMonth)} · vence ${card.vencimento.slice(8, 10)}`}
                    </p>
                    <p className="mt-0.5 text-[22px] font-extrabold tracking-tight">{status === 'configurar' ? '—' : moneyDetail(card.faturaAtual)}</p>
                    <p className="mt-1 text-[11.5px] font-medium opacity-70">
                      {status === 'configurar' ? 'sem dia de fechamento cadastrado' : status === 'paga' ? 'fatura quitada ✓' : 'em aberto'}
                    </p>
                  </div>
                </article>
              );
            })}
            {(accountView?.contas ?? []).map((conta) => (
              <article
                key={`conta-${conta.last4}`}
                className="relative flex min-h-[172px] min-w-[286px] flex-col overflow-hidden rounded-[20px] p-4 text-white shadow-darc-hero"
                style={{ background: 'linear-gradient(135deg,#0B4A36 0%,#0F6B4D 60%,#1B8A66 100%)' }}
              >
                <div className="flex items-center justify-between">
                  <span className="min-w-0 truncate text-[12.5px] font-bold">{conta.nome}</span>
                </div>
                <div className="mt-3 flex items-center gap-2.5">
                  <span className="h-[23px] w-8 rounded-[5px] bg-gradient-to-br from-[#E8CC7A] to-[#B98F3E]" aria-hidden />
                  <span className="text-[14.5px] font-semibold tracking-[0.14em] opacity-90">•••• {conta.last4}</span>
                </div>
                <div className="mt-auto pt-3">
                  <p className="text-[10px] font-extrabold uppercase tracking-wide opacity-60">saiu no mês (caixa)</p>
                  <p className="mt-0.5 text-[22px] font-extrabold tracking-tight">
                    {(accountView?.contas?.length ?? 0) === 1 ? moneyDetail(accountView!.saiuMes) : '—'}
                  </p>
                  <p className="mt-1 text-[11.5px] font-medium opacity-70">inclui neutros — caixa é caixa</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="flex gap-2 overflow-x-auto pb-1">
        <button type="button" onClick={() => setCategoryFilter('all')} className={filterChipClass(categoryFilter === 'all')}>Todas</button>
        {categories.map((category) => (
          <button key={category.key} type="button" onClick={() => setCategoryFilter(category.key)} className={filterChipClass(categoryFilter === category.key)}>
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
                      <p className="mt-1 truncate text-[11px] text-lifeone-ink-3">{tipoLabel(entry.tipoDespesa)}{entry.origem ? ` · ${entry.origem.nickname} •${entry.origem.last4}` : ''}</p>
                    </div>
                    <strong className={`shrink-0 whitespace-nowrap text-[15px] ${entry.valor < 0 ? 'text-emerald-700' : ''}`}>{moneyDetail(entry.valor)}</strong>
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
    </section>
  );
}
