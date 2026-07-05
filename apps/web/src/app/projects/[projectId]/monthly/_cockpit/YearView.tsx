'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { ArrowUpCircle, ArrowDownCircle, Scale, Receipt } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import { KpiCard, Card } from './ui';
import { fmtMoney } from './format';
import { deriveYear, colorForCategoria, categoriasDoAno, ticketMedioGeral, type CategoriaBarra } from './derive';
import DestaquesAno from './DestaquesAno';
import CategoriasBarras from './CategoriasBarras';
import ArvoreGastos from './ArvoreGastos';
import type { Eixo } from './EixoToggle';

const FluxoCaixaAnualChart = dynamic(() => import('./FluxoCaixaAnualChart'), {
  ssr: false,
  loading: () => <div className="h-[300px] rounded-xl bg-[var(--ck-surface-2)] animate-pulse" />,
});
const EvolucaoPatrimonioChart = dynamic(() => import('./EvolucaoPatrimonioChart'), {
  ssr: false,
  loading: () => <div className="h-[280px] rounded-xl bg-[var(--ck-surface-2)] animate-pulse" />,
});

export default function YearView({
  data,
  year,
  entries,
  projectId,
  eixo,
}: {
  data: MonthlyOverviewResponse;
  year: number;
  entries?: MonthlyEntry[];
  projectId?: string;
  eixo?: Eixo;
}) {
  const y = useMemo(() => deriveYear(data, year), [data, year]);

  const yearEntries = useMemo(
    () => (entries ?? data.entries ?? []).filter((e) => (e.data ?? '').slice(0, 4) === String(year)),
    [entries, data.entries, year],
  );

  const categoriasAno = useMemo<CategoriaBarra[]>(() => {
    const full = categoriasDoAno(yearEntries, year);
    // Mostra as principais e agrega a cauda em "Outras categorias" — assim nada
    // some (o backend truncava o top-6 POR MÊS, escondendo tipos no ano).
    const TOP = 8;
    const head = full.slice(0, TOP);
    const tail = full.slice(TOP);
    const rows = [...head];
    if (tail.length > 0) {
      rows.push({
        categoria: `Outras categorias (${tail.length})`,
        valor: tail.reduce((s, c) => s + c.valor, 0),
        media: tail.reduce((s, c) => s + c.media, 0),
      });
    }
    const max = rows.reduce((mx, c) => Math.max(mx, c.valor), 0);
    return rows.map((c, i) => ({
      categoria: c.categoria,
      valor: c.valor,
      cor: colorForCategoria(c.categoria, i),
      pct: max > 0 ? c.valor / max : 0,
      media: c.media,
    }));
  }, [yearEntries, year]);

  const ticket = useMemo(() => ticketMedioGeral(yearEntries, year), [yearEntries, year]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={`Receita ${year}`}
          value={fmtMoney(y.receitaAno)}
          tone="pos"
          icon={<ArrowUpCircle className="w-4 h-4" />}
          info={`Tudo que entra no ano de ${year} — inclui projeção (recebimentos previstos + realizados), consistente com o gráfico anual.`}
        />
        <KpiCard
          label={`Despesa ${year}`}
          value={fmtMoney(y.despesaAno)}
          tone="neg"
          icon={<ArrowDownCircle className="w-4 h-4" />}
          info={`Tudo que sai no ano de ${year} — inclui projeção (despesas previstas + realizadas). Consolidado, sem pagamento de fatura / movimentação interna (não é consumo) nem espelhos cross-project (não duplica).`}
        />
        <KpiCard
          label="Resultado do ano"
          value={fmtMoney(y.resultadoAno)}
          tone={y.resultadoAno >= 0 ? 'pos' : 'neg'}
          icon={<Scale className="w-4 h-4" />}
          info={`Receita − despesa do ano (inclui projeção). Positivo = você guardou; negativo = gastou mais do que recebeu. Sem neutros nem espelhos.`}
        />
        <KpiCard
          label="Ticket médio geral"
          value={fmtMoney(ticket.valor)}
          tone="neutral"
          icon={<Receipt className="w-4 h-4" />}
          info={`Valor médio por lançamento de despesa realizada no ano: total gasto ÷ nº de lançamentos. Consolidado (sem pagamento de fatura, movimentação interna nem espelhos cross-project, para não duplicar). Cada parcela conta como um lançamento.`}
          context={`${ticket.count} ${ticket.count === 1 ? 'lançamento' : 'lançamentos'}`}
        />
      </div>

      <Card title="Fluxo de caixa mensal" hint="meses claros = projeção">
        <FluxoCaixaAnualChart meses={y.meses} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Evolução do patrimônio" hint={`base: ${fmtMoney(y.patrimonioInicioAno)}`}>
          <EvolucaoPatrimonioChart meses={y.meses} />
        </Card>
        <CategoriasBarras categorias={categoriasAno} title="Categorias do ano" hint={`${year} · ~média mensal (pagas)`} />
      </div>

      {projectId && (
        <ArvoreGastos
          projectId={projectId}
          entries={yearEntries}
          eixo={eixo ?? 'competencia'}
          title="Árvore de gastos do ano"
          hint={`${year} · por origem e tipo`}
        />
      )}

      <DestaquesAno y={y} />
    </div>
  );
}
