'use client';

import { useMemo } from 'react';
import { ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import { KpiCard } from './ui';
import { fmtMoney } from './format';
import { deriveMonth } from './derive';

/**
 * Detalhamento do "Resultado do mês": Entrou + Gastei. Extraído do MonthView
 * para poder ficar acima do widget "Quanto gastei" no cockpit.
 */
export default function MonthKpis({
  data,
  monthKey,
  entries,
}: {
  data: MonthlyOverviewResponse;
  monthKey?: string;
  entries?: MonthlyEntry[];
}) {
  const m = useMemo(() => deriveMonth(data, monthKey ?? data.mesAtual, entries), [data, monthKey, entries]);
  return (
    <div className="mb-5 grid grid-cols-2 gap-3">
      <KpiCard
        label="Entrou no mês"
        value={fmtMoney(m.entrouRealizado)}
        tone="pos"
        icon={<ArrowUpCircle className="w-4 h-4" />}
        info={`Recebimentos já efetivados neste mês (${fmtMoney(m.entrouRealizado)})${m.entrouPrevisto > 0 ? `. Ainda há ${fmtMoney(m.entrouPrevisto)} previsto a receber.` : '.'} Faz parte do "Resultado do mês" lá em cima.`}
        context={m.entrouPrevisto > 0 ? `+ ${fmtMoney(m.entrouPrevisto)} previsto` : 'recebimentos efetivados'}
      />
      <KpiCard
        label="Gastei no mês"
        value={fmtMoney(m.gasteiRealizado)}
        tone="neutral"
        icon={<ArrowDownCircle className="w-4 h-4" />}
        info={`Despesas já pagas neste mês (${fmtMoney(m.gasteiRealizado)})${m.gasteiPlanejado > 0 ? `. Ainda há ${fmtMoney(m.gasteiPlanejado)} planejado a pagar.` : '.'} Faz parte do "Resultado do mês" lá em cima.`}
        context={m.gasteiPlanejado > 0 ? `+ ${fmtMoney(m.gasteiPlanejado)} planejado` : 'só pagamentos efetivados'}
      />
    </div>
  );
}
