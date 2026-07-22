"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CashFlowEntry } from "@/types";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import {
  calculateCompraScenario,
  parseCompraScenarioValues,
} from "../_lib/compra-scenario";
import type {
  CompraPriceMonitorItem,
  Scenario,
  SimulationData,
} from "../_types";

interface CompraCompareViewProps {
  projectId: string;
  scenarios: Scenario[];
  compareIdA: string | null;
  compareIdB: string | null;
  setCompareIdA: (id: string | null) => void;
  setCompareIdB: (id: string | null) => void;
  baseData: SimulationData | undefined;
  cashFlowEntries: CashFlowEntry[];
  items: CompraPriceMonitorItem[];
}

export function CompraCompareView({
  projectId,
  scenarios,
  compareIdA,
  compareIdB,
  setCompareIdA,
  setCompareIdB,
  baseData,
  cashFlowEntries,
  items,
}: CompraCompareViewProps) {
  const bothSelected = Boolean(
    compareIdA && compareIdB && compareIdA !== compareIdB,
  );
  const { data: comparedValues, isLoading, isError } = useQuery<
    Record<string, Record<string, string>>
  >({
    queryKey: ["simulation-compare", projectId, compareIdA, compareIdB],
    queryFn: () =>
      api.get(
        `/projects/${projectId}/simulation/compare?scenarios=${compareIdA},${compareIdB}`,
      ),
    enabled: bothSelected,
  });

  const metricsA = useMemo(() => {
    if (!baseData || !compareIdA || !comparedValues) return null;
    const state = parseCompraScenarioValues(comparedValues[compareIdA] ?? {});
    return calculateCompraScenario({
      data: baseData,
      cashFlowEntries,
      items,
      ...state,
    });
  }, [baseData, cashFlowEntries, compareIdA, comparedValues, items]);
  const metricsB = useMemo(() => {
    if (!baseData || !compareIdB || !comparedValues) return null;
    const state = parseCompraScenarioValues(comparedValues[compareIdB] ?? {});
    return calculateCompraScenario({
      data: baseData,
      cashFlowEntries,
      items,
      ...state,
    });
  }, [baseData, cashFlowEntries, compareIdB, comparedValues, items]);

  const scenarioA = scenarios.find((scenario) => scenario.id === compareIdA);
  const scenarioB = scenarios.find((scenario) => scenario.id === compareIdB);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 sm:gap-4">
        <label className="text-xs font-medium text-darc-velvet/70">
          Cenário A
          <select
            value={compareIdA ?? ""}
            onChange={(event) => setCompareIdA(event.target.value || null)}
            className="mt-1 min-h-11 w-full rounded-lg border border-darc-linen bg-white px-2 text-sm"
          >
            <option value="">Selecione</option>
            {scenarios.map((scenario) => (
              <option
                key={scenario.id}
                value={scenario.id}
                disabled={scenario.id === compareIdB}
              >
                {scenario.name}
              </option>
            ))}
          </select>
        </label>
        <span className="pb-3 text-xs text-darc-velvet/50">vs</span>
        <label className="text-xs font-medium text-darc-velvet/70">
          Cenário B
          <select
            value={compareIdB ?? ""}
            onChange={(event) => setCompareIdB(event.target.value || null)}
            className="mt-1 min-h-11 w-full rounded-lg border border-darc-linen bg-white px-2 text-sm"
          >
            <option value="">Selecione</option>
            {scenarios.map((scenario) => (
              <option
                key={scenario.id}
                value={scenario.id}
                disabled={scenario.id === compareIdA}
              >
                {scenario.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading && (
        <p className="text-sm text-darc-velvet/60">Carregando comparação...</p>
      )}
      {isError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Não foi possível carregar a comparação. Tente novamente.
        </div>
      )}
      {!bothSelected && (
        <div className="rounded-2xl border border-darc-linen bg-white p-5 text-center text-sm text-darc-velvet/65">
          Selecione dois cenários diferentes para comparar.
        </div>
      )}

      {metricsA && metricsB && (
        <div className="space-y-3">
          {[
            {
              label: "Total planejado",
              valueA: metricsA.totalPlanejadoCents,
              valueB: metricsB.totalPlanejadoCents,
            },
            {
              label: "Saldo projetado",
              valueA: metricsA.saldoProjetadoCents,
              valueB: metricsB.saldoProjetadoCents,
            },
            {
              label: "Impacto mensal",
              valueA: metricsA.impactoMensalCents,
              valueB: metricsB.impactoMensalCents,
            },
          ].map(({ label, valueA, valueB }) => (
            <div
              key={label}
              className="rounded-2xl border border-darc-linen bg-white p-4"
            >
              <p className="text-xs font-semibold text-darc-velvet/65">
                {label}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="truncate text-xs text-blue-700">
                    {scenarioA?.name}
                  </p>
                  <p className="whitespace-nowrap text-base font-bold text-blue-800">
                    {formatCurrency(valueA / 100)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="truncate text-xs text-purple-700">
                    {scenarioB?.name}
                  </p>
                  <p className="whitespace-nowrap text-base font-bold text-purple-800">
                    {formatCurrency(valueB / 100)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
