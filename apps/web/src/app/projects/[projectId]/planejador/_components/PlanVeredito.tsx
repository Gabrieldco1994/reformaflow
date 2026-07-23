'use client';

import { applyPurchasePlan, type PurchasePlanBaselineMonth, type PurchasePlanHorizonte, type PurchasePlanItem } from '@reformaflow/domain';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card } from '../../monthly/_cockpit/ui';
import { mesCurto, mesLongo } from '../../monthly/_cockpit/format';
import { moneyGlance } from '@/lib/money';

const monthIdx = (mes: string) => Number.parseInt(mes.slice(5, 7), 10) - 1;

/**
 * Veredito + mini-barras do Planejador — mesmo padrão visual do runway do
 * cockpit (W5: caixa verde/vermelho + cards por mês), recalculado 100% no
 * client via `applyPurchasePlan` (troca de horizonte não busca dados de novo).
 */
export function PlanVeredito({
  baseline,
  itens,
  horizonte,
}: {
  baseline: PurchasePlanBaselineMonth[];
  itens: PurchasePlanItem[];
  horizonte: PurchasePlanHorizonte;
}) {
  if (baseline.length < horizonte) {
    return (
      <Card>
        <p className="text-sm text-[var(--ck-muted)]">
          Projeção do PESSOAL ainda não cobre {horizonte} meses — veredito indisponível.
        </p>
      </Card>
    );
  }

  const result = applyPurchasePlan(baseline, itens, horizonte);
  const crossover = result.primeiroMesNegativo;

  return (
    <Card>
      <div
        className={`flex items-start gap-2.5 rounded-2xl border px-3.5 py-3 ${
          crossover
            ? 'border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10'
            : 'border-[var(--ck-pos)]/40 bg-[var(--ck-pos)]/10'
        }`}
      >
        {crossover ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ck-neg)]" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ck-pos)]" />
        )}
        <div className="min-w-0 leading-snug">
          <p
            data-testid="plan-veredito-texto"
            className={`text-[15px] font-bold ${crossover ? 'text-[var(--ck-neg)]' : 'text-[var(--ck-pos)]'}`}
          >
            {crossover
              ? `Com esse plano, a projeção fica negativa em ${mesLongo(monthIdx(crossover))}.`
              : `A projeção segue positiva até ${mesLongo(monthIdx(result.meses[result.meses.length - 1]!.mes))}.`}
          </p>
          <p className="mt-0.5 text-[13px] text-[var(--ck-muted)]">
            Menor saldo: {moneyGlance(result.menorSaldoCents)}.
          </p>
        </div>
      </div>

      <div className="mt-3 flex snap-x gap-2 overflow-x-auto pb-1">
        {result.meses.map((row) => {
          const neg = row.saldoComPlanoCents < 0;
          return (
            <div
              key={row.mes}
              data-testid={`plan-month-${row.mes}`}
              className={`min-w-[84px] snap-start rounded-lg border px-2 py-1.5 text-center ${
                neg ? 'border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10' : 'border-[var(--ck-border)] bg-[var(--ck-surface-2)]'
              }`}
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ck-muted)]">
                {mesCurto(monthIdx(row.mes))}
              </p>
              <p className={`mt-0.5 font-geist text-[15px] font-bold tabular-nums ${neg ? 'text-[var(--ck-neg)]' : 'text-[var(--ck-text)]'}`}>
                {moneyGlance(row.saldoComPlanoCents)}
              </p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
