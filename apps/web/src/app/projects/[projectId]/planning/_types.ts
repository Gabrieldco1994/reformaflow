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
  source: 'known' | 'modeled' | 'mixed';
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
