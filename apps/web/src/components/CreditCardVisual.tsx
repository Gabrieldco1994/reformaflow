'use client';

import type { ReactNode } from 'react';
import { formatCurrency } from '@/lib/utils';

/** Gradientes sóbrios de cartão premium; escolhidos deterministicamente pelo last4. */
const CARD_GRADIENTS = [
  'linear-gradient(135deg,#1E7BFF 0%,#0A5AD0 100%)', // azul da marca
  'linear-gradient(135deg,#2B3440 0%,#12161C 100%)', // grafite
  'linear-gradient(135deg,#1E3A5F 0%,#0A1F3C 100%)', // meia-noite
  'linear-gradient(135deg,#5B2A63 0%,#2D1533 100%)', // ameixa
  'linear-gradient(135deg,#0F5F5C 0%,#08302E 100%)', // teal
  'linear-gradient(135deg,#7A5B3A 0%,#3D2C1C 100%)', // bronze
];

/** Gradiente estável por cartão (mesmo last4 → mesma cor em qualquer tela). */
export function pickCardGradient(last4: string): string {
  let h = 0;
  for (const ch of last4) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CARD_GRADIENTS[h % CARD_GRADIENTS.length]!;
}

function Chip() {
  return (
    <svg width="34" height="26" viewBox="0 0 34 26" fill="none" aria-hidden>
      <rect x="0.5" y="0.5" width="33" height="25" rx="5" fill="url(#chipG)" stroke="#00000022" />
      <path d="M12 0.5V25.5M22 0.5V25.5M0.5 8.5H12M22 8.5H33.5M0.5 17.5H12M22 17.5H33.5" stroke="#00000033" strokeWidth="0.8" />
      <rect x="12" y="8.5" width="10" height="9" rx="2" fill="#00000015" stroke="#00000030" strokeWidth="0.8" />
      <defs>
        <linearGradient id="chipG" x1="0" y1="0" x2="34" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F2D89B" />
          <stop offset="1" stopColor="#C39B54" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function Contactless() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="text-white/70">
      <path d="M8.5 8.5a5 5 0 0 1 0 7M11.5 5.5a9 9 0 0 1 0 13M14.5 2.5a13 13 0 0 1 0 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Chip EMV compacto para mini-cartões (strips/listas densas). */
export function MiniCardChip({ className }: { className?: string } = {}) {
  return (
    <svg width="22" height="16" viewBox="0 0 34 26" fill="none" aria-hidden className={className}>
      <rect x="0.5" y="0.5" width="33" height="25" rx="5" fill="url(#miniChipG)" stroke="#00000022" />
      <path d="M12 0.5V25.5M22 0.5V25.5M0.5 8.5H12M22 8.5H33.5M0.5 17.5H12M22 17.5H33.5" stroke="#00000033" strokeWidth="0.8" />
      <rect x="12" y="8.5" width="10" height="9" rx="2" fill="#00000015" stroke="#00000030" strokeWidth="0.8" />
      <defs>
        <linearGradient id="miniChipG" x1="0" y1="0" x2="34" y2="26" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F2D89B" />
          <stop offset="1" stopColor="#C39B54" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export interface CreditCardVisualProps {
  last4: string;
  nickname?: string | null;
  /** Bandeira (ex.: VISA, MASTERCARD) — exibida ao lado do apelido quando presente. */
  brand?: string | null;
  active?: boolean;
  onClick?: () => void;
  /** Selo/curinga no canto superior direito (ex.: status da fatura). */
  topRight?: ReactNode;
  /** Bloco de destaque (ex.: fatura atual + vencimento, ou instituição). */
  footer?: ReactNode;
  /** Barra de limite translúcida (centavos). Omitida quando algum valor é nulo. */
  limit?: { pct: number | null; used: number | null; total: number | null };
  /** Ação principal branca no rodapé (ex.: "Pagar fatura"). */
  action?: ReactNode;
  className?: string;
}

/**
 * Casca visual de um cartão de crédito realista: gradiente estável por `last4`,
 * chip EMV, ondas de aproximação, número mascarado e apelido. Os blocos de
 * conteúdo (selo, destaque, limite, ação) são slots — cada tela injeta seus
 * próprios dados. Fonte única do visual usado na Conta e na tela de Cartões.
 */
export function CreditCardVisual({
  last4,
  nickname,
  brand,
  active = false,
  onClick,
  topRight,
  footer,
  limit,
  action,
  className,
}: CreditCardVisualProps) {
  const clickable = typeof onClick === 'function';
  const hasLimit = !!limit && limit.pct != null && limit.used != null && limit.total != null;

  return (
    <article
      onClick={onClick}
      className={`group relative flex min-h-[176px] flex-col justify-between overflow-hidden rounded-2xl p-4 text-white shadow-lifeone-card transition-all ${
        clickable ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-lifeone-hover' : ''
      } ${active ? 'ring-2 ring-lifeone-blue ring-offset-2 ring-offset-lifeone-surface' : ''} ${className ?? ''}`}
      style={{ backgroundImage: pickCardGradient(last4) }}
    >
      {/* brilho sutil */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 80% at 85% 10%, rgba(255,255,255,.16), transparent 55%)' }}
      />

      {/* topo: chip + contactless + slot */}
      <div className="relative flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Chip />
          <Contactless />
        </div>
        {topRight && <div className="shrink-0">{topRight}</div>}
      </div>

      {/* número mascarado + apelido/bandeira */}
      <div className="relative">
        <p className="font-geist text-[15px] font-medium tabular-nums tracking-[0.18em] text-white/95">
          ••••&nbsp;&nbsp;••••&nbsp;&nbsp;••••&nbsp;&nbsp;{last4}
        </p>
        {brand ? (
          <p className="mt-1 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-white/70">
            <span className="truncate">{nickname}</span>
            <span className="shrink-0 text-white/60">{brand}</span>
          </p>
        ) : (
          nickname != null && (
            <p className="mt-1 truncate text-[11px] font-medium uppercase tracking-[0.12em] text-white/70">
              {nickname}
            </p>
          )
        )}
      </div>

      {footer && <div className="relative">{footer}</div>}

      {hasLimit && (
        <div className="relative">
          <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-white/70">
            <span>{limit!.pct}% usado</span>
            <span className="font-medium">
              {formatCurrency(limit!.used! / 100)} de {formatCurrency(limit!.total! / 100)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-white"
              style={{ width: `${Math.min(Math.max(limit!.pct!, 0), 100)}%` }}
            />
          </div>
        </div>
      )}

      {action && <div className="relative">{action}</div>}
    </article>
  );
}
