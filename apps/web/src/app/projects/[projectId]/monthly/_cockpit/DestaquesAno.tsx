'use client';

import { Trophy, AlertTriangle, BarChart3, TrendingUp } from 'lucide-react';
import { Card } from './ui';
import { fmtMoney, fmtPct, mesLongo } from './format';
import type { YearDerived } from './derive';

export default function DestaquesAno({ y }: { y: YearDerived }) {
  const items = [
    {
      icon: <Trophy className="w-4 h-4 text-[var(--ck-pos)]" />,
      label: 'Melhor mês',
      value: y.melhorMes ? mesLongo(y.melhorMes.mesIndex0) : '—',
      sub: y.melhorMes ? `sobra de ${fmtMoney(y.melhorMes.sobra)}` : '',
      tone: 'text-[var(--ck-pos)]',
    },
    {
      icon: <AlertTriangle className="w-4 h-4 text-[var(--ck-neg)]" />,
      label: 'Mês mais apertado',
      value: y.piorMes ? mesLongo(y.piorMes.mesIndex0) : '—',
      sub: y.piorMes ? `sobra de ${fmtMoney(y.piorMes.sobra)}` : '',
      tone: 'text-[var(--ck-neg)]',
    },
    {
      icon: <BarChart3 className="w-4 h-4 text-[var(--ck-accent)]" />,
      label: 'Sobra média mensal',
      value: fmtMoney(y.sobraMedia),
      sub: 'média dos meses com movimento',
      tone: y.sobraMedia >= 0 ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-neg)]',
    },
    {
      icon: <TrendingUp className="w-4 h-4 text-[var(--ck-accent)]" />,
      label: 'Crescimento do patrimônio',
      value: y.crescimentoPatrimonioPct === null ? '—' : fmtPct(y.crescimentoPatrimonioPct, 1),
      sub: `${fmtMoney(y.patrimonioInicioAno)} → ${fmtMoney(y.patrimonioFimAno)}`,
      tone: (y.crescimentoPatrimonioPct ?? 0) >= 0 ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-neg)]',
    },
  ];

  return (
    <Card title="Destaques do ano">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {items.map((it) => (
          <div key={it.label} className="rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3">
            <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)] flex items-center gap-1.5">
              {it.icon}
              {it.label}
            </p>
            <p className={`font-geist tabular-nums font-bold text-lg mt-1 ${it.tone}`}>{it.value}</p>
            {it.sub && <p className="text-[11px] text-[var(--ck-muted)] mt-0.5">{it.sub}</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}
