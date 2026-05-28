import { formatCurrency } from '@/lib/utils';

interface InfluenceProjectSummary {
  id: string;
  name: string;
  type: string;
  estimatedMonthly: number;
  totalAccumulated: number;
  isOneTime: boolean;
}

interface PerProjectKpi {
  key: string;
  name: string;
  type: string;
  planejado: number;
  pago: number;
  total: number;
  count: number;
}

interface ExpenseKpiCardsProps {
  projectType: string | undefined;
  filteredCount: number;
  filteredPlanejadoCount: number;
  filteredPagoCount: number;
  totalGeral: number;
  totalPlanejado: number;
  totalPago: number;
  perProject: PerProjectKpi[];
  showInfluencePanel: boolean;
  influenceSummary: InfluenceProjectSummary[];
  influenceTotal: number;
  influenceReformaTotal: number;
}

const TYPE_ACCENT: Record<string, string> = {
  PESSOAL: 'bg-violet-500',
  REFORMA: 'bg-orange-500',
  CASA: 'bg-sky-500',
  CARRO: 'bg-teal-500',
  COMPRA: 'bg-rose-500',
};

const TYPE_LABEL: Record<string, string> = {
  PESSOAL: 'Pessoal',
  REFORMA: 'Reforma',
  CASA: 'Casa',
  CARRO: 'Carro',
  COMPRA: 'Compra',
};

export function ExpenseKpiCards({
  filteredCount,
  filteredPlanejadoCount,
  filteredPagoCount,
  totalGeral,
  totalPlanejado,
  totalPago,
  perProject,
  showInfluencePanel,
  influenceSummary,
  influenceTotal,
  influenceReformaTotal,
}: ExpenseKpiCardsProps) {
  const pctPago = totalGeral > 0 ? Math.round((totalPago / totalGeral) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* Cockpit — 3 KPIs principais (olhando tudo) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Total de Despesa</p>
          <p className="mt-1 text-2xl font-bold text-gray-900 tabular-nums">{formatCurrency(totalGeral / 100)}</p>
          <p className="mt-0.5 text-[11px] text-gray-400">{filteredCount} {filteredCount === 1 ? 'item' : 'itens'}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">Planejado</p>
          <p className="mt-1 text-2xl font-bold text-amber-800 tabular-nums">{formatCurrency(totalPlanejado / 100)}</p>
          <p className="mt-0.5 text-[11px] text-amber-500">{filteredPlanejadoCount} {filteredPlanejadoCount === 1 ? 'item' : 'itens'}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">Pago</p>
          <p className="mt-1 text-2xl font-bold text-emerald-800 tabular-nums">{formatCurrency(totalPago / 100)}</p>
          <p className="mt-0.5 text-[11px] text-emerald-500">
            {filteredPagoCount} {filteredPagoCount === 1 ? 'item' : 'itens'} · {pctPago}% do total
          </p>
        </div>
      </div>

      {/* Quebra por projeto — visão de cockpit consolidado */}
      {perProject.length > 1 && (
        <section className="rounded-xl border border-gray-200 bg-white p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Por projeto</p>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {perProject.map((p) => (
              <div key={p.key} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${TYPE_ACCENT[p.type] ?? 'bg-gray-400'}`} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-gray-800">{p.name}</p>
                      <p className="text-[10px] uppercase tracking-wider text-gray-400">
                        {TYPE_LABEL[p.type] ?? p.type} · {p.count} {p.count === 1 ? 'item' : 'itens'}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-sm font-bold text-gray-900 tabular-nums">{formatCurrency(p.total / 100)}</p>
                </div>
                <div className="mt-2 flex items-center gap-3 text-[11px]">
                  <span className="text-gray-500">
                    Planejado <span className="font-semibold text-amber-700 tabular-nums">{formatCurrency(p.planejado / 100)}</span>
                  </span>
                  <span className="text-gray-500">
                    Pago <span className="font-semibold text-emerald-700 tabular-nums">{formatCurrency(p.pago / 100)}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

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
    </div>
  );
}
