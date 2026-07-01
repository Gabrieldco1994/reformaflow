'use client';

import { Card, Progress } from './ui';
import { fmtMoney } from './format';
import type { MonthDerived } from './derive';

export default function SaudeFinanceira({ m }: { m: MonthDerived }) {
  const atingiu = m.reservaMeses >= m.reservaMeta;
  const faltam = Math.max(0, m.reservaMeta - m.reservaMeses);
  const progresso = m.reservaMeta > 0 ? m.reservaMeses / m.reservaMeta : 0;

  return (
    <Card title="Saúde financeira">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] text-[var(--ck-muted)]">Reserva de emergência</p>
        <p className={`text-sm font-geist tabular-nums ${atingiu ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-alert)]'}`}>
          {m.reservaMeses.toFixed(1).replace('.', ',')} / {m.reservaMeta} meses
        </p>
      </div>
      <div className="mt-2">
        <Progress value={progresso} tone={atingiu ? 'pos' : 'alert'} />
      </div>
      <p className="text-[11px] text-[var(--ck-muted)] mt-2">
        {atingiu ? (
          <span className="text-[var(--ck-pos)]">Meta de {m.reservaMeta} meses atingida.</span>
        ) : (
          <>Faltam <strong className="text-[var(--ck-text)]">{faltam.toFixed(1).replace('.', ',')}</strong> meses para a meta.</>
        )}
        {m.despesaMensalMedia > 0 && (
          <> Despesa média mensal: <span className="font-geist tabular-nums">{fmtMoney(m.despesaMensalMedia)}</span>.</>
        )}
      </p>
    </Card>
  );
}
