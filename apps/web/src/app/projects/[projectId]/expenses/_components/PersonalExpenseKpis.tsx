'use client';
import { formatCurrency } from '@/lib/utils';
import type { ExpenseEixo } from './ExpenseEixoToggle';

interface GastosControle {
  noCartao: number;
  naConta: number;
  aConfirmar: number;
}

interface ContaReal {
  faturasVencendo: number;
  debitos: number;
  faltaSair: number;
}

/** Mini-stat (chip) abaixo do hero. */
function Stat({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="rounded-2xl border border-darc-linen bg-white p-3 shadow-darc-soft">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <p className="text-[11px] font-semibold uppercase tracking-wide text-darc-velvet/60">{label}</p>
      </div>
      <p className="mt-1 text-lg font-bold tabular-nums text-darc-velvet">{formatCurrency(value / 100)}</p>
    </div>
  );
}

/**
 * Hero card (escuro) + mini-stats da tela de despesas do PESSOAL.
 * - Gastos Controle: hero = Total (cartão+à vista); stats = cartão · à vista · a vir.
 * - Conta Real: hero = Total (faturas+débitos); stats = faturas · débitos · falta sair.
 * Mantém o laranja como acento (barra/realces) sobre o gradiente darc.
 */
export function PersonalExpenseKpis({
  eixo,
  gastosControle,
  contaReal,
}: {
  eixo: ExpenseEixo;
  gastosControle: GastosControle;
  contaReal: ContaReal;
}) {
  const isCaixa = eixo === 'caixa';
  const total = isCaixa
    ? contaReal.faturasVencendo + contaReal.debitos
    : gastosControle.noCartao + gastosControle.naConta;
  const pendente = isCaixa ? contaReal.faltaSair : gastosControle.aConfirmar;
  const pago = Math.max(0, total - pendente);
  const pctPago = total > 0 ? Math.min(100, Math.round((pago / total) * 100)) : 0;

  return (
    <div className="space-y-3">
      {/* Hero card */}
      <div className="rounded-3xl bg-darc-gradient-dark p-5 text-darc-linen shadow-darc-hero">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-darc-linen/60">
            {isCaixa ? 'Vai sair no mês' : 'Gasto no mês'}
          </p>
          <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-darc-linen/80">
            {pctPago}% {isCaixa ? 'pago' : 'pago'}
          </span>
        </div>
        <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight">{formatCurrency(total / 100)}</p>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/15">
          <div className="h-full rounded-full bg-orange-500 transition-all" style={{ width: `${pctPago}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-darc-linen/70">
          <span>{isCaixa ? 'Já saiu' : 'Pago'} <span className="font-semibold text-darc-linen">{formatCurrency(pago / 100)}</span></span>
          <span>{isCaixa ? 'Falta sair' : 'A vir'} <span className="font-semibold text-orange-300">{formatCurrency(pendente / 100)}</span></span>
        </div>
      </div>

      {/* Mini-stats */}
      <div className="grid grid-cols-3 gap-2">
        {isCaixa ? (
          <>
            <Stat label="Faturas" value={contaReal.faturasVencendo} dot="bg-rose-400" />
            <Stat label="Débitos" value={contaReal.debitos} dot="bg-sky-400" />
            <Stat label="Falta sair" value={contaReal.faltaSair} dot="bg-amber-400" />
          </>
        ) : (
          <>
            <Stat label="No cartão" value={gastosControle.noCartao} dot="bg-violet-400" />
            <Stat label="À vista" value={gastosControle.naConta} dot="bg-sky-400" />
            <Stat label="A vir" value={gastosControle.aConfirmar} dot="bg-amber-400" />
          </>
        )}
      </div>
    </div>
  );
}
