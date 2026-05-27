import { formatCurrency } from '@/lib/utils';

interface InfluenceProjectSummary {
  id: string;
  name: string;
  type: string;
  estimatedMonthly: number;
  totalAccumulated: number;
  isOneTime: boolean;
}

interface ExpenseKpiCardsProps {
  projectType: string | undefined;
  expensesCount: number;
  filteredCount: number;
  filteredPlanejadoCount: number;
  filteredPagoCount: number;
  totalProjeto: number;
  totalGeral: number;
  totalPlanejado: number;
  totalPago: number;
  hasActiveFilters: boolean;
  showInfluencePanel: boolean;
  influenceSummary: InfluenceProjectSummary[];
  influenceTotal: number;
  influenceReformaTotal: number;
}

export function ExpenseKpiCards({
  projectType,
  expensesCount,
  filteredCount,
  filteredPlanejadoCount,
  filteredPagoCount,
  totalProjeto,
  totalGeral,
  totalPlanejado,
  totalPago,
  hasActiveFilters,
  showInfluencePanel,
  influenceSummary,
  influenceTotal,
  influenceReformaTotal,
}: ExpenseKpiCardsProps) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-lg border p-3 bg-orange-50 border-orange-200">
          <p className="text-xs font-medium text-orange-600">
            {projectType === 'REFORMA' ? 'Total da Reforma' : 'Total Despesas'}
          </p>
          <p className="text-lg font-bold text-orange-800 mt-0.5">
            {formatCurrency((projectType === 'REFORMA' ? totalProjeto : totalGeral) / 100)}
          </p>
          <p className="text-[10px] text-orange-500 mt-0.5">
            {projectType === 'REFORMA'
              ? `${expensesCount} itens no projeto`
              : `${filteredCount} itens`}
          </p>
          {projectType === 'REFORMA' && hasActiveFilters && (
            <p className="text-[10px] text-orange-500/80 mt-0.5">
              Filtros exibindo {formatCurrency(totalGeral / 100)} ({filteredCount} itens)
            </p>
          )}
        </div>
        <div className="rounded-lg border p-3 bg-amber-50 border-amber-200">
          <p className="text-xs font-medium text-amber-600">Planejado</p>
          <p className="text-lg font-bold text-amber-800 mt-0.5">{formatCurrency(totalPlanejado / 100)}</p>
          <p className="text-[10px] text-amber-500 mt-0.5">{filteredPlanejadoCount} itens</p>
        </div>
        <div className="rounded-lg border p-3 bg-green-50 border-green-200">
          <p className="text-xs font-medium text-green-600">Pago</p>
          <p className="text-lg font-bold text-green-800 mt-0.5">{formatCurrency(totalPago / 100)}</p>
          <p className="text-[10px] text-green-500 mt-0.5">{filteredPagoCount} itens</p>
        </div>
      </div>

      {showInfluencePanel && (
        <section className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-indigo-700">Influência de Reforma / Casa / Carro no Pessoal</p>
              <p className="text-[11px] text-indigo-600">
                CASA/CARRO consolidam mensalmente contas recorrentes e manutenção. REFORMA mostra o total acumulado das despesas.
              </p>
            </div>
            <div className="text-right space-y-0.5">
              {influenceTotal > 0 && (
                <p className="text-sm font-bold text-indigo-800 tabular-nums">
                  {formatCurrency(influenceTotal / 100)}/mês
                </p>
              )}
              {influenceReformaTotal > 0 && (
                <p className="text-[11px] font-semibold text-indigo-700 tabular-nums">
                  + {formatCurrency(influenceReformaTotal / 100)} reforma (total)
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {influenceSummary.map((p) => (
              <div key={p.id} className="rounded-md border border-indigo-100 bg-white px-3 py-2 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-800">{p.name}</p>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">{p.type}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-indigo-800 tabular-nums">
                    {formatCurrency((p.isOneTime ? p.totalAccumulated : p.estimatedMonthly) / 100)}
                  </p>
                  <p className="text-[10px] text-indigo-500">{p.isOneTime ? 'total' : '/mês'}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
