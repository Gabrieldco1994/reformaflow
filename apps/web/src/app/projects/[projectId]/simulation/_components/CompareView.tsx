'use client';

import React, { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import type { Scenario, SimulationData } from '../_types';
import { CompareAmbienteBlock } from './CompareAmbienteBlock';

export function CompareView({
  scenarios, compareIdA, compareIdB, setCompareIdA, setCompareIdB,
}: {
  scenarios: Scenario[];
  compareIdA: string | null;
  compareIdB: string | null;
  setCompareIdA: (id: string | null) => void;
  setCompareIdB: (id: string | null) => void;
}) {
  const { projectId: PROJECT_ID } = useProject();
  const bothSelected = compareIdA && compareIdB && compareIdA !== compareIdB;

  const { data: baseData } = useQuery<SimulationData>({
    queryKey: ['simulation', compareIdA],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation?scenarioId=${compareIdA}`),
    enabled: !!compareIdA,
  });

  const { data: compareData, isLoading } = useQuery<Record<string, Record<string, string>>>({
    queryKey: ['simulation-compare', compareIdA, compareIdB],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation/compare?scenarios=${compareIdA},${compareIdB}`),
    enabled: !!bothSelected,
  });

  const scenarioA = scenarios.find((s) => s.id === compareIdA);
  const scenarioB = scenarios.find((s) => s.id === compareIdB);

  const computeKpis = useCallback((data: SimulationData, savedValues: Record<string, string>) => {
    const totalRecSim = data.recebimentosPorTipo.reduce((s, r) => {
      const sv = parseFloat(savedValues[`rec|${r.key}`] || '');
      return s + (isNaN(sv) ? r.total : Math.round(sv * 100));
    }, 0);

    let totalDespSim = 0;
    for (const amb of data.ambientes) {
      for (const tipo of amb.tipos) {
        if (tipo.key === 'MAO_DE_OBRA' && tipo.categorias) {
          for (const cat of tipo.categorias) {
            const simKey = `desp|${amb.key}|${tipo.key}|${cat.key}`;
            const sv = parseFloat(savedValues[simKey] || '');
            totalDespSim += isNaN(sv) ? cat.total : Math.round(sv * 100);
          }
        } else {
          const simKey = `desp|${amb.key}|${tipo.key}`;
          const sv = parseFloat(savedValues[simKey] || '');
          totalDespSim += isNaN(sv) ? tipo.total : Math.round(sv * 100);
        }
      }
    }

    return { totalRecebimentos: totalRecSim, previsaoGastos: totalDespSim, previsaoSaldo: totalRecSim - totalDespSim };
  }, []);

  const kpisA = useMemo(() => {
    if (!baseData || !compareData || !compareIdA) return null;
    return computeKpis(baseData, compareData[compareIdA] || {});
  }, [baseData, compareData, compareIdA, computeKpis]);

  const kpisB = useMemo(() => {
    if (!baseData || !compareData || !compareIdB) return null;
    return computeKpis(baseData, compareData[compareIdB] || {});
  }, [baseData, compareData, compareIdB, computeKpis]);

  return (
    <div className="space-y-4">
      {/* Scenario selectors */}
      <div className="flex gap-4 items-center">
        <div className="flex-1">
          <label className="text-xs font-medium text-gray-600 mb-1 block">Cenário A</label>
          <select
            value={compareIdA ?? ''}
            onChange={(e) => setCompareIdA(e.target.value || null)}
            className="w-full border rounded px-2 py-1.5 text-sm bg-blue-50"
          >
            <option value="">Selecione...</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === compareIdB}>{s.name}</option>
            ))}
          </select>
        </div>
        <span className="text-gray-400 mt-4 text-lg">vs</span>
        <div className="flex-1">
          <label className="text-xs font-medium text-gray-600 mb-1 block">Cenário B</label>
          <select
            value={compareIdB ?? ''}
            onChange={(e) => setCompareIdB(e.target.value || null)}
            className="w-full border rounded px-2 py-1.5 text-sm bg-purple-50"
          >
            <option value="">Selecione...</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === compareIdA}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && <div className="text-gray-500 text-sm">Carregando comparação...</div>}

      {bothSelected && kpisA && kpisB && baseData && compareData && (
        <>
          {/* KPIs side by side */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Recebimentos', vA: kpisA.totalRecebimentos, vB: kpisB.totalRecebimentos, real: baseData.kpis.totalRecebimentos },
              { label: 'Gastos', vA: kpisA.previsaoGastos, vB: kpisB.previsaoGastos, real: baseData.kpis.previsaoGastos },
              { label: 'Saldo', vA: kpisA.previsaoSaldo, vB: kpisB.previsaoSaldo, real: baseData.kpis.previsaoSaldo },
            ].map((kpi) => {
              const diff = kpi.vA - kpi.vB;
              return (
                <div key={kpi.label} className="rounded-lg border p-3 bg-white">
                  <p className="text-xs font-medium text-gray-500 mb-2">{kpi.label}</p>
                  <p className="text-[10px] text-gray-400 mb-1">Real: {formatCurrency(kpi.real / 100)}</p>
                  <div className="flex justify-between items-end">
                    <div>
                      <p className="text-[10px] text-blue-600 font-medium">{scenarioA?.name}</p>
                      <p className="text-sm font-bold text-blue-700">{formatCurrency(kpi.vA / 100)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-purple-600 font-medium">{scenarioB?.name}</p>
                      <p className="text-sm font-bold text-purple-700">{formatCurrency(kpi.vB / 100)}</p>
                    </div>
                  </div>
                  {diff !== 0 && (
                    <p className={`text-[10px] mt-1 text-center ${diff > 0 ? 'text-green-600' : 'text-red-600'}`}>
                      Δ {diff > 0 ? '+' : ''}{formatCurrency(diff / 100)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Recebimentos comparison */}
          <div className="border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-green-50 text-green-800">
              <h3 className="font-semibold text-sm">Recebimentos — Comparação</h3>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-xs">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium text-gray-600">Tipo</th>
                  <th className="text-right px-3 py-1.5 font-medium text-gray-600">Real</th>
                  <th className="text-right px-3 py-1.5 font-medium text-blue-600">{scenarioA?.name}</th>
                  <th className="text-right px-3 py-1.5 font-medium text-purple-600">{scenarioB?.name}</th>
                  <th className="text-right px-3 py-1.5 font-medium text-gray-600">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {baseData.recebimentosPorTipo.map((r) => {
                  const svA = parseFloat(compareData[compareIdA!]?.[`rec|${r.key}`] || '');
                  const svB = parseFloat(compareData[compareIdB!]?.[`rec|${r.key}`] || '');
                  const valA = isNaN(svA) ? r.total : Math.round(svA * 100);
                  const valB = isNaN(svB) ? r.total : Math.round(svB * 100);
                  const diff = valA - valB;
                  return (
                    <tr key={r.key} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5">{r.label}</td>
                      <td className="px-3 py-1.5 text-right">{formatCurrency(r.total / 100)}</td>
                      <td className="px-3 py-1.5 text-right text-blue-700 font-medium">{formatCurrency(valA / 100)}</td>
                      <td className="px-3 py-1.5 text-right text-purple-700 font-medium">{formatCurrency(valB / 100)}</td>
                      <td className={`px-3 py-1.5 text-right ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {diff !== 0 ? `${diff > 0 ? '+' : ''}${formatCurrency(diff / 100)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>

          {/* Despesas comparison by ambiente */}
          <div className="border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-orange-50 text-orange-800">
              <h3 className="font-semibold text-sm">Despesas por Ambiente — Comparação</h3>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-xs">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium text-gray-600">Ambiente / Tipo</th>
                  <th className="text-right px-3 py-1.5 font-medium text-gray-600">Real</th>
                  <th className="text-right px-3 py-1.5 font-medium text-blue-600">{scenarioA?.name}</th>
                  <th className="text-right px-3 py-1.5 font-medium text-purple-600">{scenarioB?.name}</th>
                  <th className="text-right px-3 py-1.5 font-medium text-gray-600">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {baseData.ambientes.map((amb) => {
                  let ambTotalA = 0, ambTotalB = 0;
                  const tipoRows = amb.tipos.map((tipo) => {
                    if (tipo.key === 'MAO_DE_OBRA' && tipo.categorias) {
                      let tA = 0, tB = 0;
                      const catRows = tipo.categorias.map((cat) => {
                        const k = `desp|${amb.key}|${tipo.key}|${cat.key}`;
                        const sA = parseFloat(compareData[compareIdA!]?.[k] || '');
                        const sB = parseFloat(compareData[compareIdB!]?.[k] || '');
                        const vA = isNaN(sA) ? cat.total : Math.round(sA * 100);
                        const vB = isNaN(sB) ? cat.total : Math.round(sB * 100);
                        tA += vA; tB += vB;
                        return { ...cat, vA, vB };
                      });
                      ambTotalA += tA; ambTotalB += tB;
                      return { ...tipo, vA: tA, vB: tB, catRows };
                    } else {
                      const k = `desp|${amb.key}|${tipo.key}`;
                      const sA = parseFloat(compareData[compareIdA!]?.[k] || '');
                      const sB = parseFloat(compareData[compareIdB!]?.[k] || '');
                      const vA = isNaN(sA) ? tipo.total : Math.round(sA * 100);
                      const vB = isNaN(sB) ? tipo.total : Math.round(sB * 100);
                      ambTotalA += vA; ambTotalB += vB;
                      return { ...tipo, vA, vB, catRows: undefined as Array<{ key: string; label: string; total: number; vA: number; vB: number }> | undefined };
                    }
                  });

                  const ambDiff = ambTotalA - ambTotalB;
                  return (
                    <CompareAmbienteBlock
                      key={amb.key}
                      amb={amb}
                      ambTotalA={ambTotalA}
                      ambTotalB={ambTotalB}
                      ambDiff={ambDiff}
                      tipoRows={tipoRows}
                    />
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}

      {!bothSelected && (
        <div className="text-gray-500 text-sm text-center py-8">
          Selecione dois cenários diferentes para comparar.
        </div>
      )}
    </div>
  );
}
