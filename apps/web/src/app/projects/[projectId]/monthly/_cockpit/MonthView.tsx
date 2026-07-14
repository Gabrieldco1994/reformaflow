'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { SlidersHorizontal, Target } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import type { MetaProgress } from '../../metas/_components/MetaCategoriaCard';
import { tipoLabel } from '@/lib/expense-options';
import { metaProgressTone } from '../../metas/_lib/metaTone';
import { Card, Progress } from './ui';
import { fmtMoney } from './format';
import { deriveMonth, buildSaldoSeries, saldoProjetado } from './derive';
import CategoriasBarras from './CategoriasBarras';
import ArvoreGastos from './ArvoreGastos';
import { DesktopRail } from './DesktopRail';
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
  metasProgress = [],
}: {
  data: MonthlyOverviewResponse;
  monthKey?: string;
  entries?: MonthlyEntry[];
  projectId?: string;
  /** Usado só pelo `DesktopRail` (opções de despesa do launcher); cockpit é PESSOAL-only. */
  projectType?: string;
  eixo?: Eixo;
  /** Progresso de metas por categoria (`category-budgets/progress`), já buscado por `page.tsx`. */
  metasProgress?: MetaProgress[];
}) {
  const m = useMemo(() => deriveMonth(data, monthKey ?? data.mesAtual, entries), [data, monthKey, entries]);
  const [ritmo, setRitmo] = useState<number>(m.ritmoDiario);

  const serieEntries = entries ?? data.mesAtualEntries;
  const serie = useMemo(() => buildSaldoSeries(m, serieEntries, ritmo), [m, serieEntries, ritmo]);
  const projetado = useMemo(() => saldoProjetado(m, ritmo), [m, ritmo]);
  const projTone = projetado >= m.saldoInicial ? 'pos' : 'neg';
  const maxRitmo = Math.max(m.ritmoDiario * 3, 30000); // teto do slider (centavos/dia)
  const atingiuReserva = m.reservaMeses >= m.reservaMeta;
  const faltamReserva = Math.max(0, m.reservaMeta - m.reservaMeses);
  const progressoReserva = m.reservaMeta > 0 ? m.reservaMeses / m.reservaMeta : 0;
  const metasVisiveis = metasProgress.slice(0, 4);
  const metasRestantes = metasProgress.length - metasVisiveis.length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card
          className="xl:col-span-2"
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
        {projectId && <DesktopRail projectId={projectId} projectType={projectType ?? 'PESSOAL'} />}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <CategoriasBarras categorias={m.categorias} hint="mês atual" />
        {projectId && (
          <Card title="Saúde financeira e metas do mês">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <section aria-label="Saúde financeira" className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[11px] text-[var(--ck-muted)]">Reserva de emergência</p>
                  <p className={`text-sm font-geist tabular-nums ${atingiuReserva ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-alert)]'}`}>
                    {m.reservaMeses.toFixed(1).replace('.', ',')} / {m.reservaMeta} meses
                  </p>
                </div>
                <Progress value={progressoReserva} tone={atingiuReserva ? 'pos' : 'alert'} />
                <p className="text-[11px] text-[var(--ck-muted)]">
                  {atingiuReserva ? (
                    <span className="text-[var(--ck-pos)]">Meta de {m.reservaMeta} meses atingida.</span>
                  ) : (
                    <>Faltam <strong className="text-[var(--ck-text)]">{faltamReserva.toFixed(1).replace('.', ',')}</strong> meses para a meta.</>
                  )}
                </p>
              </section>

              <section aria-label="Metas do mês" className="space-y-2">
                {metasProgress.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-1 text-center">
                    <Target className="h-5 w-5 text-[var(--ck-muted)]" />
                    <p className="text-xs text-[var(--ck-muted)]">Nenhuma meta definida ainda para este mês.</p>
                    <Link
                      href={`/projects/${projectId}/metas`}
                      className="text-xs font-semibold text-[var(--ck-accent)] hover:underline"
                    >
                      Criar metas
                    </Link>
                  </div>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {metasVisiveis.map((item) => {
                        const tone = metaProgressTone(item.pct);
                        return (
                          <li key={item.tipoDespesa} className="flex items-center justify-between gap-2 text-xs">
                            <span className="min-w-0 truncate text-[var(--ck-text)]">{tipoLabel(item.tipoDespesa)}</span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone.txt} bg-[var(--ck-surface-2)]`}>
                              {item.pct}% · {tone.label}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="flex items-center justify-between gap-2 pt-1">
                      {metasRestantes > 0 ? (
                        <span className="text-[11px] text-[var(--ck-muted)]">+{metasRestantes}</span>
                      ) : (
                        <span />
                      )}
                      <Link
                        href={`/projects/${projectId}/metas`}
                        className="text-xs font-semibold text-[var(--ck-accent)] hover:underline"
                      >
                        Ver metas
                      </Link>
                    </div>
                  </>
                )}
              </section>
            </div>
          </Card>
        )}
      </div>

      {projectId && (
        <div className="mt-4">
          <ArvoreGastos
            projectId={projectId}
            entries={serieEntries}
            eixo={eixo ?? 'competencia'}
            hint="mês atual · por origem e tipo"
          />
        </div>
      )}
    </div>
  );
}
