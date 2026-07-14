import { ChevronLeft, ChevronRight, Gauge } from "lucide-react";
import type { Eixo } from "./EixoToggle";
import { mesLongo } from "./format";

export type MobileCockpitView = "mes" | "ano";

const AXIS_OPTIONS: Array<{ value: Eixo; label: string }> = [
  { value: "caixa", label: "Caixa" },
  { value: "geral", label: "Extrato" },
];

function monthTitle(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  const monthIndex = Number.parseInt(month ?? "1", 10) - 1;
  return `${mesLongo(monthIndex)} ${year ?? ""}`.trim();
}

export default function MobileCockpitHeader({
  view,
  monthKey,
  year,
  years,
  currentMonth,
  minMonth,
  maxMonth,
  eixo,
  onViewChange,
  onPreviousMonth,
  onNextMonth,
  onCurrentMonth,
  onYearChange,
  onEixoChange,
}: {
  view: MobileCockpitView;
  monthKey: string;
  year: number;
  years: number[];
  currentMonth: string;
  minMonth: string;
  maxMonth: string;
  eixo: Eixo;
  onViewChange: (view: MobileCockpitView) => void;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onCurrentMonth: () => void;
  onYearChange: (year: number) => void;
  onEixoChange: (eixo: Eixo) => void;
}) {
  return (
    <header className="pessoal-minimal-page-header mb-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] text-[var(--ck-accent)]">
            <Gauge className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--ck-muted)]">
              Cockpit financeiro
            </p>
            <h1 className="truncate font-geist text-xl font-semibold leading-tight text-[var(--ck-text)]">
              {view === "mes" ? monthTitle(monthKey) : `Ano ${year}`}
            </h1>
          </div>
        </div>

        {view === "mes" && (
          <div className="flex shrink-0 items-center rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)]">
            <button
              type="button"
              aria-label="Mês anterior"
              disabled={monthKey <= minMonth}
              onClick={onPreviousMonth}
              className="grid h-11 w-11 place-items-center text-sm text-[var(--ck-muted)] disabled:opacity-30"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Próximo mês"
              disabled={monthKey >= maxMonth}
              onClick={onNextMonth}
              className="grid h-11 w-11 place-items-center border-l border-[var(--ck-border)] text-sm text-[var(--ck-muted)] disabled:opacity-30"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="grid min-h-[44px] flex-1 grid-cols-2 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] p-1">
          {(["mes", "ano"] as MobileCockpitView[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => onViewChange(option)}
              className={`min-h-[44px] rounded-lg px-3 text-sm font-semibold ${
                view === option
                  ? "bg-[var(--ck-accent)] text-white"
                  : "text-[var(--ck-muted)]"
              }`}
            >
              {option === "mes" ? "Mês" : "Ano"}
            </button>
          ))}
        </div>
        {view === "mes" && monthKey !== currentMonth && (
          <button
            type="button"
            onClick={onCurrentMonth}
            className="min-h-[44px] rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 text-sm font-semibold text-[var(--ck-accent)]"
          >
            Atual
          </button>
        )}
        {view === "ano" && (
          <select
            aria-label="Ano"
            value={year}
            onChange={(event) => onYearChange(Number(event.target.value))}
            className="min-h-[44px] rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 text-sm text-[var(--ck-text)]"
          >
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
      </div>

      {view === "mes" && (
        <div
          role="group"
          aria-label="Eixo de tempo"
          className="grid grid-cols-2 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] p-1"
        >
          {AXIS_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={eixo === option.value}
              onClick={() => onEixoChange(option.value)}
              className={`min-h-[44px] rounded-lg px-2 text-sm font-semibold ${
                eixo === option.value
                  ? "bg-[var(--ck-accent)] text-white"
                  : "text-[var(--ck-muted)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
