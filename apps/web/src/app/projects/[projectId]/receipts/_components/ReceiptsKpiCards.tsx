'use client';
import React, { useMemo } from 'react';
import { KpiTile } from '@/components/KpiTile';
import { moneyGlance } from '@/lib/money';
import { computeReceiptsKpis } from '../_lib/kpis';
import type { Receipt } from '@/types';

interface Props {
  receipts: Receipt[];
}

/** Topo de 3 KpiTiles de `receipts/` — recebido no mês, previsto, YTD. */
function ReceiptsKpiCardsImpl({ receipts }: Props) {
  const kpis = useMemo(() => computeReceiptsKpis(receipts, new Date()), [receipts]);

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div role="article" aria-label="Recebido no mês" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone="positive"
          label="Recebido no mês"
          value={moneyGlance(kpis.monthReceivedCents)}
          context="em caixa"
        />
      </div>
      <div role="article" aria-label="Previsto" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone="neutral"
          label="Previsto"
          value={moneyGlance(kpis.monthForecastCents)}
          context="a receber no mês"
        />
      </div>
      <div role="article" aria-label="Acumulado no ano" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone="neutral"
          label="Acumulado no ano"
          value={moneyGlance(kpis.ytdCents)}
          context="YTD, em caixa"
        />
      </div>
    </div>
  );
}

export const ReceiptsKpiCards = React.memo(ReceiptsKpiCardsImpl);
