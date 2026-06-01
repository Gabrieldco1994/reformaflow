'use client';

import type { CSSProperties, ReactNode } from 'react';

/** Tokens do tema cockpit (dark instrument). Aplicados via CSS vars no root. */
export const COCKPIT_THEME = {
  '--ck-bg': '#0a0e16',
  '--ck-surface': '#131b2a',
  '--ck-surface-2': '#1a2435',
  '--ck-border': 'rgba(255,255,255,.08)',
  '--ck-text': '#e9eef7',
  '--ck-muted': '#8593a8',
  '--ck-pos': '#4fd1a5',
  '--ck-neg': '#ff6b7d',
  '--ck-alert': '#ffc14d',
  '--ck-accent': '#6ee7d8',
} as CSSProperties;

export function Card({
  children,
  className = '',
  title,
  hint,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div
      className={`rounded-[18px] border border-[var(--ck-border)] bg-gradient-to-b from-[var(--ck-surface)] to-[var(--ck-bg)] p-4 md:p-5 shadow-[0_8px_30px_rgba(0,0,0,.25)] ${className}`}
    >
      {(title || hint) && (
        <div className="flex items-baseline justify-between gap-2 mb-3">
          {title && <h3 className="text-sm font-semibold text-[var(--ck-text)]">{title}</h3>}
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
}: {
  label: string;
  value: string;
  context?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}) {
  return (
    <Card className="ck-enter">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)]">{label}</p>
        {icon && <span className="text-[var(--ck-muted)]">{icon}</span>}
      </div>
      <p className={`font-mono tabular-nums font-bold text-2xl md:text-[28px] leading-tight mt-1.5 ${TONE_TEXT[tone]}`}>
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

/** Tooltip escuro reutilizável para os gráficos recharts. */
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
    <div className="rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="text-[var(--ck-muted)] mb-1">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-1.5 text-[var(--ck-text)] tabular-nums font-mono">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-[var(--ck-muted)]">{p.name}:</span> {formatter(p.value)}
        </p>
      ))}
    </div>
  );
}
