'use client';

import type { ReactNode } from 'react';
import { InfoHint } from '@/components/InfoHint';

/**
 * Componente único de KPI do app — substitui os três "dialetos" que existiam
 * (cockpit card claro, Visão Conta card tintado, Despesas hero escuro).
 *
 * Uma gramática só:
 * - `tone`  — cor SEMÂNTICA única (o que o número significa), não decorativa.
 * - `variant` — como o card se apresenta: `plain` (fundo branco, valor colorido),
 *   `tinted` (fundo/borda tintados do tone) ou `hero` (valor grande).
 *
 * Preserva os recursos que cada tela já usava: rótulo + InfoHint, valor,
 * contexto/ajuda, ícone, e modo clicável (quick-filter) com estado ativo.
 */

export type KpiTone = 'neutral' | 'positive' | 'negative' | 'alert' | 'accent';
export type KpiVariant = 'plain' | 'tinted' | 'hero';

/** Classes de fundo/borda/texto por tone na variante tintada. */
const TINTED: Record<KpiTone, string> = {
  positive: 'text-[#1E924A] bg-[#E3F6EA] border-[#BFE6CC]',
  alert: 'text-[#B5803A] bg-[#FBEBDC] border-[#EAD9C0]',
  negative: 'text-[#D92D20] bg-[#FCEBE9] border-[#F2C6C1]',
  accent: 'text-[#0A6CF0] bg-[#E6EFFE] border-[#CFE0FB]',
  neutral: 'text-lifeone-ink bg-lifeone-surface border-lifeone-hairline',
};

/** Cor só do valor (variantes plain/hero, fundo branco). */
const VALUE_COLOR: Record<KpiTone, string> = {
  positive: 'text-[#1E924A]',
  alert: 'text-[#B5803A]',
  negative: 'text-[#D92D20]',
  accent: 'text-[#0A6CF0]',
  neutral: 'text-lifeone-ink',
};

export interface KpiTileProps {
  label: ReactNode;
  value: ReactNode;
  tone?: KpiTone;
  variant?: KpiVariant;
  /** Texto de ajuda (ⓘ) ao lado do rótulo. */
  info?: string;
  /** Linha de contexto abaixo do valor. */
  context?: ReactNode;
  /** Conteúdo extra antes do contexto (ex.: "+ R$ X previsto"). */
  extra?: ReactNode;
  icon?: ReactNode;
  /** Quando presente, o card vira botão (quick-filter). */
  onClick?: () => void;
  active?: boolean;
  className?: string;
}

export function KpiTile({
  label,
  value,
  tone = 'neutral',
  variant = 'plain',
  info,
  context,
  extra,
  icon,
  onClick,
  active = false,
  className = '',
}: KpiTileProps) {
  const isHero = variant === 'hero';
  const base =
    variant === 'tinted'
      ? `rounded-2xl border p-3 shadow-lifeone-card ${TINTED[tone]}`
      : `rounded-2xl border border-lifeone-hairline bg-lifeone-card p-3 shadow-lifeone-card ${isHero ? 'md:p-4' : ''}`;
  const interactive = onClick
    ? `cursor-pointer text-left transition ${active ? 'ring-2 ring-lifeone-blue' : ''}`
    : '';
  const labelColor = variant === 'tinted' ? '' : 'text-lifeone-ink-3';
  const valueColor = variant === 'tinted' ? '' : VALUE_COLOR[tone];
  const valueSize = isHero
    ? 'text-[26px] md:text-[30px]'
    : 'text-lg md:text-[22px]';

  const inner = (
    <>
      <p className={`flex items-center gap-1 text-[11px] font-semibold leading-4 ${labelColor}`}>
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="min-w-0 truncate">{label}</span>
        {info && <InfoHint text={info} className={variant === 'tinted' ? undefined : 'text-lifeone-ink-3'} />}
      </p>
      <p className={`mt-2 font-geist tabular-nums font-bold tracking-tight leading-tight ${valueSize} ${valueColor}`}>
        {value}
      </p>
      {extra}
      {context && (
        <p className={`mt-2 text-[11px] leading-4 ${variant === 'tinted' ? 'opacity-80' : 'text-lifeone-ink-3'}`}>
          {context}
        </p>
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={active} className={`${base} ${interactive} ${className}`}>
        {inner}
      </button>
    );
  }
  return <article className={`${base} ${className}`}>{inner}</article>;
}
