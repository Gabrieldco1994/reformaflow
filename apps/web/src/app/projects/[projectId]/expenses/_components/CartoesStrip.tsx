'use client';
import { CreditCard } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import type { CartaoFormacao } from '../_hooks/usePersonalCashViews';
import type { FaturaCartao } from '../_lib/conta-real';

function diaMM(dia: number | null, mes: string): string {
  if (dia == null) return '—';
  const mm = mes.split('-')[1] ?? '';
  return mm ? `${String(dia).padStart(2, '0')}/${mm}` : String(dia).padStart(2, '0');
}

/**
 * Strip de cartões da tela de despesas do PESSOAL. Dois modos:
 * - **competencia**: "fatura em formação" — quanto já foi lançado no ciclo +
 *   dias de fechamento/vencimento.
 * - **caixa**: "faturas que vencem no mês" — valor da fatura + vence DD/MM +
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
          <div
            key={c.last4}
            className="flex items-center gap-2.5 rounded-xl border border-violet-200 bg-violet-50/60 px-3.5 py-2"
          >
            <CreditCard className="h-4 w-4 shrink-0 text-violet-600" />
            <div className="leading-tight">
              <div className="text-sm font-semibold text-gray-800">{c.label}</div>
              <div className="font-mono text-xs text-violet-700">
                {formatCurrency(c.lancado / 100)}
                <span className="ml-1 text-[10px] font-normal text-gray-500">em formação</span>
              </div>
              <div className="text-[10px] text-gray-500">
                {c.closingDay != null ? `fecha dia ${c.closingDay}` : 'fechamento —'}
                {' · '}
                {c.dueDay != null ? `vence dia ${c.dueDay}` : 'vencimento —'}
              </div>
            </div>
          </div>
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
          <div
            key={`${f.mes}__${f.cardLast4}`}
            className="flex items-center gap-2.5 rounded-xl border border-rose-200 bg-rose-50/60 px-3.5 py-2"
          >
            <CreditCard className="h-4 w-4 shrink-0 text-rose-600" />
            <div className="leading-tight">
              <div className="text-sm font-semibold text-gray-800">{f.label}</div>
              <div className="font-mono text-xs text-rose-700">{formatCurrency(f.valor / 100)}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                vence {diaMM(f.dueDay, f.mes)}
                <span
                  className={`rounded px-1.5 py-0.5 font-semibold ${
                    paga ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {paga ? 'paga' : 'a pagar'}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
