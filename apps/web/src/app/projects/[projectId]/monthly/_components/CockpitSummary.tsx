'use client';

import { Wallet, TrendingUp, TrendingDown, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

interface Props {
  /** Saldo líquido considerando apenas valores já pagos/recebidos (caixa real). */
  saldoRealizado: number;
  /** Saldo líquido após tudo que está planejado/previsto acontecer. */
  saldoProjetado: number;
  /** Total efetivamente recebido (all-time, todos os projetos). */
  totalRecebido: number;
  /** Total efetivamente gasto (all-time, todos os projetos). */
  totalGasto: number;
}

export default function CockpitSummary({
  saldoRealizado,
  saldoProjetado,
  totalRecebido,
  totalGasto,
}: Props) {
  const realNeg = saldoRealizado < 0;
  const projNeg = saldoProjetado < 0;

  return (
    <div
      className={`rounded-2xl shadow-darc-soft border p-5 md:p-6 ${
        realNeg
          ? 'bg-gradient-to-br from-darc-red-pastel/25 to-rose-50 border-darc-red-pastel/50'
          : 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200'
      }`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-darc-velvet/70 flex items-center gap-1.5">
            <Wallet className="w-3.5 h-3.5" />
            Saldo líquido (caixa real)
          </p>
          <p
            className={`font-bold tabular-nums text-3xl md:text-4xl mt-1 ${
              realNeg ? 'text-darc-red' : 'text-emerald-700'
            }`}
          >
            {formatCurrency(saldoRealizado / 100)}
          </p>
          <p className="text-[11px] text-darc-velvet/60 mt-1">
            Tudo que entrou menos tudo que saiu, somando todos os projetos.
          </p>
        </div>

        <div
          className={`rounded-xl px-4 py-3 text-right ${
            projNeg ? 'bg-darc-red-pastel/20' : 'bg-white/60'
          }`}
        >
          <p className="text-[10px] uppercase tracking-wider text-darc-velvet/70 flex items-center justify-end gap-1">
            {projNeg ? <TrendingDown className="w-3.5 h-3.5 text-darc-red" /> : <TrendingUp className="w-3.5 h-3.5 text-darc-velvet/70" />}
            Projetado (após planejados)
          </p>
          <p
            className={`font-bold tabular-nums text-xl mt-1 ${
              projNeg ? 'text-darc-red' : 'text-darc-velvet'
            }`}
          >
            {formatCurrency(saldoProjetado / 100)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <div className="rounded-xl bg-white/70 border border-white/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-darc-velvet/60 flex items-center gap-1">
            <ArrowDownCircle className="w-3.5 h-3.5 text-emerald-600" />
            Recebido (total)
          </p>
          <p className="font-semibold tabular-nums text-emerald-700 mt-0.5">
            {formatCurrency(totalRecebido / 100)}
          </p>
        </div>
        <div className="rounded-xl bg-white/70 border border-white/80 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-darc-velvet/60 flex items-center gap-1">
            <ArrowUpCircle className="w-3.5 h-3.5 text-darc-red" />
            Gasto (total)
          </p>
          <p className="font-semibold tabular-nums text-darc-red mt-0.5">
            {formatCurrency(totalGasto / 100)}
          </p>
        </div>
      </div>
    </div>
  );
}
