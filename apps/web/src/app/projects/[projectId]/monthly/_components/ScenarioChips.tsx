"use client";

/**
 * Chips de cenário "E se…?" (inovação #2). Componente controlado e puro:
 * não guarda estado próprio — quem decide o delta selecionado é o pai
 * (`selectedDelta`), e o clique só notifica via `onChange`. Os deltas são
 * literais em centavos, consistentes com o contrato de `applyScenario`
 * (delta positivo = melhora o saldo projetado; negativo = piora).
 */
export interface ScenarioOption {
  label: string;
  deltaCentsPerMonth: number;
}

export const SCENARIO_OPTIONS: ScenarioOption[] = [
  { label: "como está", deltaCentsPerMonth: 0 },
  { label: "gastar +500", deltaCentsPerMonth: -50_000 },
  { label: "cortar 500", deltaCentsPerMonth: 50_000 },
  { label: "cortar 1.000", deltaCentsPerMonth: 100_000 },
];

export default function ScenarioChips({
  selectedDelta,
  onChange,
}: {
  selectedDelta: number;
  onChange: (deltaCentsPerMonth: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Cenários e se…?"
      className="flex flex-wrap gap-2"
    >
      {SCENARIO_OPTIONS.map((option) => {
        const pressed = option.deltaCentsPerMonth === selectedDelta;
        return (
          <button
            key={option.label}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.deltaCentsPerMonth)}
            className={`min-h-[44px] rounded-full border px-4 text-sm font-medium transition-colors ${
              pressed
                ? "border-[var(--ck-accent)] bg-[var(--ck-accent)]/10 text-[var(--ck-accent)]"
                : "border-[var(--ck-border)] bg-[var(--ck-surface)] text-[var(--ck-muted)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
