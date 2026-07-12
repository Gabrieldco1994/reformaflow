'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api as defaultApi } from '@/lib/api';
import type { Scenario, SimulationData, SimValues, PayConfig } from '../_types';
import { SAVE_DEBOUNCE_MS } from '../_types';

type ApiClient = Pick<typeof defaultApi, 'get' | 'post' | 'patch' | 'delete' | 'put'>;

export interface UseSimulationScenariosParams {
  projectId: string;
  /** Injeção de dependência para teste — default é o client real (`@/lib/api`). */
  api?: ApiClient;
}

/**
 * Toda a lógica de cenários da Simulação (Fase G): CRUD de cenários (criar,
 * renomear, excluir, duplicar), estado dos valores simulados, e o
 * autosave debounced com troca de cenário segura.
 *
 * Extraído de `simulation/page.tsx` (461 linhas, acima do limite de 400) —
 * zero mudança de comportamento, apenas decomposição presentation-only.
 *
 * Invariante preservada (bug já documentado): trocar de cenário DEVE
 * descarregar (flush) o save pendente sob o scenarioId ANTIGO antes de
 * carregar o novo — senão a edição do cenário A pode ser gravada por engano
 * sob o cenário B (perda de dado). Por isso `scheduleSave`/`switchScenario`
 * usam o id capturado no momento do agendamento (`pendingSaveScenarioId`),
 * não o `activeScenarioId` corrente no momento do flush.
 */
export function useSimulationScenarios({ projectId, api = defaultApi }: UseSimulationScenariosParams) {
  const queryClient = useQueryClient();
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);

  // Load scenarios
  const { data: scenarios, isLoading: scenariosLoading } = useQuery<Scenario[]>({
    queryKey: ['simulation-scenarios', projectId],
    queryFn: () => api.get(`/projects/${projectId}/simulation/scenarios`),
  });

  // Auto-select first scenario only on initial load (do not auto-switch).
  useEffect(() => {
    if (scenarios && scenarios.length > 0 && !activeScenarioId) {
      setActiveScenarioId(scenarios[0].id);
    }
  }, [scenarios, activeScenarioId]);

  // Load simulation data for active scenario
  const { data, isLoading, error } = useQuery<SimulationData>({
    queryKey: ['simulation', projectId, activeScenarioId],
    queryFn: () => api.get(`/projects/${projectId}/simulation${activeScenarioId ? `?scenarioId=${activeScenarioId}` : ''}`),
    enabled: !!activeScenarioId,
  });

  // Scenario mutations
  const createMut = useMutation({
    mutationFn: (name: string) => api.post<Scenario>(`/projects/${projectId}/simulation/scenarios`, { name }),
    onSuccess: (newScenario) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', projectId] });
      void switchScenario(newScenario.id);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch(`/projects/${projectId}/simulation/scenarios/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', projectId] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/simulation/scenarios/${id}`),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', projectId] });
      if (activeScenarioId === deletedId) setActiveScenarioId(null);
    },
  });

  const duplicateMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) =>
      api.post<Scenario>(`/projects/${projectId}/simulation/scenarios/${id}/duplicate`, { name }),
    onSuccess: (newScenario) => {
      queryClient.invalidateQueries({ queryKey: ['simulation-scenarios', projectId] });
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
  // Id do cenário capturado no momento do último `scheduleSave` — é o que
  // `switchScenario` deve descarregar, mesmo que `activeScenarioId` já tenha
  // mudado por outro caminho antes do flush.
  const pendingSaveScenarioId = useRef<string | null>(null);

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
      await api.put(`/projects/${projectId}/simulation/scenarios/${sid}/values`, { values: vals });
      // Only clear dirty if the saved scenario is still the active one. If the user
      // switched scenarios mid-flight, the new scenario may legitimately be dirty.
      if (sid === activeScenarioIdRef.current) setDirty(false);
    } catch (e) {
      console.error('Erro ao salvar simulação:', e);
    }
    setSaving(false);
  }, [projectId, api]);

  const scheduleSave = useCallback((scenarioId?: string) => {
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Capture the scenarioId at schedule time (explicit param, falling back to the
    // current active scenario). If the user switches scenarios before the debounce
    // fires, `switchScenario` will flush this pending save first using the captured
    // id (so we don't write current-state into the wrong scenario).
    const sid = scenarioId ?? activeScenarioIdRef.current;
    pendingSaveScenarioId.current = sid;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      pendingSaveScenarioId.current = null;
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
      const prevId = pendingSaveScenarioId.current;
      pendingSaveScenarioId.current = null;
      if (prevId) await doSave(prevId);
    }
    setActiveScenarioId(newId);
  }, [doSave]);

  return {
    scenarios,
    scenariosLoading,
    activeScenarioId,
    setActiveScenarioId,
    data,
    isLoading,
    error,
    createMut,
    renameMut,
    deleteMut,
    duplicateMut,
    simRecebimentos,
    setSimRecebimentos,
    simDespesas,
    setSimDespesas,
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
  };
}
