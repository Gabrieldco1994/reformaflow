'use client';

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { CashFlowEntry } from '@/types';

const PROJECT_ID = 'dev-project-1';
const SAVE_DEBOUNCE_MS = 1500;

const TIPO_DESPESA_OPTIONS = [
  { value: 'MATERIAL_CONSTRUCAO', label: 'Material p/ Construção' },
  { value: 'ELETRODOMESTICO', label: 'Eletrodoméstico' },
  { value: 'REVESTIMENTO', label: 'Revestimento' },
  { value: 'ILUMINACAO', label: 'Iluminação' },
  { value: 'MARMORE', label: 'Mármore' },
  { value: 'VIDRACARIA_SERRALHERIA', label: 'Vidraçaria & Serralheria' },
  { value: 'METAL_CERAMICA', label: 'Metal & Cerâmica' },
  { value: 'MARCENARIA', label: 'Marcenaria' },
  { value: 'MAO_DE_OBRA', label: 'Mão de Obra' },
];

const CATEGORIA_MAO_DE_OBRA_OPTIONS = [
  { value: 'EMPREITEIRO', label: 'Empreiteiro' },
  { value: 'INSTALADOR_PISO', label: 'Instalador de Piso' },
  { value: 'INSTALADOR_MARMORE', label: 'Instalador de Mármore' },
  { value: 'PINTOR', label: 'Pintor' },
  { value: 'ELETRICISTA', label: 'Eletricista' },
  { value: 'VIDRACEIRO', label: 'Vidraceiro' },
  { value: 'SERRALHEIRO', label: 'Serralheiro' },
  { value: 'MARCENEIRO', label: 'Marceneiro' },
];

const tipoLabel = (t: string) => TIPO_DESPESA_OPTIONS.find((o) => o.value === t)?.label ?? t;

interface SimRow { key: string; label: string; total: number }
interface SimTipo extends SimRow { categorias?: SimRow[] }
interface SimAmbiente { key: string; label: string; total: number; tipos: SimTipo[] }
interface SimTipoCard { key: string; label: string; total: number; ambientes: (SimRow & { categorias?: SimRow[] })[] }

interface MonthlyRow { month: string; recebimentos: number; despesas: number }

interface SimulationData {
  kpis: { totalRecebimentos: number; previsaoGastos: number; previsaoSaldo: number };
  recebimentosPorTipo: SimRow[];
  ambientes: SimAmbiente[];
  porTipo: SimTipoCard[];
  projecaoMensal: MonthlyRow[];
  savedValues: Record<string, string>;
}

interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

type SimValues = Record<string, string>;
type SimMode = 'simulacao' | 'comparar';

