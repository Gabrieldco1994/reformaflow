'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isNeutralExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { useProject } from '@/contexts/project-context';
import type { MonthlyOverviewResponse } from '../../monthly/_types';
import { getExpenseOptions } from '../../expenses/_types';
import {
  buildCaixaData,
  buildComprometimentoFuturo,
  deriveCockpitTop,
  mediaMensalPorCodigo,
} from '../../monthly/_cockpit/derive';
import { mesCurto } from '../../monthly/_cockpit/format';
import type {
  PlanningAssumptions,
  PlanningCommitmentRow,
  PlanningExpenseTypeRow,
  PlanningMatrixExpenseRow,
  PlanningProjectionRow,
  PlanningScenario,
  PlanningScenarioOption,
  PlanningSummary,
} from '../_types';

const STORAGE_VERSION = 2;
const DEFAULT_SCENARIO_NAME = 'Planning Principal';

const PERSONAL_EXPENSE_OPTIONS = getExpenseOptions('PESSOAL')
  .map((option) => ({ value: String(option.value), label: option.label }))
  .filter((option) => !isNeutralExpenseType(option.value));

const PERSONAL_EXPENSE_LABEL_BY_CODE: Map<string, string> = new Map(
  PERSONAL_EXPENSE_OPTIONS.map((option) => [option.value, option.label] as const),
);

const DEFAULT_EXPENSE_TYPE_MAP: Record<string, number> = Object.fromEntries(
  PERSONAL_EXPENSE_OPTIONS.map((option) => [option.value, 0]),
);

interface StoredPlanningState {
  version: number;
  activeScenarioId: string;
  scenarios: PlanningScenario[];
}

interface UsePersonalPlanningResult {
  isPersonal: boolean;
  isLoading: boolean;
  error: Error | null;
  assumptions: PlanningAssumptions | null;
  projection: PlanningProjectionRow[];
  summary: PlanningSummary | null;
  commitments: PlanningCommitmentRow[];
  expenseTypes: PlanningExpenseTypeRow[];
  scenarios: PlanningScenarioOption[];
  activeScenarioId: string | null;
  months: string[];
  incomeByMonthCents: Record<string, number>;
  expenseMatrixRows: PlanningMatrixExpenseRow[];
  addableExpenseTypes: Array<{ value: string; label: string }>;
  patchAssumptions: (patch: Partial<PlanningAssumptions>) => void;
  createScenario: (name?: string) => void;
  duplicateScenario: (name?: string) => void;
  renameScenario: (name: string) => void;
  deleteScenario: () => void;
  switchScenario: (scenarioId: string) => void;
  addMonth: () => void;
  setIncomeForMonth: (monthKey: string, cents: number) => void;
  setExpenseForMonth: (monthKey: string, typeCode: string, cents: number) => void;
  addExpenseType: (typeCode: string) => void;
  /** Média mensal (÷12) por código de tipo, dos gastos reais — base do preenchimento. */
  averageByCodeCents: Record<string, number>;
  /** Preenche os meses informados com a média histórica de cada categoria. */
  fillMonthsWithAverage: (monthKeys: string[]) => void;
  /** Zera todas as entradas e despesas do cenário ativo (mantém meses e categorias). */
  clearAll: () => void;
}

