'use client';
import { useProject } from '@/contexts/project-context';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CashFlowEntry } from '@/types';
import { CompareView } from './_components/CompareView';
import { MonthlyProjection } from './_components/MonthlyProjection';
import { ShoppableSimulationView } from './_components/ShoppableSimulationView';
import { SimulationHero } from './_components/SimulationHero';
import { useSimulationScenarios } from './_hooks/useSimulationScenarios';
import type { SimMode } from './_types';

export default function SimulationPage() {
  const { projectId: PROJECT_ID } = useProject();
  const [simMode, setSimMode] = useState<SimMode>('simulacao');

  // Compare mode state
  const [compareIdA, setCompareIdA] = useState<string | null>(null);
  const [compareIdB, setCompareIdB] = useState<string | null>(null);

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const {
    scenarios,
    scenariosLoading,
    activeScenarioId,
    data,
    isLoading,
    error,
    createMut,
    renameMut,
    deleteMut,
    duplicateMut,
    monthlyExcludes,
    setMonthlyExcludes,
    monthlyPayConfigs,
    setMonthlyPayConfigs,
    monthlyRecDist,
    setMonthlyRecDist,
    tipoOverrides,
    setTipoOverrides,
    saving,
    dirty,
    doSave,
    scheduleSave,
    switchScenario,
  } = useSimulationScenarios({ projectId: PROJECT_ID });

  // Saldo real projetado (rollingBalance do último CashFlowEntry) — mesmo dado
  // já lido em MonthlyProjection.tsx como read-only, reaproveitado via cache
  // do React Query (mesma queryKey, sem request extra).
  const { data: cfEntries = [] } = useQuery<CashFlowEntry[]>({
    queryKey: ['cash-flow', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
  });
  const realProjectedSaldoCents = cfEntries.at(-1)?.rollingBalance;

  if (scenariosLoading) return <div className="text-gray-500">Carregando...</div>;

  const activeScenario = scenarios?.find((s) => s.id === activeScenarioId);

  return (
    <div className="space-y-4">
      {/* Header + scenario toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900">Simulação</h1>

        {/* Scenario selector */}
        <select
          value={activeScenarioId ?? ''}
          onChange={(e) => { void switchScenario(e.target.value || null); }}
          className="border rounded px-2 py-1 text-sm bg-white w-full sm:w-auto sm:min-w-[160px]"
        >
          <option value="">Selecione um cenário</option>
          {scenarios?.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        {/* Scenario actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              const name = prompt('Nome do novo cenário:');
              if (name?.trim()) createMut.mutate(name.trim());
            }}
            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
            title="Novo cenário"
          >
            + Novo
          </button>
          {activeScenarioId && (
            <>
              <button
                onClick={() => {
                  if (activeScenario) {
                    setRenamingId(activeScenarioId);
                    setRenameValue(activeScenario.name);
                  }
                }}
                className="px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                title="Renomear"
              >
                ✏️
              </button>
              <button
                onClick={() => duplicateMut.mutate({ id: activeScenarioId })}
                className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                title="Duplicar"
              >
                📋
              </button>
              {scenarios && scenarios.length > 1 && (
                <button
                  onClick={() => {
                    if (confirm(`Excluir cenário "${activeScenario?.name}"?`)) {
                      deleteMut.mutate(activeScenarioId);
                    }
                  }}
                  className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                  title="Excluir"
                >
                  🗑️
                </button>
              )}
            </>
          )}
        </div>

        {/* Save indicator */}
        <div className="flex items-center gap-2 ml-auto">
          {saving && <span className="text-xs text-gray-400 animate-pulse">Salvando...</span>}
          {!saving && dirty && <span className="text-xs text-orange-500">● Alterações não salvas</span>}
          <button
            onClick={() => { void doSave(); }}
            disabled={saving || !dirty}
            className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
              dirty ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </div>

      {/* Rename modal */}
      {renamingId && (
        <div className="flex items-center gap-2 bg-yellow-50 border border-yellow-200 rounded p-2">
          <span className="text-xs text-gray-600">Renomear:</span>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameValue.trim()) {
                renameMut.mutate({ id: renamingId, name: renameValue.trim() }, { onSuccess: () => setRenamingId(null) });
              } else if (e.key === 'Escape') setRenamingId(null);
            }}
            className="border rounded px-2 py-0.5 text-sm flex-1"
          />
          <button
            onClick={() => renameValue.trim() && renameMut.mutate({ id: renamingId, name: renameValue.trim() }, { onSuccess: () => setRenamingId(null) })}
            className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded"
          >
            OK
          </button>
          <button onClick={() => setRenamingId(null)} className="px-2 py-0.5 text-xs bg-gray-200 rounded">
            Cancelar
          </button>
        </div>
      )}

      {/* Mode toggle */}
      <div className="inline-flex rounded-md border border-gray-300 text-xs overflow-hidden">
        {(['simulacao', 'compraveis', 'comparar'] as SimMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => {
              setSimMode(mode);
              if (mode === 'comparar' && scenarios && scenarios.length >= 2) {
                setCompareIdA(scenarios[0].id);
                setCompareIdB(scenarios[1].id);
              }
            }}
            className={`px-4 py-1.5 transition-colors border-l first:border-l-0 border-gray-300 ${
              simMode === mode ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {{ simulacao: 'Simulação', compraveis: 'Compráveis Simulados', comparar: 'Comparar Cenários' }[mode]}
          </button>
        ))}
      </div>

      {/* Loading / no scenario */}
      {!activeScenarioId && simMode !== 'comparar' && simMode !== 'compraveis' && (
        <div className="text-gray-500 text-sm">Selecione ou crie um cenário para começar.</div>
      )}

      {isLoading && simMode !== 'compraveis' && <div className="text-gray-500">Carregando dados...</div>}
      {error && <div className="text-red-600">Erro ao carregar simulação.</div>}

      {/* ═══ SIMULAÇÃO (unified view) ═══ */}
      {simMode === 'simulacao' && data && (
        <>
        <SimulationHero
          previsaoSaldo={data.kpis.previsaoSaldo}
          realProjectedSaldoCents={realProjectedSaldoCents}
        />
        <MonthlyProjection
          projecaoMensal={data.projecaoMensal}
          recebimentosPorTipo={data.recebimentosPorTipo}
          porTipo={data.porTipo}
          tipoOverrides={tipoOverrides}
          excludes={monthlyExcludes}
          payConfigs={monthlyPayConfigs}
          recDist={monthlyRecDist}
          onToggleExclude={(id) => {
            setMonthlyExcludes((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
            scheduleSave();
          }}
          onPayConfigChange={(id, cfg) => {
            setMonthlyPayConfigs((p) => ({ ...p, [id]: cfg }));
            scheduleSave();
          }}
          onRecDistChange={(month, val) => {
            setMonthlyRecDist((p) => ({ ...p, [month]: val }));
            scheduleSave();
          }}
          onTipoOverrideChange={(tipoKey, val) => {
            setTipoOverrides((p) => ({ ...p, [tipoKey]: val }));
            scheduleSave();
          }}
          onResetDespesas={() => {
            setMonthlyExcludes(new Set());
            setMonthlyPayConfigs({});
            setTipoOverrides({});
            scheduleSave();
          }}
          onRemovePayConfig={(id) => {
            setMonthlyPayConfigs((p) => {
              const next = { ...p };
              delete next[id];
              return next;
            });
            scheduleSave();
          }}
        />
        </>
      )}

      {/* ═══ COMPARE MODE ═══ */}
      {simMode === 'comparar' && scenarios && (
        <CompareView
          scenarios={scenarios}
          compareIdA={compareIdA}
          compareIdB={compareIdB}
          setCompareIdA={setCompareIdA}
          setCompareIdB={setCompareIdB}
        />
      )}

      {/* ═══ COMPRÁVEIS SIMULADOS (todos os cenários lado a lado) ═══ */}
      {simMode === 'compraveis' && (
        <ShoppableSimulationView />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ROW COMPONENTS (unchanged)
   ═══════════════════════════════════════════════════════════ */
