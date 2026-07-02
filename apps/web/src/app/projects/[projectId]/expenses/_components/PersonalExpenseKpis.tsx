'use client';
import { formatCurrency } from '@/lib/utils';
import { moneyShort } from '@/lib/money';
import { InfoHint } from '@/components/InfoHint';
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
function Stat({ label, value, dot, info }: { label: string; value: number; dot: string; info?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-darc-linen bg-white p-3 shadow-darc-soft md:p-4">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot} shrink-0`} />
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-darc-velvet/60 md:text-xs">{label}</p>
        {info && <InfoHint text={info} className="text-darc-velvet/50" />}
      </div>
      <p className="mt-2 text-base font-bold leading-tight tabular-nums text-darc-velvet md:text-2xl">
        <span className="md:hidden">{moneyShort(value)}</span>
        <span className="hidden md:inline">{formatCurrency(value / 100)}</span>
      </p>
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
    : gastosControle.noCartao + gastosControle.naConta + gastosControle.aConfirmar;
  const pendente = isCaixa ? contaReal.faltaSair : gastosControle.aConfirmar;
  const pago = isCaixa ? Math.max(0, total - pendente) : gastosControle.noCartao + gastosControle.naConta;
  const pctPago = total > 0 ? Math.min(100, Math.round((pago / total) * 100)) : 0;

  return (
    <div className="space-y-4">
      {/* Hero card */}
      <div className="rounded-3xl bg-darc-gradient-dark p-6 text-darc-linen shadow-darc-hero">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-darc-linen/60">
              {isCaixa ? 'Vai sair no mês' : 'Gasto no mês'}
              <InfoHint
                text={
                  isCaixa
                    ? 'Quanto vai efetivamente sair da conta neste mês: faturas de cartão que vencem agora + débitos. A compra no cartão entra no mês em que a fatura vence.'
                    : 'Quanto você comprou neste mês (competência), pela data da compra: cartão + à vista + a vir. Independe de quando a fatura vai ser paga.'
                }
                className="text-darc-linen/60"
              />
            </p>
            <p className="mt-2 text-4xl sm:text-5xl font-bold tabular-nums tracking-tight leading-none">
              {formatCurrency(total / 100)}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-darc-linen/60">Pago</p>
            <p className="mt-2 text-3xl font-bold tabular-nums leading-none text-orange-300">{pctPago}%</p>
          </div>
        </div>
        <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-white/15">
          <div className="h-full rounded-full bg-orange-500 transition-all" style={{ width: `${pctPago}%` }} />
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-darc-linen/70">
          <span>{isCaixa ? 'Já saiu' : 'Pago'} <span className="font-semibold text-darc-linen">{formatCurrency(pago / 100)}</span></span>
          <span>{isCaixa ? 'Falta sair' : 'A vir'} <span className="font-semibold text-orange-300">{formatCurrency(pendente / 100)}</span></span>
        </div>
      </div>

      {/* Mini-stats */}
      <div className="grid grid-cols-3 gap-2 md:gap-4">
        {isCaixa ? (
          <>
            <Stat label="Faturas" value={contaReal.faturasVencendo} dot="bg-rose-400" info="Faturas de cartão que vencem neste mês (o valor que o banco vai cobrar)." />
            <Stat label="Débitos" value={contaReal.debitos} dot="bg-sky-400" info="Saídas direto da conta neste mês (débito, PIX, dinheiro) — sem passar por cartão." />
            <Stat label="Falta sair" value={contaReal.faltaSair} dot="bg-amber-400" info="Do total que vai sair, quanto ainda não foi pago (faturas/contas em aberto)." />
          </>
        ) : (
          <>
            <Stat label="No cartão" value={gastosControle.noCartao} dot="bg-violet-400" info="Compras feitas no cartão de crédito neste mês (competência), independente de quando a fatura vence." />
            <Stat label="À vista" value={gastosControle.naConta} dot="bg-sky-400" info="Compras pagas na hora (débito, PIX, dinheiro) neste mês." />
            <Stat label="A vir" value={gastosControle.aConfirmar} dot="bg-amber-400" info="Despesas planejadas ainda não confirmadas/pagas (parcelas e contas previstas)." />
          </>
        )}
      </div>
    </div>
  );
}
