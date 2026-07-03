'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Landmark } from 'lucide-react';
import { api } from '@/lib/api';
import { pickCardGradient, MiniCardChip } from '@/components/CreditCardVisual';
import type { MonthlyEntry } from '../_types';
import type { Eixo } from './EixoToggle';
import { fmtMoneyExact } from './format';
import { Card } from './ui';
import { spendByOrigin } from './spend-by-origin';

interface BankAccountBalance {
  id: string;
  institution: string;
  nickname: string | null;
  last4: string;
}

interface CreditCardBalance {
  id: string;
  institution: string;
  brand: string;
  nickname: string | null;
  last4: string;
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
    <Card title="Quanto gastei" hint="por cartão e conta" className="ck-enter mb-5">
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

export default function SaldosWidget({
  projectId,
  entries,
  eixo,
}: {
  projectId: string;
  entries: MonthlyEntry[];
  eixo: Eixo;
}) {
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

  const spend = useMemo(
    () => spendByOrigin(entries, { keepCardSettlement: eixo === 'caixa', pessoalProjectId: projectId }),
    [entries, eixo, projectId],
  );

  const cardRows = useMemo(() => {
    const cards = creditCards.data ?? [];
    return cards
      .map((c) => ({ card: c, gasto: spend.cards.get(c.last4) ?? 0 }))
      .filter((r) => r.gasto > 0)
      .sort((a, b) => b.gasto - a.gasto);
  }, [creditCards.data, spend]);

  const accountRows = useMemo(() => {
    const accounts = bankAccounts.data ?? [];
    return accounts
      .map((a) => ({ account: a, gasto: spend.accounts.get(a.last4) ?? 0 }))
      .filter((r) => r.gasto > 0)
      .sort((a, b) => b.gasto - a.gasto);
  }, [bankAccounts.data, spend]);

  const loading = bankAccounts.isLoading || creditCards.isLoading;
  if (loading) return <LoadingSkeleton />;

  const showAccounts = accountRows.length > 0;
  const showCards = cardRows.length > 0;
  const hint = eixo === 'caixa' ? 'no mês, por vencimento' : 'no mês, por compra';

  if (!showAccounts && !showCards) {
    return (
      <Card title="Quanto gastei" hint={hint} className="ck-enter mb-5">
        <p className="text-[13px] text-[var(--ck-muted)]">Nenhum gasto por cartão ou conta neste mês.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Quanto gastei"
      hint={hint}
      info="Quanto foi gasto neste mês em cada cartão e conta, respeitando o filtro de mês e o eixo selecionado (Gastei = por compra; Vai sair = por vencimento). Pagamento de fatura não conta (não é consumo)."
      className="ck-enter mb-5"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {showCards && (
          <section className="space-y-2">
            <SectionHeader
              href={`/projects/${projectId}/credit-cards`}
              icon={<CreditCard className="w-3.5 h-3.5" />}
              title="Cartões"
            />
            <div className="space-y-2">
              {cardRows.map(({ card, gasto }) => (
                <div
                  key={card.id}
                  className="relative flex items-center justify-between gap-3 overflow-hidden rounded-xl px-3 py-2.5 text-white shadow-lifeone-card"
                  style={{ backgroundImage: pickCardGradient(card.last4) }}
                >
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0"
                    style={{ background: 'radial-gradient(120% 80% at 85% 10%, rgba(255,255,255,.16), transparent 55%)' }}
                  />
                  <span className="relative flex min-w-0 items-center gap-2">
                    <MiniCardChip />
                    <span className="min-w-0 truncate text-xs font-medium text-white/90">
                      {cardName(card)} <span className="text-white/55">••{card.last4}</span>
                    </span>
                  </span>
                  <span className="relative shrink-0 font-geist tabular-nums text-sm font-bold">
                    {fmtMoneyExact(gasto)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {showAccounts && (
          <section className="space-y-2">
            <SectionHeader
              href={`/projects/${projectId}/bank-accounts`}
              icon={<Landmark className="w-3.5 h-3.5" />}
              title="Contas"
            />
            <div className="space-y-2">
              {accountRows.map(({ account, gasto }) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 py-2.5 shadow-lifeone-card"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ck-accent)]/10 text-[var(--ck-accent)]">
                      <Landmark className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 leading-tight">
                      <span className="block truncate text-xs font-semibold text-[var(--ck-text)]">
                        {accountName(account)}
                      </span>
                      <span className="block text-[10px] text-[var(--ck-muted)]">
                        conta corrente ••{account.last4}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 font-geist tabular-nums text-sm font-bold text-[var(--ck-neg)]">
                    {fmtMoneyExact(gasto)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </Card>
  );
}
