'use client';

import { useMemo } from 'react';
import { Wallet, Scale, Target, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import type { MonthlyOverviewResponse } from '../_types';
import { Card, type Tone } from './ui';
import { fmtMoney, fmtPct, mesLongo } from './format';
import { deriveCockpitTop } from './derive';

const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-[var(--ck-accent)]',
  pos: 'text-[var(--ck-pos)]',
  neg: 'text-[var(--ck-neg)]',
  alert: 'text-[var(--ck-alert)]',
  neutral: 'text-[var(--ck-text)]',
};
const TONE_STROKE: Record<Tone, string> = {
  accent: '#6ee7d8',
  pos: '#4fd1a5',
  neg: '#ff6b7d',
  alert: '#ffc14d',
  neutral: '#8593a8',
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
  label, value, tone, icon, hint, delta, spark,
}: {
  label: string;
  value: string;
  tone: Tone;
  icon: React.ReactNode;
  hint?: React.ReactNode;
  delta?: { value: string; tone: Tone };
  spark?: number[];
}) {
  return (
    <Card className="ck-enter flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)]">{label}</p>
        <span className="text-[var(--ck-muted)]">{icon}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className={`font-mono tabular-nums font-bold text-2xl md:text-[26px] leading-none ${TONE_TEXT[tone]}`}>
          {value}
        </p>
        {delta && <Delta value={delta.value} tone={delta.tone} />}
      </div>
      {spark && spark.length >= 2 && <Sparkline data={spark} color={TONE_STROKE[tone]} />}
      {hint && <p className="text-[11px] text-[var(--ck-muted)] leading-snug">{hint}</p>}
    </Card>
  );
}

export default function CockpitTop({ data }: { data: MonthlyOverviewResponse }) {
  const t = useMemo(() => deriveCockpitTop(data), [data]);

  const caixaTone: Tone = t.caixaValor >= 0 ? 'accent' : 'neg';
  const resultadoTone: Tone = t.resultadoMes >= 0 ? 'pos' : 'neg';
  const sobra = t.projecaoMes - t.caixaValor; // a receber − a pagar do mês
  const projTone: Tone = sobra >= 0 ? 'pos' : 'alert';

  const [, mStr] = t.mesAtualKey.split('-');
  const mesNome = mesLongo(mStr ? parseInt(mStr, 10) - 1 : 0);

  // Frase-resumo do mês.
  const headline = t.caixaReal
    ? `Você tem ${fmtMoney(t.caixaValor)} em caixa.`
    : `Resultado realizado de ${fmtMoney(t.caixaValor)}.`;
  const fechamento =
    sobra >= 0
      ? `${mesNome} caminha pra fechar em ${fmtMoney(t.projecaoMes)} — sobram ${fmtMoney(sobra)} depois do que falta.`
      : `${mesNome} caminha pra fechar em ${fmtMoney(t.projecaoMes)} — faltam ${fmtMoney(-sobra)} a cobrir até o fim do mês.`;

  return (
    <div className="space-y-3 mb-5">
      {/* Headline narrativo */}
      <Card className="ck-enter">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <p className="text-sm md:text-base text-[var(--ck-text)] leading-relaxed max-w-2xl">
            <span className={TONE_TEXT[caixaTone]}>{headline}</span>{' '}
            <span className="text-[var(--ck-muted)]">{fechamento}</span>
          </p>
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)]">
              {Math.round(t.pctMesDecorrido * 100)}% de {mesNome}
            </p>
            <div className="mt-1 h-1.5 w-28 rounded-full bg-[var(--ck-surface-2)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--ck-accent)] transition-[width] duration-500"
                style={{ width: `${Math.max(2, t.pctMesDecorrido * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* 3 cards: Caixa · Resultado · Projeção */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <HeroCard
          label={t.caixaReal ? 'Caixa (conta corrente)' : 'Resultado realizado'}
          value={fmtMoney(t.caixaValor)}
          tone={caixaTone}
          icon={<Wallet className="w-4 h-4" />}
          delta={
            t.caixaDelta !== 0
              ? { value: `${t.caixaDelta > 0 ? '+' : ''}${fmtMoney(t.caixaDelta)} no mês`, tone: t.caixaDelta >= 0 ? 'pos' : 'neg' }
              : undefined
          }
          spark={t.caixaSpark}
          hint={t.caixaReal ? 'reconciliado com o saldo do banco' : 'cadastre o saldo inicial da conta p/ ver o caixa do banco'}
        />
        <HeroCard
          label={`Resultado de ${mesNome}`}
          value={fmtMoney(t.resultadoMes)}
          tone={resultadoTone}
          icon={<Scale className="w-4 h-4" />}
          delta={
            t.resultadoDeltaPct != null
              ? { value: `${fmtPct(Math.abs(t.resultadoDeltaPct), 0)} vs mês anterior`, tone: t.resultadoDeltaPct >= 0 ? 'pos' : 'neg' }
              : undefined
          }
          hint={`entrou ${fmtMoney(t.resultadoEntrou)} · saiu ${fmtMoney(t.resultadoGastou)}`}
        />
        <HeroCard
          label={`Projeção fim de ${mesNome}`}
          value={fmtMoney(t.projecaoMes)}
          tone={projTone}
          icon={<Target className="w-4 h-4" />}
          hint={`a receber ${fmtMoney(t.aReceberMes)} · a pagar ${fmtMoney(t.aPagarMes)}`}
        />
      </div>
    </div>
  );
}
