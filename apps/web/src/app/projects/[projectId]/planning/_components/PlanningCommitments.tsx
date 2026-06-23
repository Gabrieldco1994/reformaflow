'use client';

import { fmtMoneyExact } from '../../monthly/_cockpit/format';
import type { PlanningCommitmentRow } from '../_types';

interface PlanningCommitmentsProps {
  commitments: PlanningCommitmentRow[];
}

export default function PlanningCommitments({ commitments }: PlanningCommitmentsProps) {
  return (
    <section className="rounded-2xl border border-darc-linen bg-white p-4 md:p-5">
      <h2 className="text-base font-semibold text-darc-velvet">Comprometimentos futuros de cartão</h2>
      <p className="text-xs text-darc-velvet/60 mb-3">
        Valores já lançados e ainda não realizados no eixo de saída (vencimento).
      </p>

      {commitments.length === 0 ? (
        <p className="text-sm text-darc-velvet/60">Sem compromissos futuros cadastrados.</p>
      ) : (
        <div className="space-y-2">
          {commitments.slice(0, 10).map((row) => (
            <div
              key={row.monthKey}
              className="flex items-center justify-between gap-2 rounded-xl border border-darc-linen px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium text-darc-velvet">{row.monthLabel}</p>
                <p className="text-xs text-darc-velvet/60">{row.itemCount} itens planejados</p>
              </div>
              <p className="text-sm font-semibold text-amber-700">{fmtMoneyExact(row.totalCents)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
