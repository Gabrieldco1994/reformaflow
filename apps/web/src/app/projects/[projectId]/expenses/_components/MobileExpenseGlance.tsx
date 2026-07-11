import { useState } from 'react';
import { KpiTile } from '@/components/KpiTile';
import { moneyDetail, moneyGlance } from '@/lib/money';

type GlanceStatus = 'loading' | 'error' | 'ready';
function GlanceTile({ label, accessibleLabel, cents }: { label: string; accessibleLabel: string; cents: number | null }) {
  const [exact, setExact] = useState(false);
  return (
    <div role="article" aria-label={accessibleLabel} className="min-w-0">
      <KpiTile variant="support" layer="glance" label={label}
        value={cents == null ? '—' : exact ? moneyDetail(cents) : moneyGlance(cents)}
        extra={cents == null ? undefined : (
          <button type="button" aria-label={exact ? 'Ocultar valor exato' : 'Mostrar valor exato'} onClick={() => setExact((value) => !value)}
            className="mt-2 min-h-[44px] text-[11px] font-semibold text-lifeone-blue">
            {exact ? 'Ver resumo' : 'Ver valor exato'}
          </button>
        )} />
    </div>
  );
}
export function MobileExpenseGlance({ status, noCartao, naConta }: { status: GlanceStatus; noCartao: number | null; naConta: number | null }) {
  const ready = status === 'ready';
  return (
    <div className="grid grid-cols-2 gap-2 md:hidden" aria-busy={status === 'loading'}>
      <GlanceTile label="No cartão" accessibleLabel="No cartão" cents={ready ? noCartao : null} />
      <GlanceTile label="À vista" accessibleLabel="Na conta" cents={ready ? naConta : null} />
    </div>
  );
}
