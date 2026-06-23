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
} from '../../monthly/_cockpit/derive';
import { mesCurto } from '../../monthly/_cockpit/format';
import type {
  PlanningAssumptions,
  PlanningCommitmentRow,
  PlanningExpenseTypeRow,
  PlanningProjectionRow,
  PlanningSummary,
} from '../_types';

const PERSONAL_EXPENSE_OPTIONS = getExpenseOptions('PESSOAL').filter(
  (option) => !isNeutralExpenseType(option.value),
);
const PERSONAL_EXPENSE_LABEL_BY_CODE: Map<string, string> = new Map(
  PERSONAL_EXPENSE_OPTIONS.map((option) => [String(option.value), option.label] as const),
);

interface UsePersonalPlanningResult {
  isPersonal: boolean;
  isLoading: boolean;
  error: Error | null;
  assumptions: PlanningAssumptions | null;
  projection: PlanningProjectionRow[];
  summary: PlanningSummary | null;
  commitments: PlanningCommitmentRow[];
  expenseTypes: PlanningExpenseTypeRow[];
  patchAssumptions: (patch: Partial<PlanningAssumptions>) => void;
  patchExpenseType: (typeCode: string, monthlyCents: number) => void;
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

function sumExpenseByTypeCents(expenseByType: Record<string, number>): number {
  return Object.values(expenseByType).reduce((sum, value) => sum + value, 0);
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
    normalized[typeCode] = Math.max(
      0,
      Math.round(toNumber(candidateValue, fallbackValue)),
    );
  }

  for (const [typeCode, candidateValue] of Object.entries(candidateMap)) {
    if (normalized[typeCode] !== undefined) continue;
    if (isNeutralExpenseType(typeCode)) continue;
    normalized[typeCode] = Math.max(0, Math.round(toNumber(candidateValue, 0)));
  }

