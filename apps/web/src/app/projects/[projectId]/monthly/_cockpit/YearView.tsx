'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowUpCircle, ArrowDownCircle, Scale, Receipt } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import { KpiCard, Card } from './ui';
import { fmtMoney } from './format';
import { deriveYear, colorForCategoria, categoriasDoAno, gastoMedioMensal, type CategoriaBarra } from './derive';
import CategoriasBarras from './CategoriasBarras';
import CategoriaDespesasModal from './CategoriaDespesasModal';
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

  const [catStatusMode, setCatStatusMode] = useState<'real' | 'realPlus'>('realPlus');
  const [fluxoMode, setFluxoMode] = useState<'mensal' | 'acumuladaReal' | 'acumuladaRealPlus'>('mensal');
  const [catAberta, setCatAberta] = useState<string | null>(null);

  const yearEntries = useMemo(
    () => (entries ?? data.entries ?? []).filter((e) => (e.data ?? '').slice(0, 4) === String(year)),
    [entries, data.entries, year],
  );

  const categoriasAno = useMemo<CategoriaBarra[]>(() => {
    // TODAS as categorias com valor no ano (o backend truncava top-6/mês; aqui
    // agrega das entries sem truncar). Seção larga com colunas comporta a lista.
    const full = categoriasDoAno(yearEntries, year, catStatusMode);
    const max = full.reduce((mx, c) => Math.max(mx, c.valor), 0);
    return full.map((c, i) => ({
      categoria: c.categoria,
      valor: c.valor,
      cor: colorForCategoria(c.categoria, i),
      pct: max > 0 ? c.valor / max : 0,
      media: c.media,
    }));
  }, [yearEntries, year, catStatusMode]);

  const gastoMensal = useMemo(() => gastoMedioMensal(yearEntries, year), [yearEntries, year]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={`Receita ${year}`}
          value={fmtMoney(y.receitaAno)}
          tone="pos"
          icon={<ArrowUpCircle className="w-4 h-4" />}
          info={`Tudo que entra no ano de ${year} — inclui projeção (recebimentos previstos + realizados), consistente com o gráfico anual. Atenção: receitas futuras de ago–dez que você ainda não lançou não aparecem aqui, então o resultado projetado tende a parecer pior que a realidade.`}
          context="realizado + previsto"
        />
        <KpiCard
          label={`Despesa ${year}`}
          value={fmtMoney(y.despesaAno)}
          tone="neg"
          icon={<ArrowDownCircle className="w-4 h-4" />}
          info={`Tudo que sai no ano de ${year} — inclui projeção (despesas previstas + realizadas). É um cenário: assume que TODOS os planejados até dezembro acontecem (parcelamentos, contratos etc.). Consolidado (todos os projetos), sem pagamento de fatura / movimentação interna (não é consumo) nem espelhos cross-project (não duplica). Para ver só o que já saiu, use o DRE.`}
          context="realizado + planejado"
        />
        <KpiCard
          label="Resultado do ano"
          value={fmtMoney(y.resultadoAno)}
          tone={y.resultadoAno >= 0 ? 'pos' : 'neg'}
          icon={<Scale className="w-4 h-4" />}
          info={`Receita − despesa do ano, incluindo projeção. É um CENÁRIO, não a foto de hoje: assume que todos os planejados até dezembro acontecem E que nenhuma receita nova de ago–dez foi lançada ainda — por isso costuma parecer mais negativo que a realidade. Para o resultado realizado (o que de fato aconteceu), veja o DRE. Sem neutros nem espelhos.`}
          context="cenário projetado"
        />
        <KpiCard
          label="Gasto médio mensal"
          value={fmtMoney(gastoMensal.valor)}
          tone="neutral"
          icon={<Receipt className="w-4 h-4" />}
          info={`Quanto você gasta por mês, em média: total gasto no ano ÷ 12 (ano cheio, valor normalizado para projeção). Só despesas REALIZADAS (planejado futuro não conta). Consolidado, sem pagamento de fatura / movimentação interna nem espelhos cross-project.`}
          context="total do ano ÷ 12"
        />
      </div>

      <Card
        title={(
          <div className="flex min-w-0 items-center gap-2">
            <span>Fluxo de caixa mensal</span>
            <span className="inline-flex items-center rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-0.5">
              {([
                ['mensal', 'Mensal'],
                ['acumuladaReal', 'Acumulada real'],
                ['acumuladaRealPlus', 'Real + planejada'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setFluxoMode(mode)}
                  className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    fluxoMode === mode
                      ? 'bg-[var(--ck-accent)] text-white'
                      : 'text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
        )}
        hint="meses claros = projeção"
      >
        <FluxoCaixaAnualChart meses={y.meses} mode={fluxoMode} />
      </Card>

      <Card title="Evolução do patrimônio" hint={`base: ${fmtMoney(y.patrimonioInicioAno)}`}>
        <EvolucaoPatrimonioChart meses={y.meses} />
      </Card>

      <CategoriasBarras
        categorias={categoriasAno}
        title="Categorias do ano"
        hint={`${year} · ${categoriasAno.length} ${categoriasAno.length === 1 ? 'categoria' : 'categorias'} · ~média/mês (pagas ÷12)`}
        columns={3}
        headerExtra={
          <span className="inline-flex items-center rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-0.5">
            {([
              ['real', 'Realizado'],
              ['realPlus', 'Realizado + planejado'],
            ] as ['real' | 'realPlus', string][]).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setCatStatusMode(mode)}
                className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  catStatusMode === mode
                    ? 'bg-[var(--ck-accent)] text-white'
                    : 'text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </span>
        }
        onCategoryClick={setCatAberta}
      />

      {projectId && (
        <ArvoreGastos
          projectId={projectId}
          entries={yearEntries}
          eixo={eixo ?? 'competencia'}
          title="Árvore de gastos do ano"
          hint={`${year} · por origem e tipo`}
        />
      )}

      <CategoriaDespesasModal
        categoria={catAberta}
        entries={yearEntries}
        year={year}
        statusMode={catStatusMode}
        onClose={() => setCatAberta(null)}
      />
    </div>
  );
}
