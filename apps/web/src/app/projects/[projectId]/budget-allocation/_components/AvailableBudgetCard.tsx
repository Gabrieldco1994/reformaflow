'use client';

import { formatCurrency } from '@/lib/utils';

interface Props {
  available: number;
  totalAllocated: number;
  allocations: Array<{ projectName: string; projectType: string; total: number }>;
}

export default function AvailableBudgetCard({ available, totalAllocated, allocations }: Props) {
  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 lg:p-6">
      <h2 className="font-editorial italic text-lg text-darc-velvet mb-4">Budget Disponível</h2>
      
      <div className="text-center mb-6">
        <p className="text-sm text-darc-velvet/60 mb-1">Disponível para Alocar</p>
        <p className="text-4xl font-bold text-darc-velvet tabular-nums">
          {formatCurrency(available / 100)}
        </p>
      </div>

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
