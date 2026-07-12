'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { SlidersHorizontal } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import type { DreMensal, DreSaldoAcumuladoRow } from '../../dre/_types';
import type { MetaProgress } from '../../metas/_components/MetaCategoriaCard';
import { Card } from './ui';
import { fmtMoney } from './format';
import { deriveMonth, buildSaldoSeries, saldoProjetado, buildComprometimentoFuturo } from './derive';
import CategoriasBarras from './CategoriasBarras';
import SaudeFinanceira from './SaudeFinanceira';
import ComprometimentoFuturo from './ComprometimentoFuturo';
import ArvoreGastos from './ArvoreGastos';
import { DesktopRail } from './DesktopRail';
import { RunwayScenario } from './RunwayScenario';
import { DreGlance } from './DreGlance';
import { MetasGlance } from './MetasGlance';
import type { Eixo } from './EixoToggle';

const SaldoMesChart = dynamic(() => import('./SaldoMesChart'), {
  ssr: false,
  loading: () => <div className="h-[280px] rounded-xl bg-[var(--ck-surface-2)] animate-pulse" />,
});

export default function MonthView({
  data,
  monthKey,
  entries,
  projectId,
  projectType,
  eixo,
  dreMensal,
  runwaySerie,
  metasProgress = [],
}: {
  data: MonthlyOverviewResponse;
  monthKey?: string;
  entries?: MonthlyEntry[];
  projectId?: string;
  /** Usado só pelo `DesktopRail` (opções de despesa do launcher); cockpit é PESSOAL-only. */
  projectType?: string;
  eixo?: Eixo;
  /** DRE mensal já buscado por `page.tsx` (mesmo `dre-overview` do RunwayScenario) — sem query própria aqui. */
  dreMensal?: DreMensal;
  /** Série anual de saldo acumulado (`dre-overview`), para o "E se...?" do runway desktop. */
  runwaySerie?: DreSaldoAcumuladoRow[];
  /** Progresso de metas por categoria (`category-budgets/progress`), já buscado por `page.tsx`. */
  metasProgress?: MetaProgress[];
}) {
  const m = useMemo(() => deriveMonth(data, monthKey ?? data.mesAtual, entries), [data, monthKey, entries]);
  const [ritmo, setRitmo] = useState<number>(m.ritmoDiario);

  const serieEntries = entries ?? data.mesAtualEntries;
  const serie = useMemo(() => buildSaldoSeries(m, serieEntries, ritmo), [m, serieEntries, ritmo]);
  const projetado = useMemo(() => saldoProjetado(m, ritmo), [m, ritmo]);
  const comprometimento = useMemo(
    () => buildComprometimentoFuturo(data, monthKey ?? data.mesAtual, 12, projectId),
    [data, monthKey, projectId],
  );

  const projTone = projetado >= m.saldoInicial ? 'pos' : 'neg';
  const maxRitmo = Math.max(m.ritmoDiario * 3, 30000); // teto do slider (centavos/dia)
  const currentMonth = monthKey ?? data.mesAtual;

  return (
    <div className={projectId ? 'lg:grid lg:grid-cols-3 lg:items-start lg:gap-4' : ''}>
      <div className={`space-y-4 ${projectId ? 'lg:col-span-2' : ''}`}>
        <Card
          title={m.caixaReal ? 'Fluxo de caixa do mês' : 'Saldo ao longo do mês'}
          hint={m.caixaReal
            ? `começa no caixa real · inclui cartão (ainda não debitado)`
            : `dia ${m.hoje} de ${m.diasNoMes}`}
        >
          <SaldoMesChart serie={serie} hoje={m.hoje} />
          <div className="mt-4 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="text-[11px] uppercase tracking-wider text-[var(--ck-muted)] flex items-center gap-1.5">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Ritmo de gasto diário
              </label>
              <span className="text-sm font-geist tabular-nums text-[var(--ck-alert)]">{fmtMoney(ritmo)}/dia</span>
            </div>
            <input
              type="range"
              min={0}
              max={maxRitmo}
              step={500}
              value={Math.min(ritmo, maxRitmo)}
              onChange={(e) => setRitmo(Number(e.target.value))}
              className="w-full accent-[var(--ck-alert)]"
            />
            <div className="flex justify-between text-[10px] text-[var(--ck-muted)] mt-1">
              <span>R$ 0</span>
              <button
                type="button"
                onClick={() => setRitmo(m.ritmoDiario)}
                className="underline hover:text-[var(--ck-text)] transition-colors"
              >
                média atual ({fmtMoney(m.ritmoDiario)})
              </button>
              <span>{fmtMoney(maxRitmo)}</span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--ck-border)] pt-3">
              <span className="text-[11px] uppercase tracking-wider text-[var(--ck-muted)]">
                Se manter esse ritmo, termina o mês com
              </span>
              <span className={`font-geist tabular-nums text-lg font-bold ${projTone === 'pos' ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-neg)]'}`}>
                {fmtMoney(projetado)}
              </span>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <CategoriasBarras categorias={m.categorias} hint="mês atual" />
          <div className="space-y-4">
            <ComprometimentoFuturo rows={comprometimento} />
            <SaudeFinanceira m={m} />
          </div>
        </div>

        {dreMensal && projectId && <DreGlance data={dreMensal} projectId={projectId} />}

        {projectId && <MetasGlance progress={metasProgress} projectId={projectId} />}

        {projectId && (
          <ArvoreGastos
            projectId={projectId}
            entries={serieEntries}
            eixo={eixo ?? 'competencia'}
            hint="mês atual · por origem e tipo"
          />
        )}
      </div>

      {projectId && (
        <div className="hidden lg:block lg:col-span-1 space-y-4 mt-4 lg:mt-0">
          <DesktopRail
            projectId={projectId}
            projectType={projectType ?? 'PESSOAL'}
            comprometimento={comprometimento}
          />
          {runwaySerie && runwaySerie.length > 0 && (
            <RunwayScenario serie={runwaySerie} currentMonth={currentMonth} />
          )}
        </div>
      )}
    </div>
  );
}
