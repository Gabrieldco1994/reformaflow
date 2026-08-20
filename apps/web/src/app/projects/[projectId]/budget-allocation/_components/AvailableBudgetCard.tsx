'use client';

import { formatCurrency } from '@/lib/utils';
import { REDACTED_PROJECT_LABEL } from './redacted-project';

interface Props {
  available: number;
  totalAllocated: number;
  totalExpenses?: number;
  totalReceipts?: number;
  // `projectName`/`projectType` chegam `null` quando a API redige uma relação
  // legada de outro tenant (#449 B2). O valor (`total`) nunca é redigido.
  allocations: Array<{ projectName: string | null; projectType: string | null; total: number }>;
}

export default function AvailableBudgetCard({ available, totalAllocated, totalExpenses = 0, totalReceipts = 0, allocations }: Props) {
  const hasNoBudget = available === 0;
  // available=0 pode ter duas causas distintas: (a) realmente não há recebimentos
  // EM CAIXA, ou (b) os recebimentos já estão comprometidos por despesas + alocações.
  const hasReceipts = totalReceipts > 0;

  // #504 — a tela está CONGELADA (#449/#500: POST/PATCH/DELETE respondem 404).
  // Por isso o card perdeu o realce laranja de alerta: alerta pede ação, e aqui
  // saldo zero não é problema a resolver, é fato histórico. O texto também
  // deixou de prometer alocação — ver `AvailableBudgetCard.test.tsx`.
  return (
    <div className="rounded-2xl shadow-darc-soft border border-darc-linen bg-white p-4 lg:p-6">
      <h2 className="font-editorial italic text-lg text-darc-velvet mb-1">Resumo do Budget</h2>
      <p className="text-sm text-darc-velvet/60 mb-4">
        A alocação de budget foi <strong>encerrada</strong>. Os números abaixo são o
        resultado histórico do que já foi registrado.
      </p>

      <div className="text-center mb-6">
        <p className="text-sm text-darc-velvet/60 mb-1">Saldo não alocado</p>
        <p className="text-4xl font-bold tabular-nums text-darc-velvet">
          {formatCurrency(available / 100)}
        </p>
        <p className="mt-3 text-sm text-darc-velvet/60">
          {hasNoBudget ? (
            hasReceipts ? (
              <>
                Os recebimentos em caixa deste projeto já estão integralmente comprometidos
                com as <strong>despesas</strong> e <strong>alocações</strong> registradas.
              </>
            ) : (
              <>
                Não há recebimentos com status <strong>EM CAIXA</strong> registrados neste projeto.
              </>
            )
          ) : (
            <>Recebimentos em caixa menos despesas do projeto e alocações registradas.</>
          )}
        </p>
      </div>

      {totalReceipts > 0 && (
        <div className="border-t border-darc-linen pt-3 mb-3">
          <div className="flex justify-between text-sm">
            <span className="text-darc-velvet/60">Recebimentos em caixa</span>
            <span className="font-medium text-darc-velvet tabular-nums whitespace-nowrap">+ {formatCurrency(totalReceipts / 100)}</span>
          </div>
        </div>
      )}

      {totalExpenses > 0 && (
        <div className="border-t border-darc-linen pt-3 mb-3">
          <div className="flex justify-between text-sm">
            <span className="text-darc-velvet/60">Despesas do projeto (pagas + planejadas)</span>
            <span className="font-medium text-darc-velvet tabular-nums whitespace-nowrap">− {formatCurrency(totalExpenses / 100)}</span>
          </div>
        </div>
      )}

      {totalAllocated > 0 && (
        <div className="border-t border-darc-linen pt-4">
          <p className="text-sm text-darc-velvet/60 mb-3">Total Alocado: {formatCurrency(totalAllocated / 100)}</p>
          <div className="space-y-2">
            {allocations.map((a, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-darc-velvet">{a.projectName ?? REDACTED_PROJECT_LABEL}</span>
                <span className="font-medium text-darc-velvet tabular-nums">
                  {formatCurrency(a.total / 100)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
