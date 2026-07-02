'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Landmark } from 'lucide-react';
import { api } from '@/lib/api';
import { pickCardGradient, MiniCardChip } from '@/components/CreditCardVisual';
import { fmtMoneyExact } from './format';
import { Card } from './ui';

interface BankAccountBalance {
  id: string;
  institution: string;
  nickname: string | null;
  last4: string;
  balanceCents?: number;
}

interface CreditCardBalance {
  id: string;
  institution: string;
  brand: string;
  nickname: string | null;
  last4: string;
  limitTotalCents: number | null;
  limitAvailableCents: number | null;
  limitUsedCents?: number;
  limitAvailableComputedCents?: number;
  limitUsagePercent?: number;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function accountName(account: BankAccountBalance): string {
  return account.nickname?.trim() || account.institution;
}

function cardName(card: CreditCardBalance): string {
  return card.nickname?.trim() || `${card.brand} ${card.last4}`;
}

function SectionHeader({ href, icon, title }: { href: string; icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ck-muted)]">
        {icon}
        <span>{title}</span>
      </div>
      <Link href={href} className="text-[11px] font-medium text-[var(--ck-accent)] hover:underline">
        ver
      </Link>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <Card title="Saldos" hint="contas e cartões" className="ck-enter mb-5">
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((group) => (
          <div key={group} className="space-y-2 animate-pulse">
            <div className="h-3 w-24 rounded bg-[var(--ck-surface-2)]" />
            {[0, 1].map((item) => (
              <div key={item} className="h-9 rounded-xl bg-[var(--ck-surface-2)]" />
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function SaldosWidget({ projectId }: { projectId: string }) {
  const bankAccounts = useQuery<BankAccountBalance[]>({
    queryKey: ['bank-accounts', projectId],
    queryFn: () => api.get(`/projects/${projectId}/bank-accounts`),
    enabled: !!projectId,
  });

  const creditCards = useQuery<CreditCardBalance[]>({
    queryKey: ['credit-cards', projectId],
    queryFn: () => api.get(`/projects/${projectId}/credit-cards`),
    enabled: !!projectId,
  });

  const accounts = bankAccounts.data ?? [];
  const cards = creditCards.data ?? [];
  const visibleAccounts = accounts.slice(0, 3);
  const visibleCards = cards.slice(0, 3);
  const showAccounts = visibleAccounts.length > 0;
  const showCards = visibleCards.length > 0;
  const loading = bankAccounts.isLoading || creditCards.isLoading;

  if (loading) return <LoadingSkeleton />;
  if (!showAccounts && !showCards) return null;

  return (
    <Card title="Saldos" hint="contas e cartões" className="ck-enter mb-5">
      <div className="grid gap-4 lg:grid-cols-2">
        {showAccounts && (
          <section className="space-y-2">
            <SectionHeader
              href={`/projects/${projectId}/bank-accounts`}
              icon={<Landmark className="w-3.5 h-3.5" />}
              title="Contas"
            />
            <div className="space-y-1.5">
              {visibleAccounts.map((account) => {
                const balanceCents = account.balanceCents ?? 0;
                const toneClass = balanceCents >= 0 ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-neg)]';

                return (
                  <div
                    key={account.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)]/55 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-xs text-[var(--ck-text)]">
                      {accountName(account)} <span className="text-[var(--ck-muted)]">••{account.last4}</span>
                    </span>
                    <span className={`shrink-0 font-geist tabular-nums text-xs font-bold tabular-nums ${toneClass}`}>
                      {fmtMoneyExact(balanceCents)}
                    </span>
                  </div>
                );
              })}
              {accounts.length > visibleAccounts.length && (
                <p className="text-[11px] text-[var(--ck-muted)]">+{accounts.length - visibleAccounts.length} contas em ver</p>
              )}
            </div>
          </section>
        )}

        {showCards && (
          <section className="space-y-2">
            <SectionHeader
              href={`/projects/${projectId}/credit-cards`}
              icon={<CreditCard className="w-3.5 h-3.5" />}
              title="Cartões"
            />
            <div className="space-y-2">
              {visibleCards.map((card) => {
                const limitTotalCents = card.limitTotalCents;
                const usedCents = card.limitUsedCents;
                const availableCents = card.limitAvailableComputedCents ?? card.limitAvailableCents;
                const usagePercent = card.limitUsagePercent;
                const canShowUsage = limitTotalCents != null && usedCents != null && usagePercent != null;
                const pct = canShowUsage ? clampPercent(usagePercent) : 0;

                return (
                  <div
                    key={card.id}
                    className="relative overflow-hidden rounded-xl px-3 py-2.5 text-white shadow-lifeone-card"
                    style={{ backgroundImage: pickCardGradient(card.last4) }}
                  >
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0"
                      style={{ background: 'radial-gradient(120% 80% at 85% 10%, rgba(255,255,255,.16), transparent 55%)' }}
                    />
                    <div className="relative mb-1.5 flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <MiniCardChip />
                        <span className="min-w-0 truncate text-xs font-medium text-white/90">
                          {cardName(card)} <span className="text-white/55">••{card.last4}</span>
                        </span>
                      </span>
                      {canShowUsage ? (
                        <span className="shrink-0 font-geist tabular-nums text-[11px] font-semibold text-white/80">
                          {fmtMoneyExact(usedCents)} / {fmtMoneyExact(limitTotalCents)}
                        </span>
                      ) : limitTotalCents != null ? (
                        <span className="shrink-0 font-geist tabular-nums text-[11px] font-semibold text-white/80">
                          limite {fmtMoneyExact(limitTotalCents)}
                        </span>
                      ) : null}
                    </div>
                    {canShowUsage ? (
                      <div className="relative">
                        <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
                          <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="mt-1 flex justify-between gap-2 text-[10px] text-white/70">
                          <span>{pct}% usado</span>
                          {availableCents != null && <span>disp. {fmtMoneyExact(availableCents)}</span>}
                        </div>
                      </div>
                    ) : availableCents != null ? (
                      <p className="relative text-[10px] text-white/70">disponível {fmtMoneyExact(availableCents)}</p>
                    ) : null}
                  </div>
                );
              })}
              {cards.length > visibleCards.length && (
                <p className="text-[11px] text-[var(--ck-muted)]">+{cards.length - visibleCards.length} cartões em ver</p>
              )}
            </div>
          </section>
        )}
      </div>
    </Card>
  );
}