export default function SimulationPage() {
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
    queryKey: ['simulation-scenarios'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation/scenarios`),
  });

  // Auto-select first scenario
  useEffect(() => {
    if (scenarios && scenarios.length > 0 && !activeScenarioId) {
      setActiveScenarioId(scenarios[0].id);
    }
  }, [scenarios, activeScenarioId]);

  // Load simulation data for active scenario
  const { data, isLoading, error } = useQuery<SimulationData>({
    queryKey: ['simulation', activeScenarioId],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation${activeScenarioId ? `?scenarioId=${activeScenarioId}` : ''}`),
    enabled: !!activeScenarioId,
  });

  // Scenario mutations
  const createMut = useMutation({
    mutationFn: (name: string) => api.post<Scenario>(`/projects/${PROJECT_ID}/simulation/scenarios`, { name }),
    onSuccess: (newScenario) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios'] });
      setActiveScenarioId(newScenario.id);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch(`/projects/${PROJECT_ID}/simulation/scenarios/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios'] });
      setRenamingId(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${PROJECT_ID}/simulation/scenarios/${id}`),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios'] });
      if (activeScenarioId === deletedId) setActiveScenarioId(null);
    },
  });

  const duplicateMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) =>
      api.post<Scenario>(`/projects/${PROJECT_ID}/simulation/scenarios/${id}/duplicate`, { name }),
    onSuccess: (newScenario) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios'] });
      setActiveScenarioId(newScenario.id);
    },
  });

  // Sim values state (scoped to active scenario)
  const [simRecebimentos, setSimRecebimentos] = useState<Record<string, string>>({});
  const [simDespesas, setSimDespesas] = useState<SimValues>({});
  // Monthly projection: excludes + payment configs per expense + rec distribution
  const [monthlyExcludes, setMonthlyExcludes] = useState<Set<string>>(new Set());
  const [monthlyPayConfigs, setMonthlyPayConfigs] = useState<Record<string, { mode: string; parcelas: string; inicio: string; valor: string; titulo?: string; categoria?: string; subcategoria?: string; ambiente?: string }>>({});
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
  latestRecRef.current = simRecebimentos;
  latestDespRef.current = simDespesas;
  latestMonthlyExcludesRef.current = monthlyExcludes;
  latestMonthlyPayConfigsRef.current = monthlyPayConfigs;
  latestMonthlyRecDistRef.current = monthlyRecDist;
  latestTipoOverridesRef.current = tipoOverrides;

  // Load saved values when data or scenario changes
  useEffect(() => {
    if (!data?.savedValues || !activeScenarioId) return;
    if (initialized.current === activeScenarioId) return;
    initialized.current = activeScenarioId;
    const rec: Record<string, string> = {};
    const desp: SimValues = {};
    const mExcludes = new Set<string>();
    const mPayConfigs: Record<string, { mode: string; parcelas: string; inicio: string; valor: string; titulo?: string; categoria?: string; subcategoria?: string; ambiente?: string }> = {};
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

  const doSave = useCallback(async () => {
    if (!activeScenarioId) return;
    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(latestRecRef.current)) vals[`rec|${k}`] = v;
    for (const [k, v] of Object.entries(latestDespRef.current)) vals[`desp|${k}`] = v;
    // Monthly excludes
    for (const id of latestMonthlyExcludesRef.current) {
      vals[`monthly_excl|${id}`] = '1';
    }
    // Monthly pay configs
    for (const [id, cfg] of Object.entries(latestMonthlyPayConfigsRef.current)) {
      vals[`monthly_pay|${id}|mode`] = cfg.mode;
      vals[`monthly_pay|${id}|parcelas`] = cfg.parcelas;
      vals[`monthly_pay|${id}|inicio`] = cfg.inicio;
      if (cfg.valor) vals[`monthly_pay|${id}|valor`] = cfg.valor;
      if (cfg.titulo) vals[`monthly_pay|${id}|titulo`] = cfg.titulo;
      if (cfg.categoria) vals[`monthly_pay|${id}|categoria`] = cfg.categoria;
      if (cfg.subcategoria) vals[`monthly_pay|${id}|subcategoria`] = cfg.subcategoria;
      if (cfg.ambiente) vals[`monthly_pay|${id}|ambiente`] = cfg.ambiente;
    }
    // Monthly rec distribution
    for (const [month, v] of Object.entries(latestMonthlyRecDistRef.current)) {
      vals[`monthly_rec|${month}`] = v;
    }
    // Tipo overrides
    for (const [tipoKey, v] of Object.entries(latestTipoOverridesRef.current)) {
      if (v) vals[`tipo_over|${tipoKey}`] = v;
    }
    setSaving(true);
    try {
      await api.put(`/projects/${PROJECT_ID}/simulation/scenarios/${activeScenarioId}/values`, { values: vals });
      setDirty(false);
    } catch (e) {
      console.error('Erro ao salvar simulação:', e);
    }
    setSaving(false);
  }, [activeScenarioId]);

  const scheduleSave = useCallback(() => {
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => doSave(), SAVE_DEBOUNCE_MS);
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
          onChange={(e) => setActiveScenarioId(e.target.value || null)}
          className="border rounded px-2 py-1 text-sm bg-white min-w-[160px]"
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
            onClick={doSave}
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
        {(['simulacao', 'comparar'] as SimMode[]).map((mode) => (
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
            {{ simulacao: 'Simulação', comparar: 'Comparar Cenários' }[mode]}
          </button>
        ))}
      </div>

      {/* Loading / no scenario */}
      {!activeScenarioId && simMode !== 'comparar' && (
        <div className="text-gray-500 text-sm">Selecione ou crie um cenário para começar.</div>
      )}

      {isLoading && <div className="text-gray-500">Carregando dados...</div>}
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
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   COMPARE VIEW
   ═══════════════════════════════════════════════════════════ */

function CompareView({
  scenarios, compareIdA, compareIdB, setCompareIdA, setCompareIdB,
}: {
  scenarios: Scenario[];
  compareIdA: string | null;
  compareIdB: string | null;
  setCompareIdA: (id: string | null) => void;
  setCompareIdB: (id: string | null) => void;
}) {
  const bothSelected = compareIdA && compareIdB && compareIdA !== compareIdB;

  // Load base simulation data (for structure)
  const { data: baseData } = useQuery<SimulationData>({
    queryKey: ['simulation', compareIdA],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation?scenarioId=${compareIdA}`),
    enabled: !!compareIdA,
  });

  // Load compare data (values of both scenarios)
  const { data: compareData, isLoading } = useQuery<Record<string, Record<string, string>>>({
    queryKey: ['simulation-compare', compareIdA, compareIdB],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/simulation/compare?scenarios=${compareIdA},${compareIdB}`),
    enabled: !!bothSelected,
  });

  const scenarioA = scenarios.find((s) => s.id === compareIdA);
  const scenarioB = scenarios.find((s) => s.id === compareIdB);

  // Compute KPIs for each scenario
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
            <table className="w-full text-xs">
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

          {/* Despesas comparison by ambiente */}
          <div className="border rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-orange-50 text-orange-800">
              <h3 className="font-semibold text-sm">Despesas por Ambiente — Comparação</h3>
            </div>
            <table className="w-full text-xs">
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
                  // Compute amb totals for each scenario
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

function CompareAmbienteBlock({ amb, ambTotalA, ambTotalB, ambDiff, tipoRows }: {
  amb: SimAmbiente;
  ambTotalA: number;
  ambTotalB: number;
  ambDiff: number;
  tipoRows: Array<SimTipo & { vA: number; vB: number; catRows?: Array<{ key: string; label: string; total: number; vA: number; vB: number }> }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="bg-orange-50/50 cursor-pointer hover:bg-orange-100/50" onClick={() => setExpanded(!expanded)}>
        <td className="px-3 py-1.5 font-semibold">
          <span className="mr-1 text-gray-400">{expanded ? '▾' : '▸'}</span>
          {amb.label}
        </td>
        <td className="px-3 py-1.5 text-right font-medium">{formatCurrency(amb.total / 100)}</td>
        <td className="px-3 py-1.5 text-right text-blue-700 font-medium">{formatCurrency(ambTotalA / 100)}</td>
        <td className="px-3 py-1.5 text-right text-purple-700 font-medium">{formatCurrency(ambTotalB / 100)}</td>
        <td className={`px-3 py-1.5 text-right ${ambDiff > 0 ? 'text-green-600' : ambDiff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
          {ambDiff !== 0 ? `${ambDiff > 0 ? '+' : ''}${formatCurrency(ambDiff / 100)}` : '—'}
        </td>
      </tr>
      {expanded && tipoRows.map((tipo) => {
        const diff = tipo.vA - tipo.vB;
        return (
          <tr key={tipo.key} className="hover:bg-gray-50">
            <td className="px-3 py-1 pl-8 text-gray-600">{tipo.label}</td>
            <td className="px-3 py-1 text-right text-gray-500">{formatCurrency(tipo.total / 100)}</td>
            <td className="px-3 py-1 text-right text-blue-600">{formatCurrency(tipo.vA / 100)}</td>
            <td className="px-3 py-1 text-right text-purple-600">{formatCurrency(tipo.vB / 100)}</td>
            <td className={`px-3 py-1 text-right ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
              {diff !== 0 ? `${diff > 0 ? '+' : ''}${formatCurrency(diff / 100)}` : '—'}
            </td>
          </tr>
        );
      })}
    </>
  );
}


/* ═══════════════════════════════════════════════════════════
   ROW COMPONENTS (unchanged)
   ═══════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════
   MONTHLY PROJECTION
   ═══════════════════════════════════════════════════════════ */

