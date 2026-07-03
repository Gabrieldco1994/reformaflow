import { formatCurrency } from '@/lib/utils';
import { KpiTile } from '@/components/KpiTile';

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
  /** Renderiza apenas a seção "Por projeto" (os 3 KPIs do topo vêm de outro componente). */
  onlyPerProject?: boolean;
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
  onlyPerProject = false,
}: ExpenseKpiCardsProps) {
  const pctPago = totalGeral > 0 ? Math.round((totalPago / totalGeral) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* Cockpit — 3 KPIs principais (olhando tudo) */}
      {!onlyPerProject && (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiTile
          variant="plain"
          tone="neutral"
          label="Total de Despesa"
          info="Soma de todas as despesas do filtro atual — planejadas + pagas."
          value={formatCurrency(totalGeral / 100)}
          context={`${filteredCount} ${filteredCount === 1 ? 'item' : 'itens'}`}
        />
        <KpiTile
          variant="tinted"
          tone="alert"
          label="Planejado"
          info="Despesas ainda não pagas (status Planejado) — o que está previsto para sair."
          value={formatCurrency(totalPlanejado / 100)}
          context={`${filteredPlanejadoCount} ${filteredPlanejadoCount === 1 ? 'item' : 'itens'}`}
        />
        <KpiTile
          variant="tinted"
          tone="positive"
          label="Pago"
          info="Despesas já efetivadas (status Pago) — o que de fato saiu."
          value={formatCurrency(totalPago / 100)}
          context={`${filteredPagoCount} ${filteredPagoCount === 1 ? 'item' : 'itens'} · ${pctPago}% do total`}
        />
      </div>
      )}

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
    </div>
  );
}
