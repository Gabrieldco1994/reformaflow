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

/** Texto de um `ReactNode` quando ele é literalmente texto — senão, vazio. */
function plainText(node: ReactNode): string {
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
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
  /** Versão mais compacta no mobile para listas densas de KPI. */
  mobileCompact?: boolean;
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
  mobileCompact = false,
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
  const labelSize = isSupport
    ? 'text-[12px]'
    : isHero
      ? 'text-[13px]'
      : mobileCompact
        ? 'text-[10px] md:text-[11px]'
        : 'text-[11px]';
  const valueSize = isSupport
    ? 'text-[20px]'
    : isHero
      ? 'text-[26px] md:text-[30px]'
      : mobileCompact
        ? 'text-base md:text-[22px]'
        : 'text-lg md:text-[22px]';

  const base =
    isState
      ? `rounded-2xl border ${mobileCompact ? 'p-2 md:p-3' : 'p-3'} shadow-lifeone-card ${getTintedClasses(tone)}`
      : `rounded-2xl border border-lifeone-hairline bg-lifeone-card ${mobileCompact ? 'p-2 md:p-3' : 'p-3'} shadow-lifeone-card ${isHero ? 'md:p-4' : ''}`;

  const interactive = onClick
    ? // <button> centraliza verticalmente o próprio conteúdo quando a altura vem
      // esticada pelo grid — dois KPIs lado a lado saíam com valores em linhas de
      // base diferentes. flex-col volta a ancorar no topo.
      `flex flex-col cursor-pointer text-left transition ${active ? 'ring-2 ring-lifeone-blue' : ''}`
    : '';

  const labelColor = isState ? '' : 'text-lifeone-ink-3';
  const valueColor = isState ? '' : getValueColorClass(tone);

  /**
   * #490 — o KPI clicável não pode EMBRULHAR o gatilho de ajuda num `<button>`:
   * `InfoHint` também é `<button>`, e `<button>` dentro de `<button>` é HTML
   * inválido (o React acusa hydration error em toda carga de `/conta` e `/dre`,
   * e o parser pode fechar o botão externo antes do interno).
   *
   * Em vez de rebaixar a ajuda a um `<span role="button">` (dois controles
   * focáveis aninhados continuam sendo lixo para leitor de tela), o card vira
   * `<article>` com um botão em sobreposição (`absolute inset-0`): a área
   * clicável do quick-filter continua sendo o card inteiro, mas os dois
   * controles ficam IRMÃOS. A ajuda sobe uma camada (`z-20`) para continuar
   * clicável por cima da sobreposição.
   */
  const infoClassName = [
    isState ? '' : 'text-lifeone-ink-3',
    onClick ? 'z-20' : '',
  ]
    .filter(Boolean)
    .join(' ');

  /**
   * O nome do gatilho de ajuda é DERIVADO do rótulo do KPI.
   *
   * `InfoHint` assumia `aria-label="Ajuda"` quando o chamador não passava nada,
   * e este era o chamador que não passava. Resultado medido em runtime: `/conta`
   * servia CINCO botões chamados "Ajuda", cada um abrindo um texto diferente —
   * na lista de controles do leitor de tela, cinco entradas indistinguíveis
   * para cinco ações distintas. A correção mora aqui, e não em cada tela,
   * porque `KpiTile` é o dono do padrão: são 12 arquivos consumindo este
   * componente, e /conta era só onde o QA olhou.
   *
   * `plainText` devolve vazio quando o rótulo é um `ReactNode` composto; nesse
   * caso o `undefined` deixa `InfoHint` derivar o nome do conteúdo, em vez de
   * produzir "Ajuda sobre " com o nome cortado.
   */
  const infoAriaLabel = plainText(label) ? `Ajuda sobre ${plainText(label)}` : undefined;

  const inner = (
    <>
      <div className="relative">
        <p className={`flex items-center gap-1 pr-8 font-semibold leading-4 ${labelSize} ${labelColor}`}>
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="min-w-0 truncate">{label}</span>
        </p>
        {info && (
          <InfoHint
            text={info}
            className={`absolute right-0 top-0 ${infoClassName}`}
            ariaLabel={infoAriaLabel}
          />
        )}
      </div>
      <p
        data-kpi-value={plainText(label) || undefined}
        // `whitespace-nowrap`: valor monetário nunca quebra (contrato do
        // AGENTS.md). Sem isso o sinal `-` fica órfão numa linha só dele e um
        // saldo negativo é lido como positivo (#588). Quem acomoda a largura é
        // a grade da faixa (container query, ver .kpi-band em globals.css) —
        // aqui nunca `truncate`/`overflow:hidden`, que esconderia dígito.
        className={`${mobileCompact ? 'mt-1 md:mt-2' : 'mt-2'} whitespace-nowrap font-geist tabular-nums font-bold tracking-tight leading-tight ${valueSize} ${valueColor}`}
      >
        {value}
      </p>
      {delta && (
        <div className="mt-2 text-sm text-lifeone-ink-2">
          {delta.value > 0 && `+`}{delta.value}{delta.type === 'percent' && `%`}
        </div>
      )}
      {extra}
      {context && (
        <p
          className={`${mobileCompact ? 'mt-1 text-[10px] leading-3.5 md:mt-2 md:text-[11px] md:leading-4' : 'mt-2 text-[11px] leading-4'} ${isState ? 'opacity-80' : 'text-lifeone-ink-3'}`}
        >
          {context}
        </p>
      )}
    </>
  );

  if (onClick) {
    // O nome acessível do quick-filter vem do rótulo + valor porque o botão em
    // sobreposição não tem texto próprio (o conteúdo do card é irmão dele).
    const overlayLabel = [plainText(label), plainText(value)].filter(Boolean).join(', ');
    return (
      <article className={`relative ${base} ${interactive} ${className}`}>
        {inner}
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          aria-label={overlayLabel || undefined}
          className="absolute inset-0 z-10 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-lifeone-blue"
        />
      </article>
    );
  }
  return <article className={`${base} ${interactive} ${className}`}>{inner}</article>;
}
