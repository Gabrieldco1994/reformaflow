'use client';

import { formatCurrency } from '@/lib/utils';
import { averageReading, formatDeltaPct, monthLabelShort } from '../_lib';
import type { AccountViewTicketMedio } from '../_types';

function deltaTone(value: number | null) {
  if (value == null) return 'bg-lifeone-surface text-lifeone-ink-2';
  return value > 0 ? 'bg-[#FBEBDC] text-[#B5803A]' : 'bg-[#E3F6EA] text-[#1E924A]';
}

export function TicketMedioSection({
  ticket,
  currentMonth,
}: {
  ticket: AccountViewTicketMedio;
  currentMonth: string;
}) {
  const maxValue = Math.max(...ticket.serie6m.map((item) => item.valor), 1);
  const currentPoint =
    ticket.serie6m.find((item) => item.mes === currentMonth) ??
    ticket.serie6m[ticket.serie6m.length - 1];
  const currentDelta = currentPoint?.deltaPct ?? null;

  return (
    <section className="rounded-3xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card xl:p-6">
      <div className="xl:grid xl:grid-cols-[18rem_minmax(0,1fr)] xl:gap-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
            Ticket médio
          </p>
          <h2
            className="mt-1 text-lg font-bold text-lifeone-ink font-geist not-italic"
            style={{ fontFamily: "'Geist', var(--font-sans), system-ui, sans-serif", fontStyle: 'normal' }}
          >
            Ticket médio do mês
          </h2>
          <p className="mt-2 text-2xl font-bold tracking-tight text-lifeone-ink xl:text-[34px] font-geist tabular-nums">
            {formatCurrency(ticket.valor / 100)}
          </p>
          <p className="mt-1 text-[11px] text-lifeone-ink-3">
            {ticket.nCompras} compras · {formatCurrency(ticket.totalCompras / 100)} total no mês
          </p>
          <span className={`mt-3 inline-flex w-fit rounded-full px-3 py-1 text-sm font-semibold ${deltaTone(currentDelta)}`}>
            {formatDeltaPct(currentDelta)}
          </span>
          <p className="mt-4 text-sm text-lifeone-ink-2">
            Média dos últimos 6 meses: {formatCurrency(ticket.media6m / 100)} — {monthLabelShort(currentMonth)} está{' '}
            {formatDeltaPct(ticket.deltaVsMediaPct)}. {averageReading(ticket.deltaVsMediaPct)}.
          </p>
        </div>

        <div className="mt-5 xl:mt-0">
          <div className="flex items-end gap-2 xl:gap-3">
            {ticket.serie6m.map((item) => {
              const height = Math.max(18, Math.round((item.valor / maxValue) * 128));
              const active = item.mes === currentMonth;
              return (
                <div key={item.mes} className="flex flex-1 flex-col items-center gap-2">
                  <span className="hidden text-[10px] text-lifeone-ink-3 md:block">
                    {formatDeltaPct(item.deltaPct)}
                  </span>
                  <div className="flex h-36 w-full items-end xl:h-44">
                    <div
                      className={`w-full rounded-t-2xl transition-all ${
                        active ? 'bg-lifeone-blue' : 'bg-lifeone-hairline-3'
                      }`}
                      style={{ height }}
                      aria-hidden="true"
                    />
                  </div>
                  <span className={`text-[11px] font-semibold ${active ? 'text-lifeone-ink' : 'text-lifeone-ink-3'}`}>
                    {monthLabelShort(item.mes)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
