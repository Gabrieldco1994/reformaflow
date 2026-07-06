'use client';

import { AlertTriangle, CalendarClock } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import PlanningAssumptions from './_components/PlanningAssumptions';
import PlanningSummary from './_components/PlanningSummary';
import PlanningProjectionChart from './_components/PlanningProjectionChart';
import PlanningCommitments from './_components/PlanningCommitments';
import PlanningProjectionTable from './_components/PlanningProjectionTable';
import PlanningScenarioToolbar from './_components/PlanningScenarioToolbar';
import PlanningMatrix from './_components/PlanningMatrix';
import { usePersonalPlanning } from './_hooks/usePersonalPlanning';

export default function PlanningPage() {
  const {
    isPersonal,
    isLoading,
    error,
    assumptions,
    projection,
    summary,
    commitments,
    scenarios,
    activeScenarioId,
    months,
    incomeByMonthCents,
    expenseMatrixRows,
    averageByCodeCents,
    patchAssumptions,
    createScenario,
    duplicateScenario,
    renameScenario,
    deleteScenario,
    switchScenario,
    addMonth,
    setIncomeForMonth,
    setExpenseForMonth,
    fillMonthsWithAverage,
    clearAll,
  } = usePersonalPlanning();

  if (!isPersonal) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <EmptyState
          icon={CalendarClock}
          title="Planning indisponível"
          description="O planning financeiro está disponível apenas para projetos do tipo PESSOAL."
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        Não foi possível carregar o planning: {error.message}
      </div>
    );
  }

  if (isLoading || !assumptions || !summary) {
    return <div className="text-sm text-darc-velvet/70">Carregando planning...</div>;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <header className="rounded-2xl bg-darc-gradient-dark p-5 text-darc-linen">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-darc-linen/60">
          Planejamento pessoal
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Planning de despesas e recebimentos</h1>
        <p className="mt-1 text-sm text-darc-linen/70">
          Simule seu fluxo futuro para controlar saldos, antecipar risco de caixa e ajustar seu budget.
        </p>
      </header>

      {summary.monthsBelowTarget > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {summary.monthsBelowTarget} mês(es) estão abaixo da meta de sobra mensal configurada.
          </span>
        </div>
      )}

      <PlanningSummary summary={summary} />

      <PlanningScenarioToolbar
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        onSwitchScenario={switchScenario}
        onCreateScenario={createScenario}
        onDuplicateScenario={duplicateScenario}
        onRenameScenario={renameScenario}
        onDeleteScenario={deleteScenario}
      />

      <PlanningAssumptions assumptions={assumptions} onChange={patchAssumptions} />
      <PlanningMatrix
        months={months}
        incomeByMonthCents={incomeByMonthCents}
        expenseRows={expenseMatrixRows}
        averageByCodeCents={averageByCodeCents}
        onAddMonth={addMonth}
        onIncomeChange={setIncomeForMonth}
        onExpenseChange={setExpenseForMonth}
        onFillWithAverage={fillMonthsWithAverage}
        onClearAll={clearAll}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <PlanningProjectionChart
            rows={projection}
            targetMonthlySurplusCents={assumptions.targetMonthlySurplusCents}
          />
        </div>
        <PlanningCommitments commitments={commitments} />
      </div>

      <PlanningProjectionTable
        rows={projection}
        targetMonthlySurplusCents={assumptions.targetMonthlySurplusCents}
      />
    </div>
  );
}
