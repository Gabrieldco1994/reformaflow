'use client';

import { useMemo } from 'react';
import { ArrowUpCircle, ArrowDownCircle, Receipt } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import { KpiCard } from './ui';
import { fmtMoney } from './format';
import { deriveMonth } from './derive';

/**
 * Faixa unificada "Movimento do mês": consolida o que antes se repetia entre o
 * antigo MonthKpis (Entrou/Gastei) e os 4 KPIs do Extrato (Já saiu / Ainda vai
 * sair / Total de saídas / Ticket médio). Uma única fonte (deriveMonth), sem
 * duplicar o que o CockpitTop (Resultado/Projeção) já mostra.
 */
export default function MovimentoMes({
  data,
  monthKey,
  entries,
}: {
  data: MonthlyOverviewResponse;
  monthKey?: string;
  entries?: MonthlyEntry[];
}) {
  const m = useMemo(() => deriveMonth(data, monthKey ?? data.mesAtual, entries), [data, monthKey, entries]);

  const totalSaidas = m.gasteiRealizado + m.gasteiPlanejado;
  const ticket = m.qtdSaidas > 0 ? Math.round(totalSaidas / m.qtdSaidas) : 0;

  return (
    <div className="mb-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
      <KpiCard
        label="Entrou no mês"
        value={fmtMoney(m.entrouRealizado)}
        tone="pos"
        icon={<ArrowUpCircle className="w-4 h-4" />}
        info={`Recebimentos já efetivados neste mês (${fmtMoney(m.entrouRealizado)})${m.entrouPrevisto > 0 ? `. Ainda há ${fmtMoney(m.entrouPrevisto)} previsto a receber.` : '.'}`}
        context={m.entrouPrevisto > 0 ? `+ ${fmtMoney(m.entrouPrevisto)} previsto a receber` : 'recebimentos efetivados'}
      />
      <KpiCard
        label="Saiu no mês"
        value={fmtMoney(m.gasteiRealizado)}
        tone="neg"
        icon={<ArrowDownCircle className="w-4 h-4" />}
        info={`Despesas já pagas neste mês (${fmtMoney(m.gasteiRealizado)})${m.gasteiPlanejado > 0 ? `. Ainda falta pagar ${fmtMoney(m.gasteiPlanejado)} (parcelas/contas previstas).` : '.'} Sem pagamento de fatura / movimentação interna / aporte (não é consumo).`}
        context={m.gasteiPlanejado > 0 ? `+ ${fmtMoney(m.gasteiPlanejado)} ainda vai sair` : 'só pagamentos efetivados'}
      />
      <KpiCard
        label="Total de saídas"
        value={fmtMoney(totalSaidas)}
        tone="neutral"
        icon={<Receipt className="w-4 h-4" />}
        info={`Tudo que sai neste mês: já pago (${fmtMoney(m.gasteiRealizado)}) + ainda vai sair (${fmtMoney(m.gasteiPlanejado)}). Ticket médio = total ÷ nº de lançamentos.`}
        context={`${m.qtdSaidas} lançamento${m.qtdSaidas === 1 ? '' : 's'} · ticket ${fmtMoney(ticket)}`}
      />
    </div>
  );
}