function addMonths(monthKey: string, delta: number): string {
  const [yearRaw, monthRaw] = monthKey.split('-').map((n) => Number.parseInt(n, 10));
  const date = new Date(Date.UTC(yearRaw || 1970, (monthRaw || 1) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(monthKey: string): string {
  const [yearRaw, monthRaw] = monthKey.split('-').map((n) => Number.parseInt(n, 10));
  return `${mesCurto((monthRaw || 1) - 1)}/${String(yearRaw || 0).slice(-2)}`;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function sumExpenseByTypeCents(expenseByType: Record<string, number>): number {
  return Object.values(expenseByType).reduce((sum, value) => sum + value, 0);
}

function buildMonthRange(startMonth: string, count: number): string[] {
  const safeCount = Math.max(1, Math.round(count));
  return Array.from({ length: safeCount }, (_, index) => addMonths(startMonth, index));
}

function sortMonthKeys(months: string[]): string[] {
  return [...months].sort((a, b) => a.localeCompare(b));
}

function normalizeExpenseTypeOrder(order: unknown): string[] {
  const source = Array.isArray(order)
    ? order.filter((item): item is string => typeof item === 'string')
    : [];
  const merged = dedupe([
    ...PERSONAL_EXPENSE_OPTIONS.map((option) => option.value),
    ...source,
  ]);
  return merged.filter((typeCode) => !isNeutralExpenseType(typeCode));
}

function normalizeExpenseByTypeCents(
  candidate: unknown,
  fallback: Record<string, number>,
): Record<string, number> {
  const normalized: Record<string, number> = {};
  const candidateMap =
    candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};

  for (const [typeCode, fallbackValue] of Object.entries(fallback)) {
    const candidateValue = candidateMap[typeCode];
    normalized[typeCode] = Math.max(0, Math.round(toNumber(candidateValue, fallbackValue)));
  }

  for (const [typeCode, candidateValue] of Object.entries(candidateMap)) {
    if (normalized[typeCode] !== undefined) continue;
    if (isNeutralExpenseType(typeCode)) continue;
    normalized[typeCode] = Math.max(0, Math.round(toNumber(candidateValue, 0)));
  }

  return normalized;
}

function sanitizeAssumptions(
  candidate: Partial<PlanningAssumptions>,
  fallback: PlanningAssumptions,
): PlanningAssumptions {
  const monthsAhead = Math.round(toNumber(candidate.monthsAhead, fallback.monthsAhead));
  const monthlyIncomeCents = Math.round(
    toNumber(candidate.monthlyIncomeCents, fallback.monthlyIncomeCents),
  );
  const targetMonthlySurplusCents = Math.round(
    toNumber(candidate.targetMonthlySurplusCents, fallback.targetMonthlySurplusCents),
  );
  const incomeGrowthPct = toNumber(candidate.incomeGrowthPct, fallback.incomeGrowthPct);
  const expenseGrowthPct = toNumber(candidate.expenseGrowthPct, fallback.expenseGrowthPct);
  const expenseByTypeCents = normalizeExpenseByTypeCents(
    candidate.expenseByTypeCents,
    fallback.expenseByTypeCents,
  );

  return {
    monthsAhead: clamp(monthsAhead, 3, 36),
    monthlyIncomeCents: Math.max(0, monthlyIncomeCents),
    monthlyExpenseCents: sumExpenseByTypeCents(expenseByTypeCents),
    incomeGrowthPct: clamp(Number(incomeGrowthPct.toFixed(2)), -10, 25),
    expenseGrowthPct: clamp(Number(expenseGrowthPct.toFixed(2)), -10, 25),
    targetMonthlySurplusCents: Math.max(0, targetMonthlySurplusCents),
    expenseByTypeCents,
  };
}

/**
 * Assumptions ZERADAS para um planning novo (botão "+ Novo"): nenhuma receita,
 * nenhuma despesa, sem metas nem crescimento. Mantém a estrutura (grade de meses
 * via `monthsAhead` e as linhas de tipo de despesa via `DEFAULT_EXPENSE_TYPE_MAP`,
 * todas em zero) para o usuário preencher do zero.
 */
export function buildEmptyAssumptions(monthsAhead = 12): PlanningAssumptions {
  return {
    monthsAhead: clamp(Math.round(monthsAhead), 3, 36),
    monthlyIncomeCents: 0,
    monthlyExpenseCents: 0,
    incomeGrowthPct: 0,
    expenseGrowthPct: 0,
    targetMonthlySurplusCents: 0,
    expenseByTypeCents: { ...DEFAULT_EXPENSE_TYPE_MAP },
  };
}

function buildDefaultAssumptions(data: MonthlyOverviewResponse): PlanningAssumptions {
  const sorted = [...data.meses].sort((a, b) => a.mes.localeCompare(b.mes));
  const currentIndex = sorted.findIndex((row) => row.mes === data.mesAtual);
  const currentRow = currentIndex >= 0 ? sorted[currentIndex] : sorted[sorted.length - 1];
  const historicalWindow =
    currentIndex > 0
      ? sorted.slice(Math.max(0, currentIndex - 6), currentIndex)
      : sorted.slice(-6);
  const historical = historicalWindow.filter(
    (row) => row.totalRecebimentos > 0 || row.totalDespesas > 0,
  );

  const incomeBase =
    Math.round(average(historical.map((row) => row.totalRecebimentos).filter((value) => value > 0))) ||
    currentRow?.totalRecebimentos ||
    0;
  const expenseBase =
    Math.round(average(historical.map((row) => row.totalDespesas).filter((value) => value > 0))) ||
    currentRow?.totalDespesas ||
    0;

  const historicalMonthKeys = new Set(historicalWindow.map((row) => row.mes));
  const divisor = Math.max(historicalMonthKeys.size, 1);
  const expenseByTypeCents: Record<string, number> = { ...DEFAULT_EXPENSE_TYPE_MAP };

  for (const entry of data.entries ?? []) {
    if (entry.tipo !== 'DESPESA') continue;
    if (entry.projectType !== 'PESSOAL') continue;
    if (entry.isEspelho) continue;

    const typeCode = entry.categoriaCodigo ?? '';
    if (!typeCode || isNeutralExpenseType(typeCode)) continue;

    const monthKey = (entry.data ?? '').slice(0, 7);
    if (!historicalMonthKeys.has(monthKey)) continue;

    expenseByTypeCents[typeCode] = (expenseByTypeCents[typeCode] ?? 0) + entry.valor;
  }

  for (const typeCode of Object.keys(expenseByTypeCents)) {
    expenseByTypeCents[typeCode] = Math.round(expenseByTypeCents[typeCode]! / divisor);
  }

  if (sumExpenseByTypeCents(expenseByTypeCents) <= 0 && expenseBase > 0) {
    const fallbackType = expenseByTypeCents.OUTROS !== undefined
      ? 'OUTROS'
      : (Object.keys(expenseByTypeCents)[0] ?? 'OUTROS');
    expenseByTypeCents[fallbackType] = expenseBase;
  }

  const monthlyExpenseCents = sumExpenseByTypeCents(expenseByTypeCents);
  const targetBase = Math.max(0, Math.round((incomeBase - expenseBase) * 0.5));

  return {
    monthsAhead: 12,
    monthlyIncomeCents: Math.max(0, incomeBase),
    monthlyExpenseCents,
    incomeGrowthPct: 0,
    expenseGrowthPct: 0,
    targetMonthlySurplusCents: targetBase,
    expenseByTypeCents,
  };
}

function sumMonthExpense(
  expenseByTypeByMonthCents: Record<string, Record<string, number>>,
  monthKey: string,
  typeOrder: string[],
): number {
  const row = expenseByTypeByMonthCents[monthKey] ?? {};
  return typeOrder.reduce((sum, typeCode) => sum + (row[typeCode] ?? 0), 0);
}

function touchScenario(scenario: PlanningScenario): PlanningScenario {
  return { ...scenario, updatedAt: new Date().toISOString() };
}

function withDerivedAssumptions(scenario: PlanningScenario): PlanningScenario {
  const monthCount = Math.max(scenario.months.length, 1);
  const incomeTotal = scenario.months.reduce(
    (sum, monthKey) => sum + (scenario.incomeByMonthCents[monthKey] ?? 0),
    0,
  );
  const expenseTotal = scenario.months.reduce(
    (sum, monthKey) =>
      sum + sumMonthExpense(scenario.expenseByTypeByMonthCents, monthKey, scenario.expenseTypeOrder),
    0,
  );

  const monthlyIncomeCents = scenario.months.length
    ? Math.round(incomeTotal / monthCount)
    : scenario.assumptions.monthlyIncomeCents;
  const monthlyExpenseCents = scenario.months.length
    ? Math.round(expenseTotal / monthCount)
    : scenario.assumptions.monthlyExpenseCents;

  const expenseByTypeCents: Record<string, number> = {};
  for (const typeCode of scenario.expenseTypeOrder) {
    const typeTotal = scenario.months.reduce(
      (sum, monthKey) =>
        sum + (scenario.expenseByTypeByMonthCents[monthKey]?.[typeCode] ?? 0),
      0,
    );
    expenseByTypeCents[typeCode] = scenario.months.length
      ? Math.round(typeTotal / monthCount)
      : scenario.assumptions.expenseByTypeCents[typeCode] ?? 0;
  }

  const assumptions: PlanningAssumptions = {
    monthsAhead: scenario.months.length,
    monthlyIncomeCents: Math.max(0, monthlyIncomeCents),
    monthlyExpenseCents: Math.max(0, monthlyExpenseCents),
    incomeGrowthPct: clamp(Number(scenario.assumptions.incomeGrowthPct.toFixed(2)), -10, 25),
    expenseGrowthPct: clamp(Number(scenario.assumptions.expenseGrowthPct.toFixed(2)), -10, 25),
    targetMonthlySurplusCents: Math.max(0, scenario.assumptions.targetMonthlySurplusCents),
    expenseByTypeCents,
  };

  return { ...scenario, assumptions };
}

/**
 * Zera TODOS os valores de um cenário: entradas e despesas de cada categoria em
 * todos os meses. Mantém a grade de meses e a ordem/estrutura de categorias
 * (apenas apaga os números). Os derivados (assumptions) são recomputados.
 */
export function clearScenarioValues(scenario: PlanningScenario): PlanningScenario {
  const incomeByMonthCents: Record<string, number> = {};
  for (const monthKey of scenario.months) incomeByMonthCents[monthKey] = 0;

  const expenseByTypeByMonthCents: Record<string, Record<string, number>> = {};
  for (const monthKey of scenario.months) {
    const row: Record<string, number> = {};
    for (const typeCode of scenario.expenseTypeOrder) row[typeCode] = 0;
    expenseByTypeByMonthCents[monthKey] = row;
  }

  return withDerivedAssumptions({
    ...scenario,
    updatedAt: new Date().toISOString(),
    incomeByMonthCents,
    expenseByTypeByMonthCents,
  });
}

export function createScenarioFromAssumptions(
  name: string,
  assumptions: PlanningAssumptions,
  startMonth: string,
  id = createId('planning'),
): PlanningScenario {
  const expenseTypeOrder = normalizeExpenseTypeOrder(Object.keys(assumptions.expenseByTypeCents));
  const months = buildMonthRange(startMonth, assumptions.monthsAhead);
  const incomeByMonthCents: Record<string, number> = {};
  const expenseByTypeByMonthCents: Record<string, Record<string, number>> = {};

  for (const [index, monthKey] of months.entries()) {
    const incomeGrowth = Math.pow(1 + assumptions.incomeGrowthPct / 100, index);
    const expenseGrowth = Math.pow(1 + assumptions.expenseGrowthPct / 100, index);
    incomeByMonthCents[monthKey] = Math.max(
      0,
      Math.round(assumptions.monthlyIncomeCents * incomeGrowth),
    );

    const row: Record<string, number> = {};
    for (const typeCode of expenseTypeOrder) {
      const base = assumptions.expenseByTypeCents[typeCode] ?? 0;
      row[typeCode] = Math.max(0, Math.round(base * expenseGrowth));
    }
    expenseByTypeByMonthCents[monthKey] = row;
  }

  const now = new Date().toISOString();
  return withDerivedAssumptions({
    id,
    name,
    createdAt: now,
    updatedAt: now,
    assumptions,
    months,
    incomeByMonthCents,
    expenseByTypeByMonthCents,
    expenseTypeOrder,
  });
}

function cloneScenario(scenario: PlanningScenario, name: string, id = createId('planning')): PlanningScenario {
  return {
    ...scenario,
    id,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assumptions: {
      ...scenario.assumptions,
      expenseByTypeCents: { ...scenario.assumptions.expenseByTypeCents },
    },
    months: [...scenario.months],
    incomeByMonthCents: { ...scenario.incomeByMonthCents },
    expenseByTypeByMonthCents: Object.fromEntries(
      scenario.months.map((monthKey) => [
        monthKey,
        { ...(scenario.expenseByTypeByMonthCents[monthKey] ?? {}) },
      ]),
    ),
    expenseTypeOrder: [...scenario.expenseTypeOrder],
  };
}

function normalizeScenario(raw: unknown, fallback: PlanningScenario): PlanningScenario {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Partial<PlanningScenario>;
  const monthsRaw = Array.isArray(obj.months)
    ? obj.months.filter((month): month is string => typeof month === 'string' && month.length === 7)
    : [];
  const months = monthsRaw.length > 0 ? sortMonthKeys(dedupe(monthsRaw)) : fallback.months;
  const expenseTypeOrder = normalizeExpenseTypeOrder(obj.expenseTypeOrder);
  const fallbackMonthKey = fallback.months[0] ?? addMonths(new Date().toISOString().slice(0, 7), 1);
  const startMonth = months[0] ?? fallbackMonthKey;

  const assumptions = sanitizeAssumptions(
    (obj.assumptions ?? {}) as Partial<PlanningAssumptions>,
    fallback.assumptions,
  );
  const incomeByMonthRaw =
    obj.incomeByMonthCents && typeof obj.incomeByMonthCents === 'object'
      ? (obj.incomeByMonthCents as Record<string, unknown>)
      : {};
  const expenseByMonthRaw =
    obj.expenseByTypeByMonthCents && typeof obj.expenseByTypeByMonthCents === 'object'
      ? (obj.expenseByTypeByMonthCents as Record<string, unknown>)
      : {};

  const incomeByMonthCents: Record<string, number> = {};
  const expenseByTypeByMonthCents: Record<string, Record<string, number>> = {};

  for (const [index, monthKey] of months.entries()) {
    const fallbackIncome = fallback.incomeByMonthCents[monthKey] ?? fallback.assumptions.monthlyIncomeCents;
    incomeByMonthCents[monthKey] = Math.max(
      0,
      Math.round(toNumber(incomeByMonthRaw[monthKey], fallbackIncome)),
    );

    const rowRaw =
      expenseByMonthRaw[monthKey] && typeof expenseByMonthRaw[monthKey] === 'object'
        ? (expenseByMonthRaw[monthKey] as Record<string, unknown>)
        : {};
    const fallbackRow =
      fallback.expenseByTypeByMonthCents[monthKey] ??
      fallback.expenseByTypeByMonthCents[fallbackMonthKey] ??
      {};
    const expenseGrowth = Math.pow(1 + assumptions.expenseGrowthPct / 100, index);
    const row: Record<string, number> = {};
    for (const typeCode of expenseTypeOrder) {
      const fallbackValue =
        fallbackRow[typeCode] ??
        Math.round((assumptions.expenseByTypeCents[typeCode] ?? 0) * expenseGrowth);
      row[typeCode] = Math.max(0, Math.round(toNumber(rowRaw[typeCode], fallbackValue)));
    }
    expenseByTypeByMonthCents[monthKey] = row;
  }

  return withDerivedAssumptions({
    id: typeof obj.id === 'string' ? obj.id : createId('planning'),
    name:
      typeof obj.name === 'string' && obj.name.trim().length > 0
        ? obj.name.trim()
        : DEFAULT_SCENARIO_NAME,
    createdAt:
      typeof obj.createdAt === 'string' && obj.createdAt
        ? obj.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof obj.updatedAt === 'string' && obj.updatedAt
        ? obj.updatedAt
        : new Date().toISOString(),
    assumptions,
    months: months.length > 0 ? months : buildMonthRange(startMonth, assumptions.monthsAhead),
    incomeByMonthCents,
    expenseByTypeByMonthCents,
    expenseTypeOrder,
  });
}

function loadStoredState(storageKey: string, fallbackScenario: PlanningScenario): {
  scenarios: PlanningScenario[];
  activeScenarioId: string;
} {
  if (typeof window === 'undefined') {
    return { scenarios: [fallbackScenario], activeScenarioId: fallbackScenario.id };
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return { scenarios: [fallbackScenario], activeScenarioId: fallbackScenario.id };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as StoredPlanningState).version === STORAGE_VERSION &&
      Array.isArray((parsed as StoredPlanningState).scenarios)
    ) {
      const state = parsed as StoredPlanningState;
      const scenarios = state.scenarios
        .map((scenario) => normalizeScenario(scenario, fallbackScenario))
        .filter(Boolean);
      if (scenarios.length === 0) {
        return { scenarios: [fallbackScenario], activeScenarioId: fallbackScenario.id };
      }
      const activeScenarioId = scenarios.some((scenario) => scenario.id === state.activeScenarioId)
        ? state.activeScenarioId
        : scenarios[0]!.id;
      return { scenarios, activeScenarioId };
    }

    if (parsed && typeof parsed === 'object') {
      const migratedAssumptions = sanitizeAssumptions(
        parsed as Partial<PlanningAssumptions>,
        fallbackScenario.assumptions,
      );
      const migratedScenario = createScenarioFromAssumptions(
        DEFAULT_SCENARIO_NAME,
        migratedAssumptions,
        fallbackScenario.months[0] ?? addMonths(new Date().toISOString().slice(0, 7), 1),
      );
      return { scenarios: [migratedScenario], activeScenarioId: migratedScenario.id };
    }
  } catch {
    return { scenarios: [fallbackScenario], activeScenarioId: fallbackScenario.id };
  }

  return { scenarios: [fallbackScenario], activeScenarioId: fallbackScenario.id };
}

function saveStoredState(
  storageKey: string,
  scenarios: PlanningScenario[],
  activeScenarioId: string,
): void {
  if (typeof window === 'undefined') return;
  const payload: StoredPlanningState = {
    version: STORAGE_VERSION,
    activeScenarioId,
    scenarios,
  };
  window.localStorage.setItem(storageKey, JSON.stringify(payload));
}

export function usePersonalPlanning(): UsePersonalPlanningResult {
  const { projectId, projectType } = useProject();
  const isPersonal = projectType === 'PESSOAL';
  const storageKey = useMemo(() => `personal-planning:${projectId}`, [projectId]);

  const overview = useQuery<MonthlyOverviewResponse>({
    queryKey: ['monthly-overview', projectId, 'planning'],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview`),
    enabled: isPersonal && !!projectId,
  });

  const defaultScenario = useMemo(() => {
    if (!overview.data) return null;
    const assumptions = buildDefaultAssumptions(overview.data);
    return createScenarioFromAssumptions(
      DEFAULT_SCENARIO_NAME,
      assumptions,
      addMonths(overview.data.mesAtual, 1),
    );
  }, [overview.data]);

  const [scenarios, setScenarios] = useState<PlanningScenario[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);

  useEffect(() => {
    setScenarios([]);
    setActiveScenarioId(null);
  }, [projectId]);

  useEffect(() => {
    if (!defaultScenario || scenarios.length > 0) return;
    const loaded = loadStoredState(storageKey, defaultScenario);
    setScenarios(loaded.scenarios);
    setActiveScenarioId(loaded.activeScenarioId);
  }, [defaultScenario, scenarios.length, storageKey]);

  useEffect(() => {
    if (scenarios.length === 0) return;
    const active = activeScenarioId ?? scenarios[0]!.id;
    saveStoredState(storageKey, scenarios, active);
  }, [activeScenarioId, scenarios, storageKey]);

  const activeScenario = useMemo(() => {
    if (scenarios.length === 0) return null;
    if (!activeScenarioId) return scenarios[0]!;
    return scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0]!;
  }, [activeScenarioId, scenarios]);

  useEffect(() => {
    if (!activeScenarioId && scenarios.length > 0) {
      setActiveScenarioId(scenarios[0]!.id);
      return;
    }
    if (
      activeScenarioId &&
      scenarios.length > 0 &&
      !scenarios.some((scenario) => scenario.id === activeScenarioId)
    ) {
      setActiveScenarioId(scenarios[0]!.id);
    }
  }, [activeScenarioId, scenarios]);

  const scenarioOptions = useMemo<PlanningScenarioOption[]>(
    () => scenarios.map((scenario) => ({ id: scenario.id, name: scenario.name })),
    [scenarios],
  );

  const updateActiveScenario = useCallback(
    (updater: (scenario: PlanningScenario) => PlanningScenario) => {
      setScenarios((current) => {
        if (current.length === 0) return current;
        const activeId = activeScenarioId ?? current[0]!.id;
        return current.map((scenario) => {
          if (scenario.id !== activeId) return scenario;
          const updated = updater(scenario);
          return withDerivedAssumptions(updated);
        });
      });
    },
    [activeScenarioId],
  );

  const patchAssumptions = useCallback(
    (patch: Partial<PlanningAssumptions>) => {
      updateActiveScenario((scenario) => {
        const nextAssumptions: PlanningAssumptions = {
          ...scenario.assumptions,
          targetMonthlySurplusCents:
            patch.targetMonthlySurplusCents != null
              ? Math.max(0, Math.round(patch.targetMonthlySurplusCents))
              : scenario.assumptions.targetMonthlySurplusCents,
          incomeGrowthPct:
            patch.incomeGrowthPct != null
              ? clamp(Number(patch.incomeGrowthPct.toFixed(2)), -10, 25)
              : scenario.assumptions.incomeGrowthPct,
          expenseGrowthPct:
            patch.expenseGrowthPct != null
              ? clamp(Number(patch.expenseGrowthPct.toFixed(2)), -10, 25)
              : scenario.assumptions.expenseGrowthPct,
          monthsAhead: scenario.assumptions.monthsAhead,
          monthlyIncomeCents: scenario.assumptions.monthlyIncomeCents,
          monthlyExpenseCents: scenario.assumptions.monthlyExpenseCents,
          expenseByTypeCents: { ...scenario.assumptions.expenseByTypeCents },
        };

        return touchScenario({
          ...scenario,
          assumptions: nextAssumptions,
        });
      });
    },
    [updateActiveScenario],
  );

  const createScenario = useCallback(
    (name?: string) => {
      const scenarioName = name?.trim() || `Planning ${scenarios.length + 1}`;
      // "Novo" nasce ZERADO (nada de herdar os valores do plano ativo — isso é o
      // que "Duplicar" faz). Reaproveita só a grade de meses (mês inicial +
      // quantidade) para o planning aparecer alinhado aos demais.
      const source = activeScenario ?? defaultScenario;
      const startMonth = source?.months[0] ?? defaultScenario?.months[0];
      if (!startMonth) return;
      const monthsAhead = source?.months.length ?? 12;
      const next = createScenarioFromAssumptions(
        scenarioName,
        buildEmptyAssumptions(monthsAhead),
        startMonth,
      );
      setScenarios((current) => [...current, next]);
      setActiveScenarioId(next.id);
    },
    [activeScenario, defaultScenario, scenarios.length],
  );

  const duplicateScenario = useCallback(
    (name?: string) => {
      if (!activeScenario) return;
      const scenarioName = name?.trim() || `${activeScenario.name} (cópia)`;
      const next = cloneScenario(activeScenario, scenarioName);
      setScenarios((current) => [...current, next]);
      setActiveScenarioId(next.id);
    },
    [activeScenario],
  );

  const renameScenario = useCallback(
    (name: string) => {
      const nextName = name.trim();
      if (!nextName) return;
      updateActiveScenario((scenario) =>
        touchScenario({
          ...scenario,
          name: nextName,
        }),
      );
    },
    [updateActiveScenario],
  );

  const deleteScenario = useCallback(() => {
    if (scenarios.length <= 1 || !activeScenarioId) return;
    let nextActiveId: string | null = null;
    setScenarios((current) => {
      const idx = current.findIndex((scenario) => scenario.id === activeScenarioId);
      if (idx < 0) return current;
      const next = current.filter((scenario) => scenario.id !== activeScenarioId);
      nextActiveId = next[idx] ? next[idx]!.id : next[idx - 1]?.id ?? next[0]?.id ?? null;
      return next;
    });
    if (nextActiveId) setActiveScenarioId(nextActiveId);
  }, [activeScenarioId, scenarios.length]);

  const switchScenario = useCallback((scenarioId: string) => {
    setActiveScenarioId(scenarioId);
  }, []);

  const addMonth = useCallback(() => {
    updateActiveScenario((scenario) => {
      const lastMonth = scenario.months[scenario.months.length - 1];
      if (!lastMonth) return scenario;
      const newMonth = addMonths(lastMonth, 1);
      if (scenario.months.includes(newMonth)) return scenario;

      const baseIncome =
        scenario.incomeByMonthCents[lastMonth] ?? scenario.assumptions.monthlyIncomeCents;
      const nextIncome = Math.max(
        0,
        Math.round(baseIncome * (1 + scenario.assumptions.incomeGrowthPct / 100)),
      );
      const lastExpenseRow = scenario.expenseByTypeByMonthCents[lastMonth] ?? {};
      const nextExpenseRow: Record<string, number> = {};
      for (const typeCode of scenario.expenseTypeOrder) {
        const baseExpense =
          lastExpenseRow[typeCode] ?? scenario.assumptions.expenseByTypeCents[typeCode] ?? 0;
        nextExpenseRow[typeCode] = Math.max(
          0,
          Math.round(baseExpense * (1 + scenario.assumptions.expenseGrowthPct / 100)),
        );
      }

      return touchScenario({
        ...scenario,
        months: [...scenario.months, newMonth],
        incomeByMonthCents: {
          ...scenario.incomeByMonthCents,
          [newMonth]: nextIncome,
        },
        expenseByTypeByMonthCents: {
          ...scenario.expenseByTypeByMonthCents,
          [newMonth]: nextExpenseRow,
        },
      });
    });
  }, [updateActiveScenario]);

  const setIncomeForMonth = useCallback(
    (monthKey: string, cents: number) => {
      updateActiveScenario((scenario) => {
        if (!scenario.months.includes(monthKey)) return scenario;
        return touchScenario({
          ...scenario,
          incomeByMonthCents: {
            ...scenario.incomeByMonthCents,
            [monthKey]: Math.max(0, Math.round(cents)),
          },
        });
      });
    },
    [updateActiveScenario],
  );

  const setExpenseForMonth = useCallback(
    (monthKey: string, typeCode: string, cents: number) => {
      updateActiveScenario((scenario) => {
        if (!scenario.months.includes(monthKey)) return scenario;
        const normalizedType = String(typeCode);
        if (isNeutralExpenseType(normalizedType)) return scenario;
        const nextOrder = scenario.expenseTypeOrder.includes(normalizedType)
          ? scenario.expenseTypeOrder
          : [...scenario.expenseTypeOrder, normalizedType];
        const monthRow = scenario.expenseByTypeByMonthCents[monthKey] ?? {};
        return touchScenario({
          ...scenario,
          expenseTypeOrder: nextOrder,
          expenseByTypeByMonthCents: {
            ...scenario.expenseByTypeByMonthCents,
            [monthKey]: {
              ...monthRow,
              [normalizedType]: Math.max(0, Math.round(cents)),
            },
          },
        });
      });
    },
    [updateActiveScenario],
  );

  const addExpenseType = useCallback(
    (typeCode: string) => {
      const normalizedType = String(typeCode);
      if (!normalizedType || isNeutralExpenseType(normalizedType)) return;

      updateActiveScenario((scenario) => {
        if (scenario.expenseTypeOrder.includes(normalizedType)) return scenario;

        const nextExpenseByMonth: Record<string, Record<string, number>> = {};
        for (const monthKey of scenario.months) {
          const currentRow = scenario.expenseByTypeByMonthCents[monthKey] ?? {};
          nextExpenseByMonth[monthKey] = {
            ...currentRow,
            [normalizedType]: 0,
          };
        }

        return touchScenario({
          ...scenario,
          expenseTypeOrder: [...scenario.expenseTypeOrder, normalizedType],
          expenseByTypeByMonthCents: nextExpenseByMonth,
          assumptions: {
            ...scenario.assumptions,
            expenseByTypeCents: {
              ...scenario.assumptions.expenseByTypeCents,
              [normalizedType]: 0,
            },
          },
        });
      });
    },
    [updateActiveScenario],
  );

  const assumptions = activeScenario?.assumptions ?? null;
  const months = activeScenario?.months ?? [];
  const incomeByMonthCents = activeScenario?.incomeByMonthCents ?? {};

  // Média mensal por CÓDIGO de tipo (÷12), do ano corrente do overview —
  // ANUALIZADA: inclui parcelas pagas E planejadas do ano (compromisso real),
  // espelho/neutro-de-consumo fora. Base do "preencher com média".
  const averageByCodeCents = useMemo<Record<string, number>>(() => {
    if (!overview.data?.entries?.length) return {};
    const year = parseInt((overview.data.mesAtual ?? '').slice(0, 4), 10) || new Date().getFullYear();
    const media = mediaMensalPorCodigo(overview.data.entries, year);
    const out: Record<string, number> = {};
    for (const [codigo, cents] of media) {
      // Só categorias pessoais válidas (exclui neutros e códigos fora do planning).
      if (isNeutralExpenseType(codigo)) continue;
      if (!PERSONAL_EXPENSE_LABEL_BY_CODE.has(codigo)) continue;
      if (cents > 0) out[codigo] = cents;
    }
    return out;
  }, [overview.data]);

  /**
   * Preenche os meses informados com a média histórica de cada categoria (÷12).
   * Adiciona ao cenário as categorias que ainda não estão na matriz e sobrescreve
   * o valor de cada categoria nos meses selecionados. Não toca em outros meses.
   */
  const fillMonthsWithAverage = useCallback(
    (monthKeys: string[]) => {
      const codes = Object.keys(averageByCodeCents);
      if (monthKeys.length === 0 || codes.length === 0) return;
      updateActiveScenario((scenario) => {
        const targetMonths = monthKeys.filter((m) => scenario.months.includes(m));
        if (targetMonths.length === 0) return scenario;

        const nextOrder = [...scenario.expenseTypeOrder];
        for (const code of codes) {
          if (!nextOrder.includes(code)) nextOrder.push(code);
        }

        const nextByMonth: Record<string, Record<string, number>> = {
          ...scenario.expenseByTypeByMonthCents,
        };
        for (const monthKey of targetMonths) {
          const row = { ...(nextByMonth[monthKey] ?? {}) };
          for (const code of codes) {
            row[code] = averageByCodeCents[code] ?? 0;
          }
          nextByMonth[monthKey] = row;
        }

        return touchScenario({
          ...scenario,
          expenseTypeOrder: nextOrder,
          expenseByTypeByMonthCents: nextByMonth,
        });
      });
    },
    [averageByCodeCents, updateActiveScenario],
  );

  /**
   * Limpa TODOS os valores do cenário ativo: zera as entradas e as despesas de
   * cada categoria em todos os meses. Mantém a grade de meses e as categorias da
   * matriz (estrutura), apenas apaga os números para recomeçar do zero.
   */
  const clearAll = useCallback(() => {
    updateActiveScenario((scenario) => clearScenarioValues(scenario));
  }, [updateActiveScenario]);

  const startBalanceCents = useMemo(
    () => (overview.data ? deriveCockpitTop(overview.data).caixaValor : 0),
    [overview.data],
  );
  const projection = useMemo<PlanningProjectionRow[]>(() => {
    if (!activeScenario) return [];
    let runningBalance = startBalanceCents;

    return activeScenario.months.map((monthKey) => {
      const plannedIncomeCents = activeScenario.incomeByMonthCents[monthKey] ?? 0;
      const plannedExpenseCents = sumMonthExpense(
        activeScenario.expenseByTypeByMonthCents,
        monthKey,
        activeScenario.expenseTypeOrder,
      );
      const monthlyBalanceCents = plannedIncomeCents - plannedExpenseCents;
      runningBalance += monthlyBalanceCents;
      return {
        monthKey,
        monthLabel: monthLabel(monthKey),
        plannedIncomeCents,
        plannedExpenseCents,
        monthlyBalanceCents,
        closingBalanceCents: runningBalance,
        targetGapCents: monthlyBalanceCents - activeScenario.assumptions.targetMonthlySurplusCents,
        source: 'matrix',
      };
    });
  }, [activeScenario, startBalanceCents]);

  const summary = useMemo<PlanningSummary | null>(() => {
    if (!activeScenario) return null;

    const totalIncomeCents = projection.reduce((sum, row) => sum + row.plannedIncomeCents, 0);
    const totalExpenseCents = projection.reduce((sum, row) => sum + row.plannedExpenseCents, 0);
    const totalMonthlyBalance = projection.reduce((sum, row) => sum + row.monthlyBalanceCents, 0);
    const worstBalanceCents = projection.reduce(
      (min, row) => Math.min(min, row.closingBalanceCents),
      startBalanceCents,
    );
    const firstNegative = projection.find((row) => row.closingBalanceCents < 0);
    const endBalanceCents =
      projection.length > 0
        ? projection[projection.length - 1]!.closingBalanceCents
        : startBalanceCents;
    const monthsBelowTarget = projection.filter(
      (row) => row.monthlyBalanceCents < activeScenario.assumptions.targetMonthlySurplusCents,
    ).length;

    return {
      startBalanceCents,
      endBalanceCents,
      totalIncomeCents,
      totalExpenseCents,
      averageMonthlyBalanceCents:
        projection.length > 0 ? Math.round(totalMonthlyBalance / projection.length) : 0,
      worstBalanceCents,
      firstNegativeMonthLabel: firstNegative?.monthLabel ?? null,
      monthsBelowTarget,
    };
  }, [activeScenario, projection, startBalanceCents]);

  const commitments = useMemo<PlanningCommitmentRow[]>(() => {
    if (!overview.data || !activeScenario) return [];
    const caixaData = buildCaixaData(overview.data);
    const fromMonth =
      activeScenario.months[0] ?? addMonths(overview.data.mesAtual, 1);
    return buildComprometimentoFuturo(
      caixaData,
      fromMonth,
      Math.max(activeScenario.months.length, 1),
    ).map((row) => ({
      monthKey: row.mes,
      monthLabel: monthLabel(row.mes),
      totalCents: row.total,
      itemCount: row.itens.length,
    }));
  }, [activeScenario, overview.data]);

  const expenseTypes = useMemo<PlanningExpenseTypeRow[]>(() => {
    if (!activeScenario) return [];
    const total = activeScenario.assumptions.monthlyExpenseCents;
    return activeScenario.expenseTypeOrder
      .map((typeCode) => {
        const monthlyCents = activeScenario.assumptions.expenseByTypeCents[typeCode] ?? 0;
        return {
          typeCode,
          label: PERSONAL_EXPENSE_LABEL_BY_CODE.get(typeCode) ?? typeCode,
          monthlyCents,
          sharePct: total > 0 ? (monthlyCents / total) * 100 : 0,
        };
      })
      .sort((a, b) => b.monthlyCents - a.monthlyCents);
  }, [activeScenario]);

  const expenseMatrixRows = useMemo<PlanningMatrixExpenseRow[]>(() => {
    if (!activeScenario) return [];
    return activeScenario.expenseTypeOrder.map((typeCode) => {
      const valuesByMonthCents: Record<string, number> = {};
      let totalCents = 0;
      for (const monthKey of activeScenario.months) {
        const value = activeScenario.expenseByTypeByMonthCents[monthKey]?.[typeCode] ?? 0;
        valuesByMonthCents[monthKey] = value;
        totalCents += value;
      }
      return {
        typeCode,
        label: PERSONAL_EXPENSE_LABEL_BY_CODE.get(typeCode) ?? typeCode,
        valuesByMonthCents,
        totalCents,
      };
    });
  }, [activeScenario]);

  const addableExpenseTypes = useMemo(
    () =>
      PERSONAL_EXPENSE_OPTIONS.filter(
        (option) => !activeScenario?.expenseTypeOrder.includes(option.value),
      ),
    [activeScenario],
  );

  return {
    isPersonal,
    isLoading:
      overview.isLoading ||
      (isPersonal && !overview.error && defaultScenario != null && scenarios.length === 0),
    error: (overview.error as Error | null) ?? null,
    assumptions,
    projection,
    summary,
    commitments,
    expenseTypes,
    scenarios: scenarioOptions,
    activeScenarioId,
    months,
    incomeByMonthCents,
    expenseMatrixRows,
    addableExpenseTypes,
    patchAssumptions,
    createScenario,
    duplicateScenario,
    renameScenario,
    deleteScenario,
    switchScenario,
    addMonth,
    setIncomeForMonth,
    setExpenseForMonth,
    addExpenseType,
    averageByCodeCents,
    fillMonthsWithAverage,
    clearAll,
  };
}