function MonthlyProjection({
  projecaoMensal, recebimentosPorTipo, porTipo, tipoOverrides, excludes, payConfigs, recDist,
  onToggleExclude, onPayConfigChange, onRecDistChange, onTipoOverrideChange, onResetDespesas, onRemovePayConfig,
}: {
  projecaoMensal: MonthlyRow[];
  recebimentosPorTipo: SimRow[];
  porTipo: SimTipoCard[];
  tipoOverrides: Record<string, string>;
  excludes: Set<string>;
  payConfigs: Record<string, { mode: string; parcelas: string; inicio: string; valor: string; titulo?: string; categoria?: string; subcategoria?: string; ambiente?: string }>;
  recDist: Record<string, string>;
  onToggleExclude: (id: string) => void;
  onPayConfigChange: (id: string, cfg: { mode: string; parcelas: string; inicio: string; valor: string; titulo?: string; categoria?: string; subcategoria?: string; ambiente?: string }) => void;
  onRecDistChange: (month: string, val: string) => void;
  onTipoOverrideChange: (tipoKey: string, val: string) => void;
  onResetDespesas: () => void;
  onRemovePayConfig: (id: string) => void;
}) {
  // Fetch cash flow entries (read-only — never modifies real data)
  const { data: cfEntries = [] } = useQuery<CashFlowEntry[]>({
    queryKey: ['cash-flow'],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/cash-flow`),
  });

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showSummary, setShowSummary] = useState(false);
  const [expandedTipos, setExpandedTipos] = useState<Set<string>>(new Set());


  const formatMonth = (m: string) => {
    const [y, mo] = m.split('-');
    const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    return `${months[parseInt(mo) - 1]}/${y.slice(2)}`;
  };

  const toMonth = (dateStr: string) => dateStr.slice(0, 7); // YYYY-MM

  // Month list from projecaoMensal or generate 12 months
  const monthList = useMemo(() => {
    if (projecaoMensal.length > 0) return projecaoMensal.map((r) => r.month);
    const ms: string[] = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      ms.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return ms;
  }, [projecaoMensal]);

  // Separate recebimentos and despesas
  const recEntries = useMemo(() => cfEntries.filter((e) => e.tipo === 'RECEBIMENTO'), [cfEntries]);
  const despEntries = useMemo(() => cfEntries.filter((e) => e.tipo === 'DESPESA'), [cfEntries]);

  // Group despesas by expenseId (or by entry id if no expenseId)
  interface DespGroup {
    groupId: string;
    titulo?: string;
    categoria: string;
    subcategoria?: string;
    ambiente?: string;
    fornecedor?: string;
    formaPagamento?: string;
    totalValor: number;
    entries: CashFlowEntry[];
    isMulti: boolean;
  }

  const despGroups = useMemo((): DespGroup[] => {
    const byExpense = new Map<string, CashFlowEntry[]>();
    const solos: CashFlowEntry[] = [];

    for (const e of despEntries) {
      if (e.expenseId) {
        const existing = byExpense.get(e.expenseId);
        if (existing) existing.push(e);
        else byExpense.set(e.expenseId, [e]);
      } else {
        solos.push(e);
      }
    }

    const groups: DespGroup[] = [];

    for (const [expId, entries] of byExpense) {
      const sorted = entries.sort((a, b) => a.data.localeCompare(b.data));
      const first = sorted[0];
      groups.push({
        groupId: expId,
        titulo: first.titulo || undefined,
        categoria: first.categoria || '',
        subcategoria: first.subcategoria || undefined,
        ambiente: first.ambiente || undefined,
        fornecedor: first.fornecedor || undefined,
        formaPagamento: first.formaPagamento || undefined,
        totalValor: sorted.reduce((s, e) => s + e.valor, 0),
        entries: sorted,
        isMulti: sorted.length > 1,
      });
    }

    for (const e of solos) {
      groups.push({
        groupId: e.id,
        titulo: e.titulo || undefined,
        categoria: e.categoria || '',
        subcategoria: e.subcategoria || undefined,
        ambiente: e.ambiente || undefined,
        fornecedor: e.fornecedor || undefined,
        formaPagamento: e.formaPagamento || undefined,
        totalValor: e.valor,
        entries: [e],
        isMulti: false,
      });
    }

    return groups.sort((a, b) => b.totalValor - a.totalValor);
  }, [despEntries]);

  // Extra projected-only rows from payConfigs (IDs starting with 'extra_')
  const extraRows = useMemo(() => {
    return Object.entries(payConfigs)
      .filter(([id]) => id.startsWith('extra_'))
      .map(([id, cfg]) => ({
        id,
        titulo: cfg.titulo || 'Despesa Extra',
        valor: parseFloat(cfg.valor || '0'),
        mode: cfg.mode || 'avista',
        parcelas: cfg.parcelas || '1',
        inicio: cfg.inicio || monthList[0] || '',
        categoria: cfg.categoria || '',
        subcategoria: cfg.subcategoria || '',
        ambiente: cfg.ambiente || '',
      }));
  }, [payConfigs, monthList]);

  // Group despesas by categoria for organized display
  const categorias = useMemo(() => {
    const catMap = new Map<string, DespGroup[]>();
    for (const g of despGroups) {
      const cat = g.categoria || 'Outros';
      const arr = catMap.get(cat);
      if (arr) arr.push(g);
      else catMap.set(cat, [g]);
    }
    // Include extra rows as pseudo-groups in their respective categories
    for (const extra of extraRows) {
      const cat = extra.categoria ? tipoLabel(extra.categoria) : 'Extras (Projeção)';
      const pseudoGroup: DespGroup = {
        groupId: extra.id,
        titulo: extra.titulo,
        categoria: cat,
        subcategoria: extra.subcategoria || undefined,
        ambiente: extra.ambiente || undefined,
        fornecedor: undefined,
        formaPagamento: extra.mode === 'parcelado' ? 'PARCELADO' : 'A_VISTA',
        totalValor: Math.round(extra.valor * 100),
        entries: [],
        isMulti: false,
      };
      const arr = catMap.get(cat);
      if (arr) arr.push(pseudoGroup);
      else catMap.set(cat, [pseudoGroup]);
    }
    return Array.from(catMap.entries())
      .map(([cat, groups]) => ({
        categoria: cat,
        groups,
        total: groups.reduce((s, g) => s + g.totalValor, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [despGroups, extraRows]);

  // State for inline add form
  const [showAddExtra, setShowAddExtra] = useState(false);
  const [newExtra, setNewExtra] = useState({ titulo: '', valor: '', mode: 'avista', parcelas: '1', inicio: '', categoria: '', subcategoria: '', ambiente: '' });

  const hasDespChanges = excludes.size > 0 || Object.keys(payConfigs).length > 0;

  // Total recebimentos from real data
  const totalRecReal = useMemo(() => recEntries.reduce((s, e) => s + e.valor, 0), [recEntries]);

  // Recebimentos distribution
  const totalRecDistributed = useMemo(() => {
    return Object.values(recDist).reduce((s, v) => {
      const n = parseFloat(v || '');
      return s + (isNaN(n) ? 0 : Math.round(n * 100));
    }, 0);
  }, [recDist]);
  const recRemaining = totalRecReal - totalRecDistributed;

  // Compute projected monthly despesas based on active groups + payment configs + edited values
  const monthlyDespProjected = useMemo(() => {
    const result: Record<string, number> = {};
    for (const m of monthList) result[m] = 0;

    for (const group of despGroups) {
      if (excludes.has(group.groupId)) continue; // excluded

      const cfg = payConfigs[group.groupId];
      const mode = cfg?.mode || (group.isMulti ? 'parcelado' : 'avista');
      const inicio = cfg?.inicio || toMonth(group.entries[0].data);
      const parcelas = mode === 'parcelado'
        ? Math.max(1, Math.min(12, parseInt(cfg?.parcelas || String(group.entries.length)) || 1))
        : 1;

      // Use edited valor if present, otherwise real
      const valorStr = cfg?.valor;
      const valorParsed = parseFloat(valorStr || '');
      const totalValor = valorStr && !isNaN(valorParsed) ? Math.round(valorParsed * 100) : group.totalValor;

      const startIdx = monthList.indexOf(inicio);
      if (startIdx === -1) {
        result[monthList[0]] += totalValor;
        continue;
      }

      const valorParcela = Math.floor(totalValor / parcelas);
      const resto = totalValor - valorParcela * parcelas;

      for (let i = 0; i < parcelas; i++) {
        const mIdx = startIdx + i;
        if (mIdx >= monthList.length) break;
        result[monthList[mIdx]] += valorParcela + (i === parcelas - 1 ? resto : 0);
      }
    }

    // Include extra projected-only rows
    for (const extra of extraRows) {
      const totalValor = Math.round(extra.valor * 100);
      if (totalValor <= 0) continue;
      const parcelas = extra.mode === 'parcelado' ? Math.max(1, Math.min(12, parseInt(extra.parcelas) || 1)) : 1;
      const inicio = extra.inicio || monthList[0];
      const startIdx = monthList.indexOf(inicio);
      if (startIdx === -1) { result[monthList[0]] += totalValor; continue; }
      const valorParcela = Math.floor(totalValor / parcelas);
      const resto = totalValor - valorParcela * parcelas;
      for (let i = 0; i < parcelas; i++) {
        const mIdx = startIdx + i;
        if (mIdx >= monthList.length) break;
        result[monthList[mIdx]] += valorParcela + (i === parcelas - 1 ? resto : 0);
      }
    }

    return result;
  }, [despGroups, excludes, payConfigs, monthList, extraRows]);

  // Total active despesas projected (using edited values)
  const totalDespActive = useMemo(() => {
    const realTotal = despGroups.filter((g) => !excludes.has(g.groupId)).reduce((s, g) => {
      const cfg = payConfigs[g.groupId];
      const v = cfg?.valor ? parseFloat(cfg.valor) : NaN;
      return s + (!isNaN(v) ? Math.round(v * 100) : g.totalValor);
    }, 0);
    const extraTotal = extraRows.reduce((s, r) => s + Math.round(r.valor * 100), 0);
    return realTotal + extraTotal;
  }, [despGroups, excludes, payConfigs, extraRows]);

  // Total active despesas real (original values, no edits)
  const totalDespRealActive = useMemo(() => {
    return despGroups.filter((g) => !excludes.has(g.groupId)).reduce((s, g) => s + g.totalValor, 0);
  }, [despGroups, excludes]);

  // Summary by ambiente — projected totals (derived from despGroups + payConfigs + extras)
  const summaryByAmbiente = useMemo(() => {
    const map = new Map<string, { real: number; proj: number }>();
    for (const g of despGroups) {
      const amb = g.ambiente || 'Sem Ambiente';
      if (!map.has(amb)) map.set(amb, { real: 0, proj: 0 });
      const entry = map.get(amb)!;
      entry.real += g.totalValor;
      if (!excludes.has(g.groupId)) {
        const cfg = payConfigs[g.groupId];
        const v = cfg?.valor ? parseFloat(cfg.valor) : NaN;
        entry.proj += !isNaN(v) ? Math.round(v * 100) : g.totalValor;
      }
    }
    for (const extra of extraRows) {
      const amb = extra.ambiente || 'Sem Ambiente';
      if (!map.has(amb)) map.set(amb, { real: 0, proj: 0 });
      map.get(amb)!.proj += Math.round(extra.valor * 100);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.proj - a.proj);
  }, [despGroups, excludes, payConfigs, extraRows]);

  // Summary by tipo — projected totals
  const summaryByTipo = useMemo(() => {
    const map = new Map<string, { real: number; proj: number }>();
    for (const g of despGroups) {
      const tipo = g.categoria || 'Outros';
      if (!map.has(tipo)) map.set(tipo, { real: 0, proj: 0 });
      const entry = map.get(tipo)!;
      entry.real += g.totalValor;
      if (!excludes.has(g.groupId)) {
        const cfg = payConfigs[g.groupId];
        const v = cfg?.valor ? parseFloat(cfg.valor) : NaN;
        entry.proj += !isNaN(v) ? Math.round(v * 100) : g.totalValor;
      }
    }
    for (const extra of extraRows) {
      const tipo = extra.categoria ? tipoLabel(extra.categoria) : 'Extras';
      if (!map.has(tipo)) map.set(tipo, { real: 0, proj: 0 });
      map.get(tipo)!.proj += Math.round(extra.valor * 100);
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.proj - a.proj);
  }, [despGroups, excludes, payConfigs, extraRows]);

  // Recebimentos summary
  const recSummary = useMemo(() => {
    return recebimentosPorTipo.map((r) => ({
      label: r.label,
      total: r.total,
    }));
  }, [recebimentosPorTipo]);

  // Compute tipo adjustments from tipoOverrides
  // Maps porTipo key → projected total from monthly groups (by matching labels)
  const labelToKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of TIPO_DESPESA_OPTIONS) map.set(o.label, o.value);
    return map;
  }, []);

  // Projected total per tipo key (from monthly groups + extras)
  const projByTipoKey = useMemo(() => {
    const result: Record<string, number> = {};
    for (const item of summaryByTipo) {
      const key = labelToKey.get(item.name) || item.name;
      result[key] = item.proj;
    }
    return result;
  }, [summaryByTipo, labelToKey]);

  // Total tipo adjustment = sum of (override - projected) for each tipo with override
  const tipoAdjustment = useMemo(() => {
    let total = 0;
    for (const [tipoKey, valStr] of Object.entries(tipoOverrides)) {
      if (!valStr) continue;
      const overrideVal = parseFloat(valStr);
      if (isNaN(overrideVal)) continue;
      const currentProj = projByTipoKey[tipoKey] ?? 0;
      total += Math.round(overrideVal * 100) - currentProj;
    }
    return total;
  }, [tipoOverrides, projByTipoKey]);

  const hasTipoOverrides = Object.values(tipoOverrides).some((v) => v !== '');

  // Real despesas distribution by month (original entry dates, all entries)
  const monthlyDespReal = useMemo(() => {
    const result: Record<string, number> = {};
    for (const m of monthList) result[m] = 0;
    for (const e of despEntries) {
      const m = toMonth(e.data);
      if (result[m] !== undefined) result[m] += e.valor;
    }
    return result;
  }, [despEntries, monthList]);

  // Real recebimentos distribution by month (original entry dates)
  const monthlyRecReal = useMemo(() => {
    const result: Record<string, number> = {};
    for (const m of monthList) result[m] = 0;
    for (const e of recEntries) {
      const m = toMonth(e.data);
      if (result[m] !== undefined) result[m] += e.valor;
    }
    return result;
  }, [recEntries, monthList]);

  // Build projection rows
  const rows = useMemo(() => {
    let saldoRealAcum = 0;
    let saldoProjAcum = 0;

    return monthList.map((month) => {
      const recReal = monthlyRecReal[month] ?? 0;
      const despReal = monthlyDespReal[month] ?? 0;

      const recProjStr = recDist[month] || '';
      const recProjVal = parseFloat(recProjStr);
      const recProj = isNaN(recProjVal) ? 0 : Math.round(recProjVal * 100);
      const despProj = monthlyDespProjected[month] ?? 0;

      saldoRealAcum += recReal - despReal;
      saldoProjAcum += recProj - despProj;

      return { month, recReal, recProj, despReal, despProj, saldoReal: saldoRealAcum, saldoProj: saldoProjAcum };
    });
  }, [monthList, monthlyRecReal, monthlyDespReal, recDist, monthlyDespProjected]);

  const totalRecProj = rows.reduce((s, r) => s + r.recProj, 0);
  const totalDespProj = rows.reduce((s, r) => s + r.despProj, 0);
  const saldoFinal = rows.length > 0 ? rows[rows.length - 1].saldoProj : 0;

  // Adjusted values incorporating tipo overrides
  const totalDespAdjusted = totalDespActive + tipoAdjustment;
  const saldoAdjusted = totalRecProj - totalDespAdjusted;

  // Distribute tipo adjustment proportionally across months for chart
  const rowsAdjusted = useMemo(() => {
    const totalProj = rows.reduce((s, r) => s + r.despProj, 0);
    let saldoAdj = 0;
    return rows.map((r) => {
      const share = totalProj > 0 ? r.despProj / totalProj : 1 / (rows.length || 1);
      const adjustedDesp = r.despProj + Math.round(tipoAdjustment * share);
      saldoAdj += r.recProj - adjustedDesp;
      return { ...r, despProjAdj: adjustedDesp, saldoProjAdj: saldoAdj };
    });
  }, [rows, tipoAdjustment]);

  const kpis = [
    { label: 'Total Recebimentos', value: totalRecProj, color: 'bg-green-50 text-green-700 border-green-200' },
    { label: 'Total Despesas', value: totalDespAdjusted, color: 'bg-orange-50 text-orange-700 border-orange-200', extra: tipoAdjustment !== 0 ? tipoAdjustment : undefined },
    { label: 'Saldo Final Projetado', value: saldoAdjusted, color: saldoAdjusted >= 0 ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-red-50 text-red-700 border-red-200' },
  ];

  const monthOptions = monthList.map((m) => ({ value: m, label: formatMonth(m) }));

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={`rounded-lg border p-3 ${kpi.color}`}>
            <p className="text-xs font-medium opacity-75">{kpi.label}</p>
            <p className="text-base font-bold mt-0.5">{formatCurrency(kpi.value / 100)}</p>
            {kpi.extra && (
              <p className={`text-[10px] mt-0.5 ${kpi.extra > 0 ? 'text-red-500' : 'text-green-600'}`}>
                Ajuste tipo: {kpi.extra > 0 ? '+' : ''}{formatCurrency(kpi.extra / 100)}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Resumo Rápido (collapsible) */}
      <div className="border rounded-lg overflow-hidden">
        <button
          onClick={() => setShowSummary(!showSummary)}
          className="w-full px-3 py-2 bg-gray-50 text-gray-700 flex items-center justify-between hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs">{showSummary ? '▼' : '▶'}</span>
            <h3 className="font-semibold text-sm">Simulação Rápida por Tipo</h3>
            {hasTipoOverrides && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-medium">Ajustes ativos</span>}
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-gray-500">Real: <span className="font-semibold">{formatCurrency(totalDespRealActive / 100)}</span></span>
            <span className="text-blue-700 font-semibold">Projetado: {formatCurrency(totalDespAdjusted / 100)}</span>
            {tipoAdjustment !== 0 && (
              <span className={`font-medium ${tipoAdjustment > 0 ? 'text-red-500' : 'text-green-600'}`}>
                ({tipoAdjustment > 0 ? '+' : ''}{formatCurrency(tipoAdjustment / 100)})
              </span>
            )}
          </div>
        </button>
        {showSummary && (
          <div className="p-3 space-y-3 border-t">
            {/* Recebimentos summary */}
            <div>
              <h4 className="text-xs font-semibold text-green-700 mb-1.5">Recebimentos</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {recSummary.map((r) => (
                  <div key={r.label} className="bg-green-50 rounded px-2.5 py-1.5 border border-green-100">
                    <p className="text-[10px] text-green-600 truncate">{r.label}</p>
                    <p className="text-xs font-semibold text-green-800">{formatCurrency(r.total / 100)}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Despesas por Tipo — editable */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <h4 className="text-xs font-semibold text-orange-700">Despesas por Tipo — Simulação Rápida</h4>
                {hasTipoOverrides && (
                  <button
                    onClick={() => { for (const k of Object.keys(tipoOverrides)) onTipoOverrideChange(k, ''); }}
                    className="text-[10px] text-orange-600 hover:text-orange-800 underline"
                  >Limpar ajustes de tipo</button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {porTipo.map((tipoCard) => {
                  const currentProj = projByTipoKey[tipoCard.key] ?? 0;
                  const overrideStr = tipoOverrides[tipoCard.key] || '';
                  const overrideVal = parseFloat(overrideStr);
                  const hasOverride = overrideStr !== '' && !isNaN(overrideVal);
                  const effectiveProj = hasOverride ? Math.round(overrideVal * 100) : currentProj;
                  const diff = effectiveProj - tipoCard.total;
                  const isExpanded = expandedTipos.has(tipoCard.key);
                  const hasDetails = tipoCard.ambientes.length > 0;

                  const toggleExpand = () => {
                    setExpandedTipos((prev) => {
                      const next = new Set(prev);
                      if (next.has(tipoCard.key)) next.delete(tipoCard.key);
                      else next.add(tipoCard.key);
                      return next;
                    });
                  };

                  return (
                    <div key={tipoCard.key} className={`border rounded-lg overflow-hidden shadow-sm transition-shadow ${hasOverride ? 'border-blue-300' : 'border-gray-200'} hover:shadow-md`}>
                      {/* Header — clickable */}
                      <button
                        type="button"
                        onClick={toggleExpand}
                        className={`w-full text-left px-3 py-2.5 flex items-start justify-between gap-2 transition-colors ${hasOverride ? 'bg-blue-50 hover:bg-blue-100/70' : 'bg-orange-50 hover:bg-orange-100/60'}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-gray-400 transition-transform" style={{ display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'none' }}>▶</span>
                            <span className="font-semibold text-sm text-gray-800 truncate">{tipoCard.label}</span>
                            {tipoCard.key === 'MAO_DE_OBRA' && <span className="text-[9px] bg-gray-200 text-gray-500 px-1 py-0.5 rounded">subcategorias</span>}
                          </div>
                          <div className="flex items-center gap-3 text-xs mt-1 ml-4">
                            <span className="text-gray-500">Real: <span className="font-semibold">{formatCurrency(tipoCard.total / 100)}</span></span>
                            <span className="text-gray-400">Proj: <span className="font-medium">{formatCurrency(currentProj / 100)}</span></span>
                          </div>
                        </div>
                        {hasOverride && diff !== 0 && (
                          <span className={`text-xs font-semibold whitespace-nowrap mt-0.5 ${diff > 0 ? 'text-red-500' : 'text-green-600'}`}>
                            {diff > 0 ? '▲' : '▼'} {formatCurrency(Math.abs(diff) / 100)}
                          </span>
                        )}
                      </button>

                      {/* Simulation input — always visible */}
                      <div className="px-3 py-1.5 border-t border-gray-100 bg-white">
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-gray-400 whitespace-nowrap">Simular:</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder={(currentProj / 100).toFixed(2)}
                            value={overrideStr}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onTipoOverrideChange(tipoCard.key, e.target.value)}
                            className={`flex-1 border rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-300 ${hasOverride ? 'border-blue-400 bg-blue-50 font-semibold' : 'border-gray-200'}`}
                          />
                          {hasOverride && (
                            <button
                              onClick={() => onTipoOverrideChange(tipoCard.key, '')}
                              className="text-gray-400 hover:text-red-500 text-xs"
                              title="Limpar"
                            >✕</button>
                          )}
                        </div>
                      </div>

                      {/* Expandable detail */}
                      {isExpanded && hasDetails && (
                        <div className="border-t border-gray-100 bg-gray-50/50 px-3 py-2">
                          <table className="w-full text-[10px]">
                            <thead>
                              <tr className="text-gray-400 border-b border-gray-200">
                                <th className="text-left py-1 font-medium">Ambiente</th>
                                <th className="text-right py-1 font-medium">Valor</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {tipoCard.ambientes.map((amb) => (
                                <React.Fragment key={amb.key}>
                                  <tr className="hover:bg-white/60">
                                    <td className="py-1 text-gray-600 font-medium">{amb.label}</td>
                                    <td className="py-1 text-right text-gray-600 font-medium">{formatCurrency(amb.total / 100)}</td>
                                  </tr>
                                  {tipoCard.key === 'MAO_DE_OBRA' && amb.categorias?.map((cat) => (
                                    <tr key={cat.key} className="text-gray-400 hover:bg-white/40">
                                      <td className="py-0.5 pl-4 text-[9px]">↳ {cat.label}</td>
                                      <td className="py-0.5 text-right text-[9px]">{formatCurrency(cat.total / 100)}</td>
                                    </tr>
                                  ))}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Resumo por Ambiente (read-only) */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 mb-1.5">Resumo por Ambiente</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
                {summaryByAmbiente.map((item) => {
                  const diff = item.proj - item.real;
                  return (
                    <div key={item.name} className="bg-gray-50 rounded px-2.5 py-1.5 border border-gray-200">
                      <p className="text-[10px] text-gray-500 truncate" title={item.name}>{item.name}</p>
                      <div className="flex items-baseline justify-between mt-0.5">
                        <span className="text-[10px] text-gray-400">Real: {formatCurrency(item.real / 100)}</span>
                        <span className="text-xs font-semibold text-gray-700">{formatCurrency(item.proj / 100)}</span>
                      </div>
                      {diff !== 0 && (
                        <p className={`text-[9px] text-right ${diff > 0 ? 'text-red-500' : 'text-green-600'}`}>
                          {diff > 0 ? '+' : ''}{formatCurrency(diff / 100)}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Despesas — grouped by categoria with checkboxes */}
      <div className="border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-orange-50 text-orange-800 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm">Despesas do Fluxo de Caixa</h3>
            <p className="text-[10px] opacity-70 mt-0.5">Dados reais (somente leitura). Use checkboxes para incluir/excluir da projeção.</p>
          </div>
          {hasDespChanges && (
            <button
              onClick={onResetDespesas}
              className="px-3 py-1 text-xs bg-white border border-orange-300 rounded hover:bg-orange-100 text-orange-700 font-medium"
            >
              🔄 Limpar Alterações
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Título</th>
                <th className="text-right px-3 py-1.5 font-medium text-gray-400 bg-gray-100/50">Valor Real</th>
                <th className="text-center px-3 py-1.5 font-medium text-gray-400 bg-gray-100/50">Pagto Real</th>
                <th className="text-center px-3 py-1.5 font-medium text-gray-400 bg-gray-100/50">Parc. Real</th>
                <th className="text-right px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Valor Proj.</th>
                <th className="text-center px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Pagto Proj.</th>
                <th className="text-center px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Parc. Proj.</th>
                <th className="text-center px-3 py-1.5 font-medium text-blue-700 bg-blue-50/30">Mês Início</th>
              </tr>
            </thead>
            <tbody>
              {categorias.map((cat) => (
                <React.Fragment key={cat.categoria}>
                  {/* Categoria header row */}
                  <tr className="bg-orange-50/60 border-t border-b">
                    <td colSpan={2} className="px-3 py-1.5 font-semibold text-orange-800 text-xs">
                      {cat.categoria}
                      <span className="ml-2 text-[10px] font-normal text-orange-500">({cat.groups.length} itens)</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold text-orange-800 text-xs bg-gray-100/30">
                      {formatCurrency(cat.total / 100)}
                    </td>
                    <td colSpan={2} className="bg-gray-100/30" />
                    <td className="px-3 py-1.5 text-right text-xs bg-blue-50/20">
                      {(() => {
                        const projTotal = cat.groups.reduce((s, g) => {
                          const c = payConfigs[g.groupId];
                          const v = c?.valor ? parseFloat(c.valor) : NaN;
                          return s + (!isNaN(v) ? Math.round(v * 100) : g.totalValor);
                        }, 0);
                        return <span className={`font-semibold ${projTotal !== cat.total ? 'text-blue-700' : 'text-orange-800'}`}>{formatCurrency(projTotal / 100)}</span>;
                      })()}
                    </td>
                    <td colSpan={3} className="bg-blue-50/20" />
                  </tr>
                  {/* Expense rows within categoria */}
                  {cat.groups.map((group) => {
                    const isExtra = group.groupId.startsWith('extra_');
                    const isExcluded = excludes.has(group.groupId);
                    const isExpanded = expandedGroups.has(group.groupId);
                    const cfg = payConfigs[group.groupId] || {
                      mode: isExtra ? 'avista' : (group.isMulti ? 'parcelado' : 'avista'),
                      parcelas: isExtra ? '1' : String(group.entries.length),
                      inicio: isExtra ? '' : toMonth(group.entries[0].data),
                      valor: '',
                    };

                    // Compute projected value for this group
                    const valorProjStr = cfg.valor;
                    const valorProjParsed = parseFloat(valorProjStr);
                    const valorProjetado = valorProjStr && !isNaN(valorProjParsed) ? Math.round(valorProjParsed * 100) : group.totalValor;
                    const hasValorChange = !isExtra && valorProjStr !== '' && !isNaN(valorProjParsed) && Math.round(valorProjParsed * 100) !== group.totalValor;
                    const deltaPercent = hasValorChange ? ((valorProjetado - group.totalValor) / group.totalValor * 100) : 0;

                    return (
                      <React.Fragment key={group.groupId}>
                        <tr className={`hover:bg-gray-50 border-b border-gray-100 ${isExcluded ? 'opacity-40' : ''} ${isExtra ? 'bg-purple-50/20' : ''}`}>
                          <td className="px-2 py-1.5 text-center">
                            {isExtra ? (
                              <button
                                onClick={() => onRemovePayConfig(group.groupId)}
                                className="text-red-400 hover:text-red-600 text-xs"
                                title="Remover"
                              >✕</button>
                            ) : (
                              <input
                                type="checkbox"
                                checked={!isExcluded}
                                onChange={() => onToggleExclude(group.groupId)}
                                className="rounded border-gray-300"
                              />
                            )}
                          </td>
                          <td className="px-3 py-1.5">
                            {isExtra ? (
                              <div>
                                <input
                                  value={cfg.titulo || ''}
                                  onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, titulo: e.target.value })}
                                  className="border rounded px-1 py-0.5 text-xs w-full font-medium"
                                  placeholder="Nome da despesa"
                                />
                                {group.ambiente && (
                                  <div className="text-[10px] text-gray-400 mt-0.5">{group.ambiente}</div>
                                )}
                              </div>
                            ) : (
                              <>
                                <div className="font-medium flex items-center gap-1">
                                  {group.isMulti && (
                                    <button
                                      onClick={() => setExpandedGroups((p) => {
                                        const next = new Set(p);
                                        if (next.has(group.groupId)) next.delete(group.groupId);
                                        else next.add(group.groupId);
                                        return next;
                                      })}
                                      className="text-gray-400 hover:text-gray-600"
                                    >
                                      {isExpanded ? '▼' : '▶'}
                                    </button>
                                  )}
                                  <span>{group.titulo || group.categoria}</span>
                                </div>
                                {(group.fornecedor || group.ambiente) && (
                                  <div className="text-[10px] text-gray-400 mt-0.5">
                                    {[group.fornecedor, group.ambiente].filter(Boolean).join(' · ')}
                                  </div>
                                )}
                              </>
                            )}
                          </td>
                          {/* === REAL columns (read-only, gray bg) === */}
                          <td className="px-3 py-1.5 text-right text-gray-500 bg-gray-50/50">
                            {isExtra ? <span className="text-gray-300">—</span> : formatCurrency(group.totalValor / 100)}
                          </td>
                          <td className="px-3 py-1.5 text-center text-gray-500 bg-gray-50/50 text-[10px]">
                            {isExtra ? <span className="text-gray-300">—</span> : (group.formaPagamento === 'PARCELADO' ? 'Parcelado' : group.formaPagamento === 'QUINZENAL' ? 'Quinzenal' : 'À Vista')}
                          </td>
                          <td className="px-3 py-1.5 text-center text-gray-500 bg-gray-50/50 text-[10px]">
                            {isExtra ? <span className="text-gray-300">—</span> : `${group.entries.length}x`}
                          </td>
                          {/* === PROJETADO columns (editable, blue tint) === */}
                          <td className="px-3 py-1.5 text-right bg-blue-50/20">
                            <div className="flex flex-col items-end gap-0.5">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder={(group.totalValor / 100).toFixed(2)}
                                value={cfg.valor}
                                onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, valor: e.target.value })}
                                className={`w-24 border rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-300 ${hasValorChange ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white'}`}
                                disabled={isExcluded}
                              />
                              {hasValorChange && (
                                <span className={`text-[9px] font-medium ${deltaPercent > 0 ? 'text-red-500' : 'text-green-600'}`}>
                                  {deltaPercent > 0 ? '↑' : '↓'} {Math.abs(deltaPercent).toFixed(0)}%
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-center bg-blue-50/20">
                            <select
                              value={cfg.mode}
                              onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, mode: e.target.value, parcelas: e.target.value === 'avista' ? '1' : cfg.parcelas })}
                              className="border rounded px-1 py-0.5 text-xs bg-white"
                              disabled={isExcluded}
                            >
                              <option value="avista">À Vista</option>
                              <option value="parcelado">Parcelado</option>
                            </select>
                          </td>
                          <td className="px-3 py-1.5 text-center bg-blue-50/20">
                            {cfg.mode === 'parcelado' ? (
                              <select
                                value={cfg.parcelas}
                                onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, parcelas: e.target.value })}
                                className="border rounded px-1 py-0.5 text-xs bg-white w-14"
                                disabled={isExcluded}
                              >
                                {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                                  <option key={n} value={String(n)}>{n}x</option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-gray-400">1x</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-center bg-blue-50/20">
                            <select
                              value={cfg.inicio || (group.entries.length > 0 ? toMonth(group.entries[0].data) : monthList[0])}
                              onChange={(e) => onPayConfigChange(group.groupId, { ...cfg, inicio: e.target.value })}
                              className="border rounded px-1 py-0.5 text-xs bg-white"
                              disabled={isExcluded}
                            >
                              {monthOptions.map((mo) => (
                                <option key={mo.value} value={mo.value}>{mo.label}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                        {/* Expanded installment rows */}
                        {isExpanded && !isExtra && group.entries.map((entry, idx) => (
                          <tr key={entry.id} className="bg-gray-50/50">
                            <td />
                            <td className="px-3 py-1 pl-8 text-gray-500">
                              ↳ Parcela {entry.parcela || `${idx + 1}/${group.entries.length}`}
                              <span className="ml-2 text-gray-400">{new Date(entry.data).toLocaleDateString('pt-BR')}</span>
                            </td>
                            <td className="px-3 py-1 text-right text-gray-500 bg-gray-50/50">{formatCurrency(entry.valor / 100)}</td>
                            <td colSpan={2} className="bg-gray-50/50" />
                            <td colSpan={4} className="bg-blue-50/10" />
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              ))}

              {/* Inline add extra row */}
              {showAddExtra && (
                <tr className="border-t bg-purple-50/30">
                  <td className="px-2 py-1.5 text-center">
                    <button onClick={() => { setShowAddExtra(false); setNewExtra({ titulo: '', valor: '', mode: 'avista', parcelas: '1', inicio: '', categoria: '', subcategoria: '', ambiente: '' }); }}
                      className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
                  </td>
                  <td className="px-3 py-1.5" colSpan={4}>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <input value={newExtra.titulo} onChange={(e) => setNewExtra((p) => ({ ...p, titulo: e.target.value }))}
                        className="border rounded px-1.5 py-0.5 text-xs flex-1 min-w-[120px]" placeholder="Nome da despesa" autoFocus />
                      <select value={newExtra.categoria} onChange={(e) => setNewExtra((p) => ({ ...p, categoria: e.target.value, subcategoria: '' }))}
                        className="border rounded px-1 py-0.5 text-xs bg-white">
                        <option value="">Tipo...</option>
                        {TIPO_DESPESA_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                      </select>
                      {newExtra.categoria === 'MAO_DE_OBRA' && (
                        <select value={newExtra.subcategoria} onChange={(e) => setNewExtra((p) => ({ ...p, subcategoria: e.target.value }))}
                          className="border rounded px-1 py-0.5 text-xs bg-white">
                          <option value="">Categoria...</option>
                          {CATEGORIA_MAO_DE_OBRA_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                        </select>
                      )}
                      <input value={newExtra.ambiente} onChange={(e) => setNewExtra((p) => ({ ...p, ambiente: e.target.value }))}
                        className="border rounded px-1 py-0.5 text-xs w-24" placeholder="Ambiente" />
                    </div>
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    <input type="number" value={newExtra.valor} onChange={(e) => setNewExtra((p) => ({ ...p, valor: e.target.value }))}
                      className="border rounded px-1 py-0.5 text-xs w-20 text-right" placeholder="0,00" step="0.01" />
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    <select value={newExtra.mode} onChange={(e) => setNewExtra((p) => ({ ...p, mode: e.target.value }))}
                      className="border rounded px-1 py-0.5 text-xs bg-white">
                      <option value="avista">À Vista</option>
                      <option value="parcelado">Parcelado</option>
                    </select>
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    {newExtra.mode === 'parcelado' ? (
                      <select value={newExtra.parcelas} onChange={(e) => setNewExtra((p) => ({ ...p, parcelas: e.target.value }))}
                        className="border rounded px-1 py-0.5 text-xs bg-white">
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (<option key={n} value={String(n)}>{n}x</option>))}
                      </select>
                    ) : <span className="text-gray-400">1x</span>}
                  </td>
                  <td className="px-3 py-1.5 bg-blue-50/20">
                    <div className="flex items-center gap-1">
                      <select value={newExtra.inicio} onChange={(e) => setNewExtra((p) => ({ ...p, inicio: e.target.value }))}
                        className="border rounded px-1 py-0.5 text-xs bg-white">
                        <option value="">Mês...</option>
                        {monthOptions.map((mo) => (<option key={mo.value} value={mo.value}>{mo.label}</option>))}
                      </select>
                      <button
                        onClick={() => {
                          if (!newExtra.titulo || !newExtra.valor || !newExtra.inicio) return;
                          const id = `extra_${Date.now()}`;
                          onPayConfigChange(id, {
                            mode: newExtra.mode,
                            parcelas: newExtra.parcelas,
                            inicio: newExtra.inicio,
                            valor: newExtra.valor,
                            titulo: newExtra.titulo,
                            categoria: newExtra.categoria,
                            subcategoria: newExtra.subcategoria,
                            ambiente: newExtra.ambiente,
                          });
                          setNewExtra({ titulo: '', valor: '', mode: 'avista', parcelas: '1', inicio: '', categoria: '', subcategoria: '', ambiente: '' });
                          setShowAddExtra(false);
                        }}
                        disabled={!newExtra.titulo || !newExtra.valor || !newExtra.inicio}
                        className="bg-purple-600 text-white px-2 py-0.5 rounded text-xs hover:bg-purple-700 disabled:opacity-40"
                      >✓</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-gray-50 border-t">
              <tr className="font-semibold">
                <td className="px-2 py-1.5 text-center text-[10px] text-gray-400">
                  {despGroups.filter((g) => !excludes.has(g.groupId)).length}/{despGroups.length}{extraRows.length > 0 ? `+${extraRows.length}` : ''}
                </td>
                <td className="px-3 py-1.5">Total</td>
                <td className="px-3 py-1.5 text-right text-gray-500 bg-gray-100/50">{formatCurrency(totalDespRealActive / 100)}</td>
                <td colSpan={2} className="bg-gray-100/50" />
                <td className="px-3 py-1.5 text-right font-bold text-blue-700 bg-blue-50/20">{formatCurrency(totalDespActive / 100)}</td>
                <td colSpan={3} className="bg-blue-50/20" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Add extra button */}
      {!showAddExtra && (
        <button
          onClick={() => setShowAddExtra(true)}
          className="w-full border-2 border-dashed border-purple-300 rounded-lg py-2 text-purple-600 text-sm hover:bg-purple-50 hover:border-purple-400 transition-colors"
        >
          + Adicionar despesa projetada
        </button>
      )}

      {/* Recebimentos — distribuição por mês */}
      <div className="border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-green-50 text-green-800 flex items-center justify-between">
          <h3 className="font-semibold text-sm">Recebimentos — Distribuição Mensal</h3>
          <div className="text-xs">
            <span className="font-medium">Disponível: {formatCurrency(totalRecReal / 100)}</span>
            <span className="mx-2">|</span>
            <span className="font-medium">Distribuído: {formatCurrency(totalRecDistributed / 100)}</span>
            <span className="mx-2">|</span>
            <span className={`font-bold ${recRemaining >= 0 ? 'text-green-700' : 'text-red-600'}`}>
              Restante: {formatCurrency(recRemaining / 100)}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-4 md:grid-cols-6 gap-2 p-3">
          {monthList.map((month) => (
            <div key={month} className="text-center">
              <label className="text-[10px] font-medium text-gray-500 block">{formatMonth(month)}</label>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="0"
                value={recDist[month] ?? ''}
                onChange={(e) => onRecDistChange(month, e.target.value)}
                className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-green-300 mt-0.5"
              />
            </div>
          ))}
        </div>
        {recRemaining < 0 && (
          <div className="px-3 pb-2">
            <p className="text-xs text-red-600 font-medium">⚠️ Valor distribuído excede o total em {formatCurrency(Math.abs(recRemaining) / 100)}</p>
          </div>
        )}
      </div>

      {/* Chart 1: Saldo Acumulado */}
      <div className="border rounded-lg p-4 bg-white">
        <h4 className="text-sm font-semibold text-gray-700 mb-3">Saldo Acumulado — Real vs Projetado</h4>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={rowsAdjusted.map((r) => ({
            month: formatMonth(r.month),
            'Saldo Real': r.saldoReal / 100,
            'Saldo Projetado': (r.saldoProjAdj) / 100,
          }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(value: number) => formatCurrency(value)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="#666" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="Saldo Real" stroke="#6b7280" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="Saldo Projetado" stroke="#2563eb" strokeWidth={2.5} dot={false} strokeDasharray="5 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Chart 2: Despesas por Mês */}
      <div className="border rounded-lg p-4 bg-white">
        <h4 className="text-sm font-semibold text-gray-700 mb-3">Despesas por Mês — Projetado</h4>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rowsAdjusted.map((r) => ({
            month: formatMonth(r.month),
            'Despesas Projetadas': (r.despProjAdj) / 100,
            'Despesas Reais': r.despReal / 100,
          }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(value: number) => formatCurrency(value)} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="Despesas Reais" fill="#fdba74" />
            <Bar dataKey="Despesas Projetadas" fill="#f97316" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Projection Table */}
      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-600 sticky left-0 bg-gray-50">Mês</th>
                <th className="text-right px-3 py-2 font-medium text-green-700">Receb. Real</th>
                <th className="text-right px-3 py-2 font-medium text-green-700">Receb. Proj.</th>
                <th className="text-right px-3 py-2 font-medium text-orange-700">Desp. Real</th>
                <th className="text-right px-3 py-2 font-medium text-orange-700">Desp. Proj.</th>
                <th className="text-right px-3 py-2 font-medium text-gray-700">Saldo Acum. Real</th>
                <th className="text-right px-3 py-2 font-medium text-blue-700">Saldo Acum. Proj.</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rowsAdjusted.map((row) => (
                <tr key={row.month} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 font-medium sticky left-0 bg-white">{formatMonth(row.month)}</td>
                  <td className="px-3 py-1.5 text-right text-green-700">{formatCurrency(row.recReal / 100)}</td>
                  <td className="px-3 py-1.5 text-right text-green-600 font-medium">{formatCurrency(row.recProj / 100)}</td>
                  <td className="px-3 py-1.5 text-right text-orange-700">{formatCurrency(row.despReal / 100)}</td>
                  <td className="px-3 py-1.5 text-right text-orange-600 font-medium">{formatCurrency((row.despProjAdj) / 100)}</td>
                  <td className={`px-3 py-1.5 text-right font-medium ${row.saldoReal >= 0 ? 'text-gray-700' : 'text-red-600'}`}>
                    {formatCurrency(row.saldoReal / 100)}
                  </td>
                  <td className={`px-3 py-1.5 text-right font-bold ${(row.saldoProjAdj) >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                    {formatCurrency((row.saldoProjAdj) / 100)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 border-t font-semibold">
              <tr>
                <td className="px-3 py-2 sticky left-0 bg-gray-50">Total</td>
                <td className="px-3 py-2 text-right text-green-700">{formatCurrency(rows.reduce((s, r) => s + r.recReal, 0) / 100)}</td>
                <td className="px-3 py-2 text-right text-green-700">{formatCurrency(totalRecProj / 100)}</td>
                <td className="px-3 py-2 text-right text-orange-700">{formatCurrency(rows.reduce((s, r) => s + r.despReal, 0) / 100)}</td>
                <td className="px-3 py-2 text-right text-orange-700">{formatCurrency(totalDespAdjusted / 100)}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(rows.length > 0 ? rows[rows.length - 1].saldoReal / 100 : 0)}</td>
                <td className={`px-3 py-2 text-right font-bold ${saldoAdjusted >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                  {formatCurrency(saldoAdjusted / 100)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
