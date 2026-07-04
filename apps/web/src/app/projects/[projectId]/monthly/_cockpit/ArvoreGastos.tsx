'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Landmark, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import type { MonthlyEntry } from '../_types';
import type { Eixo } from './EixoToggle';
import { Card } from './ui';
import { fmtMoney } from './format';
import { colorForCategoria } from './derive';
import { spendTree, type SpendTreeOrigin } from './spend-tree';

interface BankAccountDTO {
  id: string;
  institution: string;
  nickname: string | null;
  last4: string;
}
interface CreditCardDTO {
  id: string;
  institution: string;
  brand: string;
  nickname: string | null;
  last4: string;
}

/** Conector em elbow (spine vertical + stub horizontal) entre nós irmãos.
 *  `overhang` (px) estende o spine para dentro do padding vertical da linha,
 *  para a linha ficar CONTÍNUA entre irmãos (senão quebra no vão do padding). */
function Connector({ pos, overhang }: { pos: 'first' | 'last' | 'middle' | 'single'; overhang: number }) {
  return (
    <div className="relative w-5 shrink-0 self-stretch" aria-hidden>
      {pos !== 'single' && (
        <span
          className="absolute left-0 w-px bg-[var(--ck-border)]"
          style={{
            top: pos === 'first' ? '50%' : `-${overhang}px`,
            bottom: pos === 'last' ? '50%' : `-${overhang}px`,
          }}
        />
      )}
      <span className="absolute left-0 right-0 top-1/2 h-px bg-[var(--ck-border)]" />
    </div>
  );
}

function posOf(index: number, count: number): 'first' | 'last' | 'middle' | 'single' {
  if (count <= 1) return 'single';
  if (index === 0) return 'first';
  if (index === count - 1) return 'last';
  return 'middle';
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export default function ArvoreGastos({
  projectId,
  entries,
  eixo,
  title = 'Árvore de gastos',
  hint,
}: {
  projectId: string;
  entries: MonthlyEntry[];
  eixo: Eixo;
  title?: string;
  hint?: string;
}) {
  const bankAccounts = useQuery<BankAccountDTO[]>({
    queryKey: ['bank-accounts', projectId],
    queryFn: () => api.get(`/projects/${projectId}/bank-accounts`),
    enabled: !!projectId,
  });
  const creditCards = useQuery<CreditCardDTO[]>({
    queryKey: ['credit-cards', projectId],
    queryFn: () => api.get(`/projects/${projectId}/credit-cards`),
    enabled: !!projectId,
  });

  const tree = useMemo(
    () => spendTree(entries, { keepCardSettlement: eixo === 'caixa', pessoalProjectId: projectId }),
    [entries, eixo, projectId],
  );

  const nameOf = useMemo(() => {
    const cardByLast4 = new Map((creditCards.data ?? []).map((c) => [c.last4, c] as const));
    const accByLast4 = new Map((bankAccounts.data ?? []).map((a) => [a.last4, a] as const));
    return (o: SpendTreeOrigin): string => {
      if (o.kind === 'card') {
        const c = cardByLast4.get(o.last4);
        return c?.nickname?.trim() || (c ? `${c.brand} ${c.last4}` : `Cartão ${o.last4}`);
      }
      const a = accByLast4.get(o.last4);
      return a?.nickname?.trim() || a?.institution || `Conta ${o.last4}`;
    };
  }, [creditCards.data, bankAccounts.data]);

  // Origens começam expandidas (como no desenho); podem ser recolhidas.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const loading = bankAccounts.isLoading || creditCards.isLoading;

  return (
    <Card
      title={title}
      hint={hint}
      info="Como o gasto do mês (ou ano) se distribui: Pessoal → cada cartão/conta → tipo de despesa. Respeita o eixo (Gastei = por compra; Vai sair = por vencimento). Pagamento de fatura não conta."
    >
      {loading ? (
        <div className="h-40 rounded-xl bg-[var(--ck-surface-2)] animate-pulse" />
      ) : tree.origins.length === 0 ? (
        <p className="text-xs text-[var(--ck-muted)]">Sem gastos por origem neste período.</p>
      ) : (
        <div className="overflow-x-auto pb-1">
          <div className="flex items-stretch min-w-[560px]">
            {/* Raiz: Pessoal */}
            <div className="flex items-center shrink-0">
              <div className="w-28 rounded-xl bg-[var(--ck-accent)] px-3 py-2.5 text-white shadow-lifeone-card">
                <p className="text-[10px] uppercase tracking-wider text-white/70">Pessoal</p>
                <p className="font-geist tabular-nums text-sm font-bold leading-tight">
                  {fmtMoney(tree.total)}
                </p>
              </div>
              <span className="w-5 h-px bg-[var(--ck-border)]" aria-hidden />
            </div>

            {/* Origens */}
            <div className="flex-1">
              {tree.origins.map((o, oi) => {
                const key = `${o.kind}:${o.last4}`;
                const isCollapsed = collapsed.has(key);
                return (
                  <div key={key} className="flex items-stretch py-1.5">
                    <Connector pos={posOf(oi, tree.origins.length)} overhang={6} />

                    {/* Caixa da origem (clicável) */}
                    <div className="flex items-center shrink-0">
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        className="w-48 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 py-2 text-left shadow-lifeone-card hover:border-[var(--ck-accent)]/50 transition-colors"
                      >
                        <span className="flex items-center gap-1.5">
                          {isCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 text-[var(--ck-muted)] shrink-0" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-[var(--ck-muted)] shrink-0" />
                          )}
                          {o.kind === 'card' ? (
                            <CreditCard className="w-3.5 h-3.5 text-[var(--ck-accent)] shrink-0" />
                          ) : (
                            <Landmark className="w-3.5 h-3.5 text-[var(--ck-accent)] shrink-0" />
                          )}
                          <span className="min-w-0 truncate text-xs font-semibold text-[var(--ck-text)]">
                            {nameOf(o)}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-baseline justify-between gap-2 pl-5">
                          <span className="text-[10px] text-[var(--ck-muted)]">
                            ••{o.last4} · {pct(o.total, tree.total)}%
                          </span>
                          <span className="font-geist tabular-nums text-xs font-bold text-[var(--ck-neg)]">
                            {fmtMoney(o.total)}
                          </span>
                        </span>
                      </button>
                      {!isCollapsed && <span className="w-4 h-px bg-[var(--ck-border)]" aria-hidden />}
                    </div>

                    {/* Tipos de despesa da origem */}
                    {!isCollapsed && (
                      <div className="flex-1 min-w-0 py-0.5">
                        {o.tipos.map((t, ti) => (
                          <div key={t.tipo} className="flex items-stretch py-1">
                            <Connector pos={posOf(ti, o.tipos.length)} overhang={4} />
                            <div className="flex-1 min-w-0 rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-2.5 py-1.5">
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--ck-text)]">
                                  <span
                                    className="inline-block w-2 h-2 rounded-sm shrink-0"
                                    style={{ background: colorForCategoria(t.tipo, ti) }}
                                  />
                                  <span className="truncate">{t.tipo}</span>
                                </span>
                                <span className="shrink-0 font-geist tabular-nums text-xs text-[var(--ck-muted)]">
                                  {fmtMoney(t.valor)}
                                  <span className="ml-1 text-[10px]">({pct(t.valor, o.total)}%)</span>
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
