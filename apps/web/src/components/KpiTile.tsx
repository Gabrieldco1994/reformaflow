'use client';

import type { ReactNode } from 'react';
import { InfoHint } from '@/components/InfoHint';
import type { ColorTone } from '@/lib/colors';
import { COLOR_TONE_PALETTE } from '@/lib/colors';

/**
 * Componente único de KPI do app — Fase A Design System.
 *
 * Substitui os três "dialetos" que existiam (cockpit card claro, Visão Conta
 * card tintado, Despesas hero escuro) com uma gramática única:
 *
 * - `layer`: apresentação por contexto (`glance` = relance compacto,
 *   `detail` = detalhe completo com centavos)
 * - `tone`: cor SEMÂNTICA (positive|negative|warning|neutral|accent)
 * - `variant`: layout (`support` = label+valor compacto, `state` = card tintado,
 *   `hero` = valor grande com narrativa)
 *
 * Preserva recursos: rótulo + InfoHint, valor, contexto, ícone, clicável
 * (quick-filter), e delta legível.
 */

export type KpiTone = ColorTone | 'alert'; // 'alert' = alias de 'warning' para backwards-compat
export type KpiVariant = 'plain' | 'tinted' | 'hero' | 'support' | 'state';
export type KpiLayer = 'glance' | 'detail';

function getTintedClasses(tone: KpiTone): string {
  const normalized = tone === 'alert' ? 'warning' : (tone as ColorTone);
  const palette = COLOR_TONE_PALETTE[normalized];
  return `text-[${palette.text}] bg-[${palette.bgLight}] border-[${palette.border}]`;
}

function getValueColorClass(tone: KpiTone): string {
  const normalized = tone === 'alert' ? 'warning' : (tone as ColorTone);
  const palette = COLOR_TONE_PALETTE[normalized];
  return `text-[${palette.text}]`;
}

export interface KpiTileProps {
  label: ReactNode;
  value: ReactNode;
  tone?: KpiTone;
  variant?: KpiVariant;
  layer?: KpiLayer;
  /** Texto de ajuda (ⓘ) ao lado do rótulo. */
  info?: string;
  /** Linha de contexto abaixo do valor. */
  context?: ReactNode;
  /** Conteúdo extra antes do contexto. */
  extra?: ReactNode;
  icon?: ReactNode;
  /** Quando presente, o card vira botão (quick-filter). */
  onClick?: () => void;
  active?: boolean;
  className?: string;
  /** Delta de mudança. */
  delta?: { value: number; type?: 'cents' | 'percent'; isGood?: boolean };
}

export function KpiTile({
  label,
  value,
  tone = 'neutral',
  variant = 'plain',
  layer = 'glance',
  info,
  context,
  extra,
  icon,
  onClick,
  active = false,
  className = '',
  delta,
}: KpiTileProps) {
  // Resolver variante
  let resolvedVariant = variant;
  if (variant === 'plain' && tone !== 'neutral' && tone !== 'accent') {
    resolvedVariant = 'tinted';
  }

  const isHero = resolvedVariant === 'hero';
  const isSupport = resolvedVariant === 'support';
  const isState = resolvedVariant === 'state' || (resolvedVariant === 'tinted' && !isHero);

  // Dimensionamento por variante
  const labelSize = isSupport ? 'text-[12px]' : isHero ? 'text-[13px]' : 'text-[11px]';
  const valueSize = isSupport
    ? 'text-[20px]'
    : isHero
      ? 'text-[26px] md:text-[30px]'
      : 'text-lg md:text-[22px]';

  const base =
    isState
      ? `rounded-2xl border p-3 shadow-lifeone-card ${getTintedClasses(tone)}`
      : `rounded-2xl border border-lifeone-hairline bg-lifeone-card p-3 shadow-lifeone-card ${isHero ? 'md:p-4' : ''}`;

  const interactive = onClick
    ? `cursor-pointer text-left transition ${active ? 'ring-2 ring-lifeone-blue' : ''}`
    : '';

  const labelColor = isState ? '' : 'text-lifeone-ink-3';
  const valueColor = isState ? '' : getValueColorClass(tone);

  const inner = (
    <>
      <p className={`flex items-center gap-1 font-semibold leading-4 ${labelSize} ${labelColor}`}>
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="min-w-0 truncate">{label}</span>
        {info && <InfoHint text={info} className={isState ? undefined : 'text-lifeone-ink-3'} />}
      </p>
      <p className={`mt-2 font-geist tabular-nums font-bold tracking-tight leading-tight ${valueSize} ${valueColor}`}>
        {value}
      </p>
      {delta && (
        <div className="mt-2 text-sm text-lifeone-ink-2">
          {delta.value > 0 && `+`}{delta.value}{delta.type === 'percent' && `%`}
        </div>
      )}
      {extra}
      {context && (
        <p className={`mt-2 text-[11px] leading-4 ${isState ? 'opacity-80' : 'text-lifeone-ink-3'}`}>
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
  return <article className={`${base} ${interactive} ${className}`}>{inner}</article>;
}
