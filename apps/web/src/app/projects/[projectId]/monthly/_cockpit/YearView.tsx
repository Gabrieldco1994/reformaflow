'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { ArrowUpCircle, ArrowDownCircle, Scale, PiggyBank } from 'lucide-react';
import type { MonthlyOverviewResponse } from '../_types';
import { KpiCard, Card } from './ui';
import { fmtMoney, fmtPct } from './format';
import { deriveYear, colorForCategoria, type CategoriaBarra } from './derive';
import DestaquesAno from './DestaquesAno';
import CategoriasBarras from './CategoriasBarras';

const FluxoCaixaAnualChart = dynamic(() => import('./FluxoCaixaAnualChart'), {
  ssr: false,
  loading: () => <div className="h-[300px] rounded-xl bg-[var(--ck-surface-2)] animate-pulse" />,
});
const EvolucaoPatrimonioChart = dynamic(() => import('./EvolucaoPatrimonioChart'), {
  ssr: false,
  loading: () => <div className="h-[280px] rounded-xl bg-[var(--ck-surface-2)] animate-pulse" />,
});

export default function YearView({ data, year }: { data: MonthlyOverviewResponse; year: number }) {
  const y = useMemo(() => deriveYear(data, year), [data, year]);

  const categoriasAno = useMemo<CategoriaBarra[]>(() => {
    const acc = new Map<string, number>();
    for (const r of data.meses) {
      if (!r.mes.startsWith(`${year}-`)) continue;
      for (const c of r.porCategoria) acc.set(c.categoria, (acc.get(c.categoria) ?? 0) + c.valor);
    }
    const sorted = Array.from(acc.entries())
      .map(([categoria, valor]) => ({ categoria, valor }))
      .filter((c) => c.valor > 0)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 6);
    const max = sorted.reduce((mx, c) => Math.max(mx, c.valor), 0);
    return sorted.map((c, i) => ({
      categoria: c.categoria,
      valor: c.valor,
      cor: colorForCategoria(c.categoria, i),
      pct: max > 0 ? c.valor / max : 0,
    }));
  }, [data.meses, year]);

  const poupancaTone = y.taxaPoupanca >= y.metaPoupanca ? 'pos' : y.taxaPoupanca >= 0 ? 'alert' : 'neg';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={`Receita ${year}`}
          value={fmtMoney(y.receitaAno)}
          tone="pos"
          icon={<ArrowUpCircle className="w-4 h-4" />}
        />
        <KpiCard
          label={`Despesa ${year}`}
          value={fmtMoney(y.despesaAno)}
          tone="neg"
          icon={<ArrowDownCircle className="w-4 h-4" />}
        />
        <KpiCard
          label="Resultado do ano"
          value={fmtMoney(y.resultadoAno)}
          tone={y.resultadoAno >= 0 ? 'pos' : 'neg'}
          icon={<Scale className="w-4 h-4" />}
        />
        <KpiCard
          label="Taxa de poupança"
          value={fmtPct(y.taxaPoupanca, 1)}
          tone={poupancaTone}
          icon={<PiggyBank className="w-4 h-4" />}
          context={`meta de referência: ${y.metaPoupanca}%`}
        />
      </div>

      <Card title="Fluxo de caixa mensal" hint="meses claros = projeção">
        <FluxoCaixaAnualChart meses={y.meses} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Evolução do patrimônio" hint={`base: ${fmtMoney(y.patrimonioInicioAno)}`}>
          <EvolucaoPatrimonioChart meses={y.meses} />
        </Card>
        <CategoriasBarras categorias={categoriasAno} title="Categorias do ano" hint={String(year)} />
      </div>

      <DestaquesAno y={y} />
    </div>
  );
}
