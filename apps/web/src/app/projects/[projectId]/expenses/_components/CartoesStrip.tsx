'use client';
import { formatCurrency } from '@/lib/utils';
import { pickCardGradient, MiniCardChip } from '@/components/CreditCardVisual';
import type { CartaoFormacao } from '../_hooks/usePersonalCashViews';
import type { FaturaCartao } from '../_lib/conta-real';

function diaMM(dia: number | null, mes: string): string {
  if (dia == null) return '\u2014';
  const mm = mes.split('-')[1] ?? '';
  return mm ? `${String(dia).padStart(2, '0')}/${mm}` : String(dia).padStart(2, '0');
}

/** Mini-cartao com o mesmo estilo dos cartoes grandes (gradiente por last4 + chip). */
function MiniCard({
  last4,
  label,
  value,
  hint,
  badge,
}: {
  last4: string;
  label: string;
  value: string;
  hint: string;
  badge?: { text: string; paid: boolean };
}) {
  return (
    <div
      className="relative flex min-w-[168px] flex-col justify-between gap-2 overflow-hidden rounded-xl p-3 text-white shadow-lifeone-card"
      style={{ backgroundImage: pickCardGradient(last4) }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 80% at 85% 10%, rgba(255,255,255,.16), transparent 55%)' }}
      />
      <div className="relative flex items-center justify-between gap-2">
        <MiniCardChip />
        {badge && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold backdrop-blur ${
              badge.paid ? 'bg-white/90 text-[#1E924A]' : 'bg-white/15 text-white'
            }`}
          >
            {badge.text}
          </span>
        )}
      </div>
      <div className="relative leading-tight">
        <div className="truncate text-[11px] font-medium uppercase tracking-[0.1em] text-white/70">
          {label} <span className="text-white/50">••{last4}</span>
        </div>
        <div className="font-geist text-[15px] font-bold tabular-nums">{value}</div>
        <div className="mt-0.5 text-[10px] text-white/60">{hint}</div>
      </div>
    </div>
  );
}

/**
 * Strip de cartoes da tela de despesas do PESSOAL, com visual de mini-cartao
 * (mesmo gradiente/chip dos cartoes grandes). Dois modos:
 * - **competencia**: "fatura em formacao" — quanto ja foi lancado no ciclo +
 *   dias de fechamento/vencimento.
 * - **caixa**: "faturas que vencem no mes" — valor da fatura + vence DD/MM +
 *   selo paga/a pagar.
 */
export function CartoesStrip({
  mode,
  cartoes,
  faturas,
}: {
  mode: 'competencia' | 'caixa';
  cartoes?: CartaoFormacao[];
  faturas?: FaturaCartao[];
}) {
  if (mode === 'competencia') {
    const items = cartoes ?? [];
    if (items.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-2">
        {items.map((c) => (
          <MiniCard
            key={c.last4}
            last4={c.last4}
            label={c.label}
            value={formatCurrency(c.lancado / 100)}
            hint={`${c.closingDay != null ? `fecha ${c.closingDay}` : 'fecha \u2014'} \u00b7 ${
              c.dueDay != null ? `vence ${c.dueDay}` : 'vence \u2014'
            } \u00b7 em formacao`}
          />
        ))}
      </div>
    );
  }

  const items = faturas ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((f) => {
        const paga = f.planejado === 0 && f.pago > 0;
        return (
          <MiniCard
            key={`${f.mes}__${f.cardLast4}`}
            last4={f.cardLast4}
            label={f.label}
            value={formatCurrency(f.valor / 100)}
            hint={`vence ${diaMM(f.dueDay, f.mes)}`}
            badge={{ text: paga ? 'paga' : 'a pagar', paid: paga }}
          />
        );
      })}
    </div>
  );
}
