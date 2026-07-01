'use client';

import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { AccountViewCardSummary } from '../_types';

/** Gradientes sóbrios de cartão premium; escolhidos deterministicamente pelo last4. */
const CARD_GRADIENTS = [
  'linear-gradient(135deg,#1E7BFF 0%,#0A5AD0 100%)', // azul da marca
  'linear-gradient(135deg,#2B3440 0%,#12161C 100%)', // grafite
  'linear-gradient(135deg,#1E3A5F 0%,#0A1F3C 100%)', // meia-noite
  'linear-gradient(135deg,#5B2A63 0%,#2D1533 100%)', // ameixa
  'linear-gradient(135deg,#0F5F5C 0%,#08302E 100%)', // teal
  'linear-gradient(135deg,#7A5B3A 0%,#3D2C1C 100%)', // bronze
];

function pickGradient(last4: string): string {
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

export function CreditCardTile({
  card,
  active,
  onSelect,
  onPayInvoice,
}: {
  card: AccountViewCardSummary;
  active: boolean;
  onSelect: (last4: string | null) => void;
  onPayInvoice: (cardLast4: string) => void;
}) {
  const paga = card.status === 'paga';
  const hasLimit = card.limiteUsadoPct != null && card.limiteUsado != null && card.limiteTotal != null;

  return (
    <article
      onClick={() => onSelect(active ? null : card.last4)}
      className={`group relative flex min-h-[176px] cursor-pointer flex-col justify-between overflow-hidden rounded-2xl p-4 text-white shadow-lifeone-card transition-all hover:-translate-y-0.5 hover:shadow-lifeone-hover ${
        active ? 'ring-2 ring-lifeone-blue ring-offset-2 ring-offset-lifeone-surface' : ''
      }`}
      style={{ backgroundImage: pickGradient(card.last4) }}
    >
      {/* brilho sutil */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 80% at 85% 10%, rgba(255,255,255,.16), transparent 55%)' }}
      />

      {/* topo: chip + contactless + status */}
      <div className="relative flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Chip />
          <Contactless />
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${
            paga ? 'bg-white/90 text-[#1E924A]' : 'bg-white/15 text-white'
          }`}
        >
          {paga ? '✓ Paga' : 'A pagar'}
        </span>
      </div>

      {/* número mascarado */}
      <div className="relative">
        <p className="font-geist text-[15px] font-medium tabular-nums tracking-[0.18em] text-white/95">
          ••••&nbsp;&nbsp;••••&nbsp;&nbsp;••••&nbsp;&nbsp;{card.last4}
        </p>
        <p className="mt-1 truncate text-[11px] font-medium uppercase tracking-[0.12em] text-white/70">
          {card.nickname}
        </p>
      </div>

      {/* rodapé: fatura + vencimento */}
      <div className="relative flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-white/60">Fatura atual</p>
          <p className="font-geist text-[19px] font-bold tabular-nums leading-tight">
            {formatCurrency(card.faturaAtual / 100)}
          </p>
        </div>
        <p className="shrink-0 text-[11px] text-white/70">vence {formatDateBR(card.vencimento)}</p>
      </div>

      {hasLimit && (
        <div className="relative">
          <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-white/70">
            <span>{card.limiteUsadoPct}% usado</span>
            <span className="font-medium">
              {formatCurrency(card.limiteUsado! / 100)} de {formatCurrency(card.limiteTotal! / 100)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-white"
              style={{ width: `${Math.min(Math.max(card.limiteUsadoPct!, 0), 100)}%` }}
            />
          </div>
        </div>
      )}

      {!paga && card.faturaAtual > 0 && (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            onPayInvoice(card.last4);
          }}
          className="relative mt-1 inline-flex h-8 w-full items-center justify-center gap-1 rounded-lg bg-white text-[12px] font-semibold text-lifeone-ink transition hover:bg-white/90"
        >
          Pagar fatura
        </button>
      )}
    </article>
  );
}
