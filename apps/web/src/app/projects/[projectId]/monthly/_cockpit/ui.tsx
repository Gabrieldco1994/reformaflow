'use client';

import type { CSSProperties, ReactNode } from 'react';
import { InfoHint } from '@/components/InfoHint';

/** Tokens do tema cockpit (LifeOne light). Aplicados via CSS vars no root. */
export const COCKPIT_THEME = {
  '--ck-bg': '#F4F3F0',
  '--ck-surface': '#FFFFFF',
  '--ck-surface-2': '#F4F3F0',
  '--ck-border': '#ECE8E1',
  '--ck-text': '#1C1C1E',
  '--ck-muted': '#6E6A63',
  '--ck-pos': '#1E924A',
  '--ck-neg': '#D92D20',
  '--ck-alert': '#B5803A',
  '--ck-accent': '#0A6CF0',
} as CSSProperties;

export function Card({
  children,
  className = '',
  title,
  hint,
  info,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  hint?: ReactNode;
  info?: string;
}) {
  return (
    <div
      className={`rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 md:p-5 shadow-lifeone-card ${className}`}
    >
      {(title || hint) && (
        <div className="flex items-baseline justify-between gap-2 mb-3">
          {title && (
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--ck-text)]">
              {title}
              {info && <InfoHint text={info} />}
            </h3>
          )}
          {hint && <span className="text-[10px] text-[var(--ck-muted)]">{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export type Tone = 'accent' | 'pos' | 'neg' | 'alert' | 'neutral';

const TONE_TEXT: Record<Tone, string> = {
  accent: 'text-[var(--ck-accent)]',
  pos: 'text-[var(--ck-pos)]',
  neg: 'text-[var(--ck-neg)]',
  alert: 'text-[var(--ck-alert)]',
  neutral: 'text-[var(--ck-text)]',
};

export function KpiCard({
  label,
  value,
  context,
  tone = 'neutral',
  icon,
  info,
}: {
  label: string;
  value: string;
  context?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  info?: string;
}) {
  return (
    <Card className="ck-enter">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)] truncate">{label}</p>
          {info && <InfoHint text={info} className="text-[var(--ck-muted)]" />}
        </span>
        {icon && <span className="text-[var(--ck-muted)]">{icon}</span>}
      </div>
      <p className={`font-geist tabular-nums font-bold text-2xl md:text-[28px] leading-tight mt-1.5 ${TONE_TEXT[tone]}`}>
        {value}
      </p>
      {context && <p className="text-[11px] text-[var(--ck-muted)] mt-1">{context}</p>}
    </Card>
  );
}

export function Progress({ value, tone = 'accent' }: { value: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bg: Record<Tone, string> = {
    accent: 'bg-[var(--ck-accent)]',
    pos: 'bg-[var(--ck-pos)]',
    neg: 'bg-[var(--ck-neg)]',
    alert: 'bg-[var(--ck-alert)]',
    neutral: 'bg-[var(--ck-text)]',
  };
  return (
    <div className="h-2 rounded-full bg-[var(--ck-surface-2)] overflow-hidden">
      <div className={`h-full rounded-full transition-[width] duration-500 ${bg[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Tooltip claro reutilizável para os gráficos recharts. */
export function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string | number;
  formatter: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 py-2 text-xs shadow-lifeone-hover">
      {label !== undefined && <p className="text-[var(--ck-muted)] mb-1">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-1.5 text-[var(--ck-text)] tabular-nums font-geist">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-[var(--ck-muted)]">{p.name}:</span> {formatter(p.value)}
        </p>
      ))}
    </div>
  );
}
