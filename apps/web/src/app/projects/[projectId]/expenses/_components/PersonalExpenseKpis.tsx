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

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: 'violet' | 'amber' | 'emerald' | 'sky' | 'rose';
}) {
  const tones: Record<string, string> = {
    violet: 'border-violet-200 bg-violet-50 text-violet-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    sky: 'border-sky-200 bg-sky-50 text-sky-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{formatCurrency(value / 100)}</p>
      <p className="mt-0.5 text-[11px] opacity-70">{hint}</p>
    </div>
  );
}

/**
 * KPIs (3 cards) da tela de despesas do PESSOAL, dependentes do eixo ativo.
 * - Gastos Controle (competência): No cartão · Na conta · A confirmar.
 * - Conta Real (caixa): Faturas vencendo · Débitos · Ainda falta sair.
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
  if (eixo === 'caixa') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi
          label="Faturas vencendo"
          value={contaReal.faturasVencendo}
          hint="cartões que vencem no mês"
          tone="rose"
        />
        <Kpi
          label="Débitos / à vista"
          value={contaReal.debitos}
          hint="saída direta da conta"
          tone="sky"
        />
        <Kpi
          label="Ainda falta sair"
          value={contaReal.faltaSair}
          hint="total do mês − o que já saiu"
          tone="amber"
        />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Kpi
        label="Gastei no cartão"
        value={gastosControle.noCartao}
        hint="compras no cartão neste mês"
        tone="violet"
      />
      <Kpi
        label="Gastei à vista"
        value={gastosControle.naConta}
        hint="débito direto da conta"
        tone="sky"
      />
      <Kpi
        label="Gasto a vir (planejado)"
        value={gastosControle.aConfirmar}
        hint="planejado, ainda não pago"
        tone="amber"
      />
    </div>
  );
}
