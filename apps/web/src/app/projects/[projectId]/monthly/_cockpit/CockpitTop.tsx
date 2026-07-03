'use client';

import { useMemo, useState } from 'react';
import { Wallet, Scale, Target, ArrowUpRight, ArrowDownRight, Lightbulb, ChevronDown } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import { Card, type Tone } from './ui';
import { InfoHint } from '@/components/InfoHint';
import { fmtMoney, fmtPct, mesLongo } from './format';
import { moneyShort, moneyExact } from '@/lib/money';
import { deriveCockpitTop, deriveMonth, saldoProjetado } from './derive';
import { RecomendacoesList } from './Recomendacoes';

const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-[var(--ck-accent)]',
  pos: 'text-[var(--ck-pos)]',
  neg: 'text-[var(--ck-neg)]',
  alert: 'text-[var(--ck-alert)]',
  neutral: 'text-[var(--ck-text)]',
};
const TONE_STROKE: Record<Tone, string> = {
  accent: '#0A6CF0',
  pos: '#1E924A',
  neg: '#D92D20',
  alert: '#B5803A',
  neutral: '#8A857C',
};

/** Sparkline SVG leve (sem recharts). Recebe valores em centavos. */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const path = useMemo(() => {
    if (data.length < 2) return null;
    const w = 100;
    const h = 28;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const pts = data.map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { line: `M${pts.join(' L')}`, area: `M0,${h} L${pts.join(' L')} L${w},${h} Z` };
  }, [data]);

  if (!path) return null;
  const gid = `spark-${color.replace('#', '')}`;
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="w-full h-7" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={path.area} fill={`url(#${gid})`} />
      <path d={path.line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Delta({ value, tone }: { value: string; tone: Tone }) {
  const up = tone === 'pos' || tone === 'accent';
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${TONE_TEXT[tone]}`}>
      <Icon className="w-3 h-3" />
      {value}
    </span>
  );
}

/** Card grande com valor, contexto, delta opcional e sparkline opcional. */
function HeroCard({
  label, value, tone, icon, hint, delta, spark, info, emphasis = false,
}: {
  label: string;
  value: string;
  tone: Tone;
  icon: React.ReactNode;
  hint?: React.ReactNode;
  delta?: { value: string; tone: Tone };
  spark?: number[];
  info?: string;
  /** Realça o valor no mobile (KPI hero principal, ~30px). Desktop inalterado. */
  emphasis?: boolean;
}) {
  return (
    <Card className="ck-enter flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)] truncate">{label}</p>
          {info && <InfoHint text={info} className="text-[var(--ck-muted)]" />}
        </span>
        <span className="text-[var(--ck-muted)]">{icon}</span>
      </div>
      <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between md:gap-2">
        <p className={`font-geist tabular-nums font-bold ${emphasis ? 'text-[30px]' : 'text-xl'} md:text-[26px] leading-none ${TONE_TEXT[tone]}`}>
          {value}
        </p>
        {delta && <Delta value={delta.value} tone={delta.tone} />}
      </div>
      {spark && spark.length >= 2 && <Sparkline data={spark} color={TONE_STROKE[tone]} />}
      {hint && <p className="text-[13px] text-[var(--ck-muted)] leading-snug">{hint}</p>}
    </Card>
  );
}

export default function CockpitTop({
  data,
  monthKey,
  entries,
  showRecs = true,
}: {
  data: MonthlyOverviewResponse;
  monthKey?: string;
  entries?: MonthlyEntry[];
  /** Renderiza o bloco de recomendações dentro do card do topo (só na visão Mês). */
  showRecs?: boolean;
}) {
  const t = useMemo(() => deriveCockpitTop(data), [data]);
  const recs = useMemo(() => {
    if (!showRecs) return null;
    const m = deriveMonth(data, monthKey ?? data.mesAtual, entries);
    return { m, projetado: saldoProjetado(m, m.ritmoDiario) };
  }, [showRecs, data, monthKey, entries]);

  const [exact, setExact] = useState(false);

  const sobra = t.projecaoMes - t.caixaValor; // a receber − a pagar do mês
  const resultadoTone: Tone = t.resultadoMes >= 0 ? 'pos' : 'neg';
  const projTone: Tone = sobra >= 0 ? 'pos' : 'alert';

  const [, mStr] = t.mesAtualKey.split('-');
  const mesNome = mesLongo(mStr ? parseInt(mStr, 10) - 1 : 0);

  // "Corredor do mês": semáforo do fechamento projetado.
  const statusKind: 'green' | 'amber' | 'red' =
    t.projecaoMes < 0 ? 'red' : sobra < 0 ? 'amber' : 'green';
  const STATUS = {
    green: { lbl: 'No caminho', text: 'text-[var(--ck-pos)]', band: 'bg-[var(--ck-pos)]', fill: 'var(--ck-pos)' },
    amber: { lbl: 'No limite', text: 'text-[var(--ck-alert)]', band: 'bg-[var(--ck-alert)]', fill: 'var(--ck-alert)' },
    red: { lbl: 'Fecha no vermelho', text: 'text-[var(--ck-neg)]', band: 'bg-[var(--ck-neg)]', fill: 'var(--ck-neg)' },
  }[statusKind];
  const pct = Math.max(4, Math.round(t.pctMesDecorrido * 100));
  const caixaBig = exact ? moneyExact(t.caixaValor) : moneyShort(t.caixaValor);
  const caixaToneText =
    t.caixaValor >= 0 ? (t.caixaReal ? 'text-[var(--ck-accent)]' : 'text-[var(--ck-pos)]') : 'text-[var(--ck-neg)]';

  const fechamento =
    sobra >= 0
      ? `${mesNome} fecha em ${moneyShort(t.projecaoMes)} — sobram ${moneyShort(sobra)} depois do que falta.`
      : `${mesNome} fecha em ${moneyShort(t.projecaoMes)} — faltam ${moneyShort(-sobra)} a cobrir até o fim do mês.`;

  return (
    <div className="space-y-3 mb-5">
      {/* Corredor do mês (herói) */}
      <Card className="ck-enter relative overflow-hidden">
        <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${STATUS.band}`} aria-hidden />
        <div className="flex items-center justify-between gap-2">
          <span className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] ${STATUS.text}`}>
            <span aria-hidden>●</span> {STATUS.lbl}
            <InfoHint
              text="Semáforo do fim do mês pela projeção (caixa hoje + o que ainda entra − o que ainda falta pagar). Verde = sobra; âmbar = fica no positivo mas ainda falta cobrir; vermelho = deve fechar negativo."
              className={STATUS.text}
            />
          </span>
          <span className="text-[var(--ck-muted)]"><Wallet className="w-4 h-4" /></span>
        </div>

        <p className="mt-1 text-[13px] text-[var(--ck-muted)]">{t.caixaReal ? 'Caixa hoje' : 'Resultado realizado'}</p>
        <button
          type="button"
          onClick={() => setExact((v) => !v)}
          title="Tocar alterna abreviado / exato"
          className={`mt-1 block text-left font-geist tabular-nums font-bold text-[34px] leading-none ${caixaToneText}`}
        >
          {caixaBig}
        </button>

        {/* trilha do mês: hoje + fechamento projetado num só olhar */}
        <div className="mt-4">
          <div className="relative h-8 overflow-hidden rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)]">
            <div
              className="absolute inset-y-0 left-0 rounded-l-xl transition-[width] duration-500"
              style={{ width: `${pct}%`, background: STATUS.fill, opacity: 0.16 }}
            />
            <div className="absolute -inset-y-0.5 w-0.5 bg-[var(--ck-text)]" style={{ left: `${pct}%` }} />
            <span className={`absolute right-2 top-1/2 -translate-y-1/2 font-geist tabular-nums text-[11px] font-bold ${STATUS.text}`}>
              fecha {moneyShort(t.projecaoMes)}
            </span>
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-[var(--ck-muted)]">
            <span>dia 1</span>
            <span>hoje · {Math.round(t.pctMesDecorrido * 100)}%</span>
            <span>fim do mês</span>
          </div>
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-[var(--ck-muted)]">{fechamento}</p>

        {recs && (
          <details className="group mt-4 border-t border-[var(--ck-border)] pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ck-muted)] transition-colors hover:text-[var(--ck-text)] [&::-webkit-details-marker]:hidden">
              <Lightbulb className="h-3.5 w-3.5" />
              Recomendações
              <ChevronDown className="ml-0.5 h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <div className="mt-3">
              <RecomendacoesList m={recs.m} saldoProjetadoVal={recs.projetado} />
            </div>
          </details>
        )}
      </Card>

      {/* 2-up compacto: Resultado · Projeção (Caixa virou o herói acima) */}
      <div className="grid grid-cols-2 gap-3">
        <HeroCard
          label={`Resultado de ${mesNome}`}
          value={moneyShort(t.resultadoMes)}
          tone={resultadoTone}
          icon={<Scale className="w-4 h-4" />}
          info={`O que já aconteceu neste mês: recebimentos realizados (${fmtMoney(t.resultadoEntrou)}) menos despesas realizadas (${fmtMoney(t.resultadoGastou)}). Só conta o que já foi efetivamente pago/recebido — não inclui o que ainda está por vir.`}
          delta={
            t.resultadoDeltaPct != null
              ? { value: `${t.resultadoDeltaPct >= 0 ? 'melhorou' : 'piorou'} ${fmtPct(Math.abs(t.resultadoDeltaPct), 0)}`, tone: t.resultadoDeltaPct >= 0 ? 'pos' : 'neg' }
              : undefined
          }
          hint={
            <>
              entrou <span className="font-semibold text-[var(--ck-pos)]">{fmtMoney(t.resultadoEntrou)}</span>
              {' · '}saiu <span className="font-semibold text-[var(--ck-neg)]">{fmtMoney(t.resultadoGastou)}</span>
            </>
          }
        />
        <HeroCard
          label={`Projeção fim de ${mesNome}`}
          value={moneyShort(t.projecaoMes)}
          tone={projTone}
          icon={<Target className="w-4 h-4" />}
          info={`Como o mês deve fechar: caixa de hoje + o que ainda falta receber (${fmtMoney(t.aReceberMes)}) − o que ainda falta pagar (${fmtMoney(t.aPagarMes)}). É uma previsão — inclui contas e faturas que ainda não saíram.`}
          hint={
            <>
              a receber <span className="font-semibold text-[var(--ck-pos)]">{fmtMoney(t.aReceberMes)}</span>
              {' · '}a pagar <span className="font-semibold text-[var(--ck-neg)]">{fmtMoney(t.aPagarMes)}</span>
            </>
          }
        />
      </div>
    </div>
  );
}
