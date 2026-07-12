'use client';

import { InfoHint } from '@/components/InfoHint';
import { formatCurrency } from '@/lib/utils';
import type { TenantFinancialOverview } from '../_types';

type Props = { data: TenantFinancialOverview };

export function KpiCards({ data }: Props) {
  const glossary = [
    { term: 'Caixa', definition: 'dinheiro disponível hoje nas contas, considerando saldo inicial e movimentações realizadas.' },
    { term: 'Resultado', definition: 'diferença entre o que entrou e o que saiu no período; não representa sozinho o saldo bancário.' },
    { term: 'Projeção', definition: 'estimativa de fechamento: caixa atual + valores a receber − valores ainda a pagar.' },
  ];
  const kpis: { label: string; value: number; accent: string; hint?: string }[] = [
    { label: 'Caixa', value: data.caixaTotal, accent: 'bg-emerald-500', hint: 'Em conta hoje' },
    { label: 'Pago no Mês', value: data.pagoMesAtual, accent: 'bg-darc-raspberry', hint: 'Mês corrente' },
    { label: 'Previsto (30 dias)', value: data.previsao30d, accent: 'bg-darc-sunfire', hint: 'Despesas planejadas' },
    { label: 'Projeção (30d)', value: data.saldoProjetado30d, accent: 'bg-darc-velvet', hint: 'Caixa + receb. - desp.' },
    { label: 'Pago no Ano', value: data.pagoYTD, accent: 'bg-darc-pink-logo', hint: 'YTD' },
    { label: 'Projeção (90d)', value: data.saldoProjetado90d, accent: 'bg-darc-red-bright', hint: 'Próximo trimestre' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-darc-velvet/70">
        {glossary.map(({ term, definition }) => (
          <span key={term} className="inline-flex items-center gap-1">
            {term}
            <InfoHint text={definition} ariaLabel={`Saiba mais sobre ${term}`} />
          </span>
        ))}
      </div>
      <div className="md:hidden -mx-4 px-4 overflow-x-auto scrollbar-hide">
        <div className="flex gap-3 snap-x snap-mandatory">
          {kpis.map((kpi) => (
            <KpiCard key={kpi.label} {...kpi} mobile />
          ))}
        </div>
      </div>
      <div className="hidden md:grid grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>
    </div>
  );
}

function KpiCard({
  label, value, accent, hint, mobile = false,
}: { label: string; value: number; accent: string; hint?: string; mobile?: boolean }) {
  const sign = value < 0 ? 'text-darc-red' : 'text-darc-velvet';
  return (
    <div className={`${mobile ? 'snap-start flex-shrink-0 w-[78%]' : ''} rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5 relative overflow-hidden`}>
      <span className={`absolute left-0 top-4 bottom-4 w-1 rounded-r-full ${accent}`} />
      <p className="flex items-center gap-1 text-[11px] tracking-[0.18em] uppercase text-darc-velvet/60 pl-3">
        {label}
      </p>
      <p className={`text-xl md:text-2xl font-bold mt-2 pl-3 ${sign}`}>{formatCurrency(value / 100)}</p>
      {hint && <p className="text-[10px] text-darc-velvet/50 mt-1 pl-3">{hint}</p>}
    </div>
  );
}