  return normalized;
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
  const expenseByTypeCents: Record<string, number> = Object.fromEntries(
    PERSONAL_EXPENSE_OPTIONS.map((option) => [option.value, 0]),
  );

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

export function usePersonalPlanning(): UsePersonalPlanningResult {
  const { projectId, projectType } = useProject();
  const isPersonal = projectType === 'PESSOAL';
  const storageKey = useMemo(() => `personal-planning:${projectId}`, [projectId]);

  const overview = useQuery<MonthlyOverviewResponse>({
    queryKey: ['monthly-overview', projectId, 'planning'],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview`),
    enabled: isPersonal && !!projectId,
  });

  const [assumptions, setAssumptions] = useState<PlanningAssumptions | null>(null);
  const baseAssumptions = useMemo(
    () => (overview.data ? buildDefaultAssumptions(overview.data) : null),
    [overview.data],
  );

  useEffect(() => {
    setAssumptions(null);
  }, [projectId]);

  useEffect(() => {
    if (!baseAssumptions || assumptions) return;
    let initial = baseAssumptions;
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        try {
          initial = sanitizeAssumptions(
            JSON.parse(stored) as Partial<PlanningAssumptions>,
            baseAssumptions,
          );
        } catch {
          initial = baseAssumptions;
        }
      }
    }
    setAssumptions(initial);
  }, [assumptions, baseAssumptions, storageKey]);

  useEffect(() => {
    if (!assumptions || typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, JSON.stringify(assumptions));
  }, [assumptions, storageKey]);

  const patchAssumptions = useCallback((patch: Partial<PlanningAssumptions>) => {
    setAssumptions((current) => {
      if (!current) return current;
      return sanitizeAssumptions({ ...current, ...patch }, current);
    });
  }, []);

  const patchExpenseType = useCallback((typeCode: string, monthlyCents: number) => {
    setAssumptions((current) => {
      if (!current) return current;
      return sanitizeAssumptions(
        {
          ...current,
          expenseByTypeCents: {
            ...current.expenseByTypeCents,
            [typeCode]: Math.max(0, Math.round(monthlyCents)),
          },
        },
        current,
      );
    });
  }, []);

  const startBalanceCents = useMemo(
    () => (overview.data ? deriveCockpitTop(overview.data).caixaValor : 0),
    [overview.data],
  );

  const projection = useMemo<PlanningProjectionRow[]>(() => {
    if (!overview.data || !assumptions) return [];

    const monthMap = new Map(overview.data.meses.map((row) => [row.mes, row] as const));
    const firstMonth = addMonths(overview.data.mesAtual, 1);
    let openingBalance = startBalanceCents;
    const rows: PlanningProjectionRow[] = [];

    for (let idx = 0; idx < assumptions.monthsAhead; idx++) {
      const monthKey = addMonths(firstMonth, idx);
      const known = monthMap.get(monthKey);
      const incomeGrowth = Math.pow(1 + assumptions.incomeGrowthPct / 100, idx);
      const expenseGrowth = Math.pow(1 + assumptions.expenseGrowthPct / 100, idx);
      const modeledIncome = Math.max(0, Math.round(assumptions.monthlyIncomeCents * incomeGrowth));
      const modeledExpense = Object.values(assumptions.expenseByTypeCents).reduce((sum, baseValue) => {
        const base = Math.max(0, baseValue);
        const projected = Math.round(base * expenseGrowth);
        return sum + projected;
      }, 0);

      const useKnownIncome = !!known && known.totalRecebimentos > 0;
      const useKnownExpense = !!known && known.totalDespesas > 0 && modeledExpense <= 0;
      const plannedIncome = useKnownIncome ? known.totalRecebimentos : modeledIncome;
      const plannedExpense = useKnownExpense ? known.totalDespesas : modeledExpense;
      const monthlyBalanceCents = plannedIncome - plannedExpense;
      const closingBalanceCents = openingBalance + monthlyBalanceCents;
      const source: PlanningProjectionRow['source'] =
        useKnownIncome && useKnownExpense
          ? 'known'
          : useKnownIncome || useKnownExpense
            ? 'mixed'
            : 'modeled';

      rows.push({
        monthKey,
        monthLabel: monthLabel(monthKey),
        plannedIncomeCents: plannedIncome,
        plannedExpenseCents: plannedExpense,
        monthlyBalanceCents,
        closingBalanceCents,
        targetGapCents: monthlyBalanceCents - assumptions.targetMonthlySurplusCents,
        source,
      });

      openingBalance = closingBalanceCents;
    }

    return rows;
  }, [assumptions, overview.data, startBalanceCents]);

  const summary = useMemo<PlanningSummary | null>(() => {
    if (!assumptions) return null;

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
      (row) => row.monthlyBalanceCents < assumptions.targetMonthlySurplusCents,
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
  }, [assumptions, projection, startBalanceCents]);

  const commitments = useMemo<PlanningCommitmentRow[]>(() => {
    if (!overview.data || !assumptions) return [];

    const caixaData = buildCaixaData(overview.data);
    return buildComprometimentoFuturo(
      caixaData,
      addMonths(overview.data.mesAtual, 1),
      assumptions.monthsAhead,
    ).map((row) => ({
      monthKey: row.mes,
      monthLabel: monthLabel(row.mes),
      totalCents: row.total,
      itemCount: row.itens.length,
    }));
  }, [assumptions, overview.data]);

  const expenseTypes = useMemo<PlanningExpenseTypeRow[]>(() => {
    if (!assumptions) return [];

    const typeCodes = new Set<string>([
      ...PERSONAL_EXPENSE_OPTIONS.map((option) => option.value),
      ...Object.keys(assumptions.expenseByTypeCents),
    ]);
    const total = assumptions.monthlyExpenseCents;

    return Array.from(typeCodes)
      .map((typeCode) => {
        const monthlyCents = assumptions.expenseByTypeCents[typeCode] ?? 0;
        return {
          typeCode,
          label: PERSONAL_EXPENSE_LABEL_BY_CODE.get(typeCode) ?? typeCode,
          monthlyCents,
          sharePct: total > 0 ? (monthlyCents / total) * 100 : 0,
        };
      })
      .sort((a, b) => {
        if (b.monthlyCents !== a.monthlyCents) return b.monthlyCents - a.monthlyCents;
        return a.label.localeCompare(b.label, 'pt-BR');
      });
  }, [assumptions]);

  return {
    isPersonal,
    isLoading: overview.isLoading || (isPersonal && !overview.error && assumptions == null),
    error: (overview.error as Error | null) ?? null,
    assumptions,
    projection,
    summary,
    commitments,
    expenseTypes,
    patchAssumptions,
    patchExpenseType,
  };
}
