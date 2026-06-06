'use client';

import { formatCurrency } from '@/lib/utils';

interface Props {
  available: number;
  totalAllocated: number;
  totalExpenses?: number;
  allocations: Array<{ projectName: string; projectType: string; total: number }>;
}

export default function AvailableBudgetCard({ available, totalAllocated, totalExpenses = 0, allocations }: Props) {
  const hasNoBudget = available === 0;

  return (
    <div className={`rounded-2xl shadow-darc-soft border p-4 lg:p-6 ${
      hasNoBudget 
        ? 'bg-orange-50 border-orange-200' 
        : 'bg-white border-darc-linen'
    }`}>
      <h2 className="font-editorial italic text-lg text-darc-velvet mb-4">Budget Disponível</h2>
      
      <div className="text-center mb-6">
        <p className="text-sm text-darc-velvet/60 mb-1">Disponível para Alocar</p>
        <p className={`text-4xl font-bold tabular-nums ${
          hasNoBudget ? 'text-orange-700' : 'text-darc-velvet'
        }`}>
          {formatCurrency(available / 100)}
        </p>
        {hasNoBudget && (
          <p className="mt-3 text-sm text-orange-600">
            💡 Adicione recebimentos com status <strong>EM CAIXA</strong> para poder alocar budget
          </p>
        )}
      </div>

      {totalExpenses > 0 && (
        <div className="border-t border-darc-linen pt-3 mb-3">
          <div className="flex justify-between text-sm">
            <span className="text-darc-velvet/60">Despesas do projeto (pagas + planejadas)</span>
            <span className="font-medium text-darc-velvet tabular-nums">− {formatCurrency(totalExpenses / 100)}</span>
          </div>
        </div>
      )}

      {totalAllocated > 0 && (
        <div className="border-t border-darc-linen pt-4">
          <p className="text-sm text-darc-velvet/60 mb-3">Total Alocado: {formatCurrency(totalAllocated / 100)}</p>
          <div className="space-y-2">
            {allocations.map((a, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-darc-velvet">{a.projectName}</span>
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
