export interface PlanningAssumptions {
  monthsAhead: number;
  monthlyIncomeCents: number;
  monthlyExpenseCents: number;
  incomeGrowthPct: number;
  expenseGrowthPct: number;
  targetMonthlySurplusCents: number;
  expenseByTypeCents: Record<string, number>;
}

export interface PlanningProjectionRow {
  monthKey: string;
  monthLabel: string;
  plannedIncomeCents: number;
  plannedExpenseCents: number;
  monthlyBalanceCents: number;
  closingBalanceCents: number;
  targetGapCents: number;
  source: 'known' | 'modeled' | 'mixed' | 'matrix';
}

export interface PlanningSummary {
  startBalanceCents: number;
  endBalanceCents: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  averageMonthlyBalanceCents: number;
  worstBalanceCents: number;
  firstNegativeMonthLabel: string | null;
  monthsBelowTarget: number;
}

export interface PlanningCommitmentRow {
  monthKey: string;
  monthLabel: string;
  totalCents: number;
  itemCount: number;
}

export interface PlanningExpenseTypeRow {
  typeCode: string;
  label: string;
  monthlyCents: number;
  sharePct: number;
}

export interface PlanningScenario {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  assumptions: PlanningAssumptions;
  months: string[];
  incomeByMonthCents: Record<string, number>;
  expenseByTypeByMonthCents: Record<string, Record<string, number>>;
  expenseTypeOrder: string[];
}

export interface PlanningScenarioOption {
  id: string;
  name: string;
}

export interface PlanningMatrixExpenseRow {
  typeCode: string;
  label: string;
  valuesByMonthCents: Record<string, number>;
  totalCents: number;
}
