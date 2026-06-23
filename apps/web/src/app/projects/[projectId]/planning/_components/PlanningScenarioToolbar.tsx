'use client';

import type { PlanningScenarioOption } from '../_types';

interface PlanningScenarioToolbarProps {
  scenarios: PlanningScenarioOption[];
  activeScenarioId: string | null;
  onSwitchScenario: (scenarioId: string) => void;
  onCreateScenario: (name?: string) => void;
  onDuplicateScenario: (name?: string) => void;
  onRenameScenario: (name: string) => void;
  onDeleteScenario: () => void;
}

export default function PlanningScenarioToolbar({
  scenarios,
  activeScenarioId,
  onSwitchScenario,
  onCreateScenario,
  onDuplicateScenario,
  onRenameScenario,
  onDeleteScenario,
}: PlanningScenarioToolbarProps) {
  const active = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0];
  const canDelete = scenarios.length > 1;

  return (
    <section className="rounded-2xl border border-darc-linen bg-white p-4 md:p-5 space-y-3">
      <div>
        <h2 className="text-base font-semibold text-darc-velvet">Plannings</h2>
        <p className="text-xs text-darc-velvet/60">
          Crie cenários alternativos e compare diferentes estratégias de orçamento.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={active?.id ?? ''}
          onChange={(e) => onSwitchScenario(e.target.value)}
          className="min-w-[220px] rounded-xl border border-darc-linen px-3 py-2 text-sm text-darc-velvet bg-white"
        >
          {scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => {
            const name = window.prompt('Nome do novo planning:');
            if (name === null) return;
            onCreateScenario(name);
          }}
          className="rounded-lg bg-darc-red px-3 py-2 text-xs font-semibold text-white hover:bg-darc-red/90"
        >
          + Novo
        </button>

        <button
          type="button"
          onClick={() => {
            const suggested = active ? `${active.name} (cópia)` : 'Planning cópia';
            const name = window.prompt('Nome da cópia:', suggested);
            if (name === null) return;
            onDuplicateScenario(name);
          }}
          className="rounded-lg border border-darc-linen px-3 py-2 text-xs font-semibold text-darc-velvet hover:bg-darc-linen/40"
        >
          Duplicar
        </button>

        <button
          type="button"
          onClick={() => {
            if (!active) return;
            const name = window.prompt('Novo nome do planning:', active.name);
            if (name === null) return;
            onRenameScenario(name);
          }}
          className="rounded-lg border border-darc-linen px-3 py-2 text-xs font-semibold text-darc-velvet hover:bg-darc-linen/40"
        >
          Renomear
        </button>

        <button
          type="button"
          disabled={!canDelete}
          onClick={() => {
            if (!canDelete || !active) return;
            if (window.confirm(`Excluir planning "${active.name}"?`)) {
              onDeleteScenario();
            }
          }}
          className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-50"
        >
          Excluir
        </button>
      </div>
    </section>
  );
}
