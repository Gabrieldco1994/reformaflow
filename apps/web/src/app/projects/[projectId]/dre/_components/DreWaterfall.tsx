'use client';

import { useId } from 'react';
import { moneyShort } from '@/lib/money';

export type WaterfallStep = {
  key: string;
  label: string;
  /** Centavos. Magnitude para deltas (in/out/save); valor com sinal para totais. */
  amount: number;
  kind: 'in' | 'out' | 'save' | 'result';
  /** Barra ancorada no zero (marcos de início/fim da cascata). */
  isTotal?: boolean;
};

const TONE = {
  in: '#1D9E75',
  out: '#D85A30',
  save: '#BA7517',
  resultPos: '#0F6B4D',
  resultNeg: '#B4441F',
} as const;

function toneFor(step: WaterfallStep) {
  if (step.kind === 'result') return step.amount >= 0 ? TONE.resultPos : TONE.resultNeg;
  return TONE[step.kind];
}

/** Cascata (waterfall) do DRE: mostra passo a passo como o saldo se forma. */
export function DreWaterfall({ steps }: { steps: WaterfallStep[] }) {
  const clipId = useId();
  const W = 660;
  const H = 300;
  const padL = 52;
  const padR = 14;
  const padT = 34;
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Percorre a cascata acumulando o saldo corrente e registrando cada segmento.
  let running = 0;
  const segments = steps.map((step) => {
    let start: number;
    let end: number;
    if (step.isTotal) {
      start = 0;
      end = step.amount;
      running = step.amount;
    } else {
      start = running;
      const delta = step.kind === 'out' || step.kind === 'save' ? -step.amount : step.amount;
      end = running + delta;
      running = end;
    }
    return { step, start, end, top: Math.max(start, end), bot: Math.min(start, end) };
  });

  const values = segments.flatMap((s) => [s.top, s.bot, 0]);
  let domainMax = Math.max(...values);
  let domainMin = Math.min(...values);
  const rawSpan = domainMax - domainMin || 1;
  const headroom = rawSpan * 0.08;
  if (domainMax > 0) domainMax += headroom;
  if (domainMin < 0) domainMin -= headroom;
  const span = domainMax - domainMin || 1;
  const y = (v: number) => padT + plotH * (1 - (v - domainMin) / span);

  const slot = plotW / segments.length;
  const barW = Math.min(66, slot * 0.56);

  // Linhas-guia: base zero + marcos superior/inferior do domínio.
  const gridValues = Array.from(new Set([domainMin, domainMin + span / 2, domainMax, 0]));

  const fmtStep = (step: WaterfallStep) => {
    if (step.amount === 0) return '0';
    const sign =
      step.kind === 'out' || step.kind === 'save'
        ? '−'
        : step.kind === 'result'
          ? step.amount >= 0
            ? '+'
            : '−'
          : '+';
    return `${sign} ${moneyShort(Math.abs(step.amount)).replace('R$ ', '')}`;
  };

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Cascata do resultado do mês"
      style={{ fontFamily: 'Geist, system-ui, sans-serif' }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={padL} y={padT - 4} width={plotW} height={plotH + 8} />
        </clipPath>
      </defs>

      {gridValues.map((gv) => {
        const gy = y(gv);
        const isZero = gv === 0;
        return (
          <g key={`grid-${gv}`}>
            <line
              x1={padL}
              y1={gy}
              x2={W - padR}
              y2={gy}
              stroke={isZero ? '#D8D2C7' : '#ECE8E1'}
              strokeWidth={isZero ? 1.4 : 1}
            />
            <text x={padL - 8} y={gy + 3} textAnchor="end" fontSize={10} fill="#A7A29A">
              {moneyShort(gv).replace('R$ ', '')}
            </text>
          </g>
        );
      })}

      <g clipPath={`url(#${clipId})`}>
        {segments.map((seg, i) => {
          const cx = padL + slot * i + slot / 2;
          const x = cx - barW / 2;
          const yt = y(seg.top);
          const h = Math.max(3, y(seg.bot) - yt);
          const color = toneFor(seg.step);
          const next = segments[i + 1];
          return (
            <g key={seg.step.key}>
              <rect x={x} y={yt} width={barW} height={h} rx={6} fill={color} />
              {next && (
                <line
                  x1={x + barW}
                  y1={y(seg.end)}
                  x2={padL + slot * (i + 1) + slot / 2 - barW / 2}
                  y2={y(seg.end)}
                  stroke="#CBC3B4"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                />
              )}
            </g>
          );
        })}
      </g>

      {/* Rótulos de valor (fora do clip, com clamp vertical). */}
      {segments.map((seg, i) => {
        const cx = padL + slot * i + slot / 2;
        const yt = y(seg.top);
        const h = Math.max(3, y(seg.bot) - yt);
        const labelUp = seg.end >= seg.start;
        const rawY = labelUp ? yt - 9 : yt + h + 16;
        const labelY = Math.min(Math.max(rawY, padT + 4), H - padB - 4);
        return (
          <text
            key={`v-${seg.step.key}`}
            x={cx}
            y={labelY}
            textAnchor="middle"
            fontSize={12.5}
            fontWeight={700}
            fill={toneFor(seg.step)}
          >
            {fmtStep(seg.step)}
          </text>
        );
      })}

      {segments.map((seg, i) => {
        const cx = padL + slot * i + slot / 2;
        return (
          <text
            key={`x-${seg.step.key}`}
            x={cx}
            y={H - 16}
            textAnchor="middle"
            fontSize={11.5}
            fontWeight={600}
            fill="#6E6A63"
          >
            {seg.step.label}
          </text>
        );
      })}
    </svg>
  );
}
