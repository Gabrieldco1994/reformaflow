'use client';

import { useMemo } from 'react';
import { ArrowDownCircle, CreditCard, Landmark, CalendarClock } from 'lucide-react';
import type { MonthlyEntry } from '../_types';
import { Card, KpiCard } from './ui';
import { fmtMoney, fmtMoneyExact, mesCurto } from './format';
import { buildExtratoDespesas, colorForCategoria, type ExtratoItem } from './derive';

const TYPE_BADGE: Record<string, string> = {
  REFORMA: 'bg-orange-500/15 text-orange-300',
  COMPRA: 'bg-purple-500/15 text-purple-300',
  CASA: 'bg-emerald-500/15 text-emerald-300',
  CARRO: 'bg-sky-500/15 text-sky-300',
  PESSOAL: 'bg-white/10 text-[var(--ck-muted)]',
};

function diaSemana(iso: string): string {
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const d = new Date(iso);
  return dias[d.getUTCDay()] ?? '';
}

/**
 * Visão "Geral": extrato cronológico das saídas do mês — o que saiu, quando e
 * quanto. Mostra realizado vs planejado, origem (cartão/conta/projeto) e o
 * acumulado de saídas ao longo do mês.
 */
export default function ExtratoGeral({
  entries,
  mesIndex0,
}: {
  entries: MonthlyEntry[];
  mesIndex0: number;
}) {
  const { itens, resumo } = useMemo(() => buildExtratoDespesas(entries), [entries]);

  const grupos = useMemo(() => {
    const byDay = new Map<number, ExtratoItem[]>();
    for (const it of itens) {
      const arr = byDay.get(it.dia) ?? [];
      arr.push(it);
      byDay.set(it.dia, arr);
    }
    return Array.from(byDay.entries()).sort(([a], [b]) => a - b);
  }, [itens]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Total de saídas no mês"
          value={fmtMoney(resumo.totalSaidas)}
          tone="neg"
          icon={<ArrowDownCircle className="w-4 h-4" />}
          context={`${resumo.qtd} lançamento${resumo.qtd === 1 ? '' : 's'}`}
        />
        <KpiCard
          label="Já saiu (realizado)"
          value={fmtMoney(resumo.totalRealizado)}
          tone="alert"
          icon={<Landmark className="w-4 h-4" />}
          context="pagamentos efetivados"
        />
        <KpiCard
          label="Ainda vai sair (planejado)"
          value={fmtMoney(resumo.totalPlanejado)}
          tone="neutral"
          icon={<CalendarClock className="w-4 h-4" />}
          context="parcelas/contas previstas"
        />
        <KpiCard
          label="Ticket médio"
          value={fmtMoney(resumo.qtd > 0 ? Math.round(resumo.totalSaidas / resumo.qtd) : 0)}
          tone="accent"
          icon={<CreditCard className="w-4 h-4" />}
          context="por lançamento"
        />
      </div>

      <Card
        title="Extrato de saídas"
        hint={`${mesCurto(mesIndex0)} · ordenado por data`}
      >
        {itens.length === 0 ? (
          <p className="text-sm text-[var(--ck-muted)] py-8 text-center">
            Nenhuma saída registrada neste mês.
          </p>
        ) : (
          <div className="space-y-4">
            {grupos.map(([dia, lst]) => {
              const totalDia = lst.reduce((s, i) => s + i.valor, 0);
              return (
                <div key={dia}>
                  <div className="flex items-baseline justify-between gap-2 mb-1.5 px-1">
                    <span className="text-[11px] uppercase tracking-wider text-[var(--ck-muted)]">
                      Dia {String(dia).padStart(2, '0')} · {diaSemana(lst[0]!.data)}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-[var(--ck-muted)]">
                      {fmtMoneyExact(totalDia)}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    {lst.map((it, idx) => (
                      <li
                        key={it.id}
                        className="flex items-center gap-3 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-3 py-2"
                      >
                        <span
                          className="w-1.5 h-8 rounded-full shrink-0"
                          style={{ background: colorForCategoria(it.categoria, idx) }}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm text-[var(--ck-text)] truncate">{it.descricao}</span>
                            {it.parcela && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-[var(--ck-muted)] font-mono">
                                {it.parcela}
                              </span>
                            )}
                            {it.projectType && it.projectType !== 'PESSOAL' && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${TYPE_BADGE[it.projectType] ?? TYPE_BADGE.PESSOAL}`}>
                                {it.projectName || it.projectType}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[11px] text-[var(--ck-muted)] mt-0.5">
                            <span>{it.categoria}</span>
                            <span aria-hidden>·</span>
                            <span className="inline-flex items-center gap-1">
                              {it.cardLast4 ? (
                                <><CreditCard className="w-3 h-3" /> cartão ••{it.cardLast4}</>
                              ) : (
                                <><Landmark className="w-3 h-3" /> conta/débito</>
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-sm font-mono tabular-nums font-semibold ${it.realizado ? 'text-[var(--ck-neg)]' : 'text-[var(--ck-muted)]'}`}>
                            − {fmtMoneyExact(it.valor)}
                          </p>
                          <p className="text-[10px] text-[var(--ck-muted)] mt-0.5">
                            {it.realizado ? 'pago' : 'previsto'} · acum {fmtMoney(it.acumulado)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
