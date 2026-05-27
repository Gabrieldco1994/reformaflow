'use client';
import { useProject } from '@/contexts/project-context';

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { CashFlowEntry } from '@/types';
import { CompareView } from './_components/CompareView';
import { MonthlyProjection } from './_components/MonthlyProjection';
import { ShoppableSimulationView } from './_components/ShoppableSimulationView';
import {
  SAVE_DEBOUNCE_MS,
  type SimRow,
  type SimTipo,
  type SimAmbiente,
  type SimTipoCard,
  type MonthlyRow,
  type SimulationData,
  type Scenario,
  type SimValues,
  type SimMode,
  type PayConfig,
} from './_types';

export default function SimulationPage() {
  const { projectId: PROJECT_ID } = useProject();
  const queryClient = useQueryClient();
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [simMode, setSimMode] = useState<SimMode>('simulacao');

  // Compare mode state
  const [compareIdA, setCompareIdA] = useState<string | null>(null);
  const [compareIdB, setCompareIdB] = useState<string | null>(null);

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Load scenarios
  const { data: scenarios, isLoading: scenariosLoading } = useQuery<Scenario[]>({
    queryKey: ['simulation-scenarios', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation/scenarios`),
  });

  // Auto-select first scenario
  // Auto-select first scenario only on initial load (do not auto-switch).
  useEffect(() => {
    if (scenarios && scenarios.length > 0 && !activeScenarioId) {
      setActiveScenarioId(scenarios[0].id);
    }
  }, [scenarios, activeScenarioId]);

  // Load simulation data for active scenario
  const { data, isLoading, error } = useQuery<SimulationData>({
    queryKey: ['simulation', PROJECT_ID, activeScenarioId],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation${activeScenarioId ? `?scenarioId=${activeScenarioId}` : ''}`),
    enabled: !!activeScenarioId,
  });

  // Scenario mutations
  const createMut = useMutation({
    mutationFn: (name: string) => api.post<Scenario>(`/projects/${PROJECT_ID}/simulation/scenarios`, { name }),
    onSuccess: (newScenario) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', PROJECT_ID] });
      void switchScenario(newScenario.id);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch(`/projects/${PROJECT_ID}/simulation/scenarios/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', PROJECT_ID] });
      setRenamingId(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${PROJECT_ID}/simulation/scenarios/${id}`),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', PROJECT_ID] });
      if (activeScenarioId === deletedId) setActiveScenarioId(null);
    },
  });

  const duplicateMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) =>
      api.post<Scenario>(`/projects/${PROJECT_ID}/simulation/scenarios/${id}/duplicate`, { name }),
    onSuccess: (newScenario) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', PROJECT_ID] });
      void switchScenario(newScenario.id);
    },
  });

  // Sim values state (scoped to active scenario)
  const [simRecebimentos, setSimRecebimentos] = useState<Record<string, string>>({});
  const [simDespesas, setSimDespesas] = useState<SimValues>({});
  // Monthly projection: excludes + payment configs per expense + rec distribution
  const [monthlyExcludes, setMonthlyExcludes] = useState<Set<string>>(new Set());
  const [monthlyPayConfigs, setMonthlyPayConfigs] = useState<Record<string, PayConfig>>({});
  const [monthlyRecDist, setMonthlyRecDist] = useState<Record<string, string>>({});
  const [tipoOverrides, setTipoOverrides] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const initialized = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRecRef = useRef(simRecebimentos);
  const latestDespRef = useRef(simDespesas);
  const latestMonthlyExcludesRef = useRef(monthlyExcludes);
  const latestMonthlyPayConfigsRef = useRef(monthlyPayConfigs);
  const latestMonthlyRecDistRef = useRef(monthlyRecDist);
  const latestTipoOverridesRef = useRef(tipoOverrides);
  const activeScenarioIdRef = useRef(activeScenarioId);

  // Keep refs in sync with state after each render (the only safe place to mutate refs).
  // Reading these during render would yield stale values; using useEffect ensures the
  // pending save (debounced) always sees the latest state.
  useEffect(() => {
    latestRecRef.current = simRecebimentos;
    latestDespRef.current = simDespesas;
    latestMonthlyExcludesRef.current = monthlyExcludes;
    latestMonthlyPayConfigsRef.current = monthlyPayConfigs;
    latestMonthlyRecDistRef.current = monthlyRecDist;
    latestTipoOverridesRef.current = tipoOverrides;
    activeScenarioIdRef.current = activeScenarioId;
  });

  // Load saved values when data or scenario changes
  useEffect(() => {
    if (!data?.savedValues || !activeScenarioId) return;
    if (initialized.current === activeScenarioId) return;
    initialized.current = activeScenarioId;
    const rec: Record<string, string> = {};
    const desp: SimValues = {};
    const mExcludes = new Set<string>();
    const mPayConfigs: Record<string, PayConfig> = {};
    const mRecDist: Record<string, string> = {};
    const mTipoOver: Record<string, string> = {};
    for (const [key, val] of Object.entries(data.savedValues)) {
      if (key.startsWith('rec|')) {
        rec[key.slice(4)] = val;
      } else if (key.startsWith('desp|')) {
        desp[key.slice(5)] = val;
      } else if (key.startsWith('monthly_excl|')) {
        if (val === '1') mExcludes.add(key.slice(13));
      } else if (key.startsWith('monthly_pay|')) {
        const rest = key.slice(12);
        const lastPipe = rest.lastIndexOf('|');
        const id = rest.slice(0, lastPipe);
        const field = rest.slice(lastPipe + 1);
        if (!mPayConfigs[id]) mPayConfigs[id] = { mode: 'avista', parcelas: '1', inicio: '', valor: '' };
        if (field === 'mode') mPayConfigs[id].mode = val;
        else if (field === 'parcelas') mPayConfigs[id].parcelas = val;
        else if (field === 'inicio') mPayConfigs[id].inicio = val;
        else if (field === 'valor') mPayConfigs[id].valor = val;
        else if (field === 'titulo') mPayConfigs[id].titulo = val;
        else if (field === 'categoria') mPayConfigs[id].categoria = val;
        else if (field === 'subcategoria') mPayConfigs[id].subcategoria = val;
        else if (field === 'ambiente') mPayConfigs[id].ambiente = val;
        else if (field === 'link') mPayConfigs[id].link = val;
        else if (field === 'imageUrl') mPayConfigs[id].imageUrl = val;
      } else if (key.startsWith('monthly_rec|')) {
        mRecDist[key.slice(12)] = val;
      } else if (key.startsWith('tipo_over|')) {
        mTipoOver[key.slice(10)] = val;
      }
    }
    setSimRecebimentos(rec);
    setSimDespesas(desp);
    setMonthlyExcludes(mExcludes);
    setMonthlyPayConfigs(mPayConfigs);
    setMonthlyRecDist(mRecDist);
    setTipoOverrides(mTipoOver);
    setDirty(false);
  }, [data, activeScenarioId]);

  // Reset initialized when scenario changes so values reload
  useEffect(() => {
    initialized.current = null;
  }, [activeScenarioId]);

  // doSave takes the scenarioId explicitly so a pending debounce can't accidentally
  // write data from one scenario into another after the user switches scenarios.
  const doSave = useCallback(async (overrideScenarioId?: string | null) => {
    const sid = overrideScenarioId ?? activeScenarioIdRef.current;
    if (!sid) return;
    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(latestRecRef.current)) vals[`rec|${k}`] = v;
    for (const [k, v] of Object.entries(latestDespRef.current)) vals[`desp|${k}`] = v;
    for (const id of latestMonthlyExcludesRef.current) {
      vals[`monthly_excl|${id}`] = '1';
    }
    for (const [id, cfg] of Object.entries(latestMonthlyPayConfigsRef.current)) {
      vals[`monthly_pay|${id}|mode`] = cfg.mode;
      vals[`monthly_pay|${id}|parcelas`] = cfg.parcelas;
      vals[`monthly_pay|${id}|inicio`] = cfg.inicio;
      if (cfg.valor) vals[`monthly_pay|${id}|valor`] = cfg.valor;
      if (cfg.titulo) vals[`monthly_pay|${id}|titulo`] = cfg.titulo;
      if (cfg.categoria) vals[`monthly_pay|${id}|categoria`] = cfg.categoria;
      if (cfg.subcategoria) vals[`monthly_pay|${id}|subcategoria`] = cfg.subcategoria;
      if (cfg.ambiente) vals[`monthly_pay|${id}|ambiente`] = cfg.ambiente;
      if (cfg.link) vals[`monthly_pay|${id}|link`] = cfg.link;
      if (cfg.imageUrl) vals[`monthly_pay|${id}|imageUrl`] = cfg.imageUrl;
    }
    for (const [month, v] of Object.entries(latestMonthlyRecDistRef.current)) {
      vals[`monthly_rec|${month}`] = v;
    }
    for (const [tipoKey, v] of Object.entries(latestTipoOverridesRef.current)) {
      if (v) vals[`tipo_over|${tipoKey}`] = v;
    }
    setSaving(true);
    try {
      await api.put(`/projects/${PROJECT_ID}/simulation/scenarios/${sid}/values`, { values: vals });
      // Only clear dirty if the saved scenario is still the active one. If the user
      // switched scenarios mid-flight, the new scenario may legitimately be dirty.
      if (sid === activeScenarioIdRef.current) setDirty(false);
    } catch (e) {
      console.error('Erro ao salvar simulação:', e);
    }
    setSaving(false);
  }, [PROJECT_ID]);

  const scheduleSave = useCallback(() => {
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Capture the scenarioId at schedule time. If the user switches scenarios before
    // the debounce fires, `switchScenario` will flush this pending save first using
    // the captured id (so we don't write current-state into the wrong scenario).
    const sid = activeScenarioIdRef.current;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void doSave(sid);
    }, SAVE_DEBOUNCE_MS);
  }, [doSave]);

  // Flush any pending save synchronously and switch scenarios. This guarantees that
  // edits to scenario A are persisted before scenario B's data overwrites the local
  // state. Without this, the pending debounce could fire after the state was reset,
  // saving B's empty/loaded data back under A's scenarioId (data loss bug).
  const switchScenario = useCallback(async (newId: string | null) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const prevId = activeScenarioIdRef.current;
      if (prevId) await doSave(prevId);
    }
    setActiveScenarioId(newId);
  }, [doSave]);

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
                renameMut.mutate({ id: renamingId, name: renameValue.trim() });
              } else if (e.key === 'Escape') setRenamingId(null);
            }}
            className="border rounded px-2 py-0.5 text-sm flex-1"
          />
          <button
            onClick={() => renameValue.trim() && renameMut.mutate({ id: renamingId, name: renameValue.trim() })}
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
