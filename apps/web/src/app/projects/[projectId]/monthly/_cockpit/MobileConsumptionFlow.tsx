import { moneyDetail, moneyGlance } from "@/lib/money";
import { colorForCategoria } from "./derive";
import type { MobileMonthData } from "./mobile-month-data";

export default function MobileConsumptionFlow({
  data,
}: {
  data: MobileMonthData;
}) {
  return (
    <article
      aria-label="Consumo realizado"
      className="minimal-card rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 shadow-lifeone-card"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--ck-text)]">
            Consumo realizado
          </h2>
          <p className="mt-1 text-sm text-[var(--ck-muted)]">
            Só compras pagas, sem espelhos ou movimentos neutros
          </p>
        </div>
        <p className="shrink-0 font-geist text-xl font-bold tabular-nums text-[var(--ck-neg)]">
          {moneyGlance(data.realizedConsumptionCents)}
        </p>
      </div>

      {data.isEmpty ? (
        <p className="mt-3 rounded-xl bg-[var(--ck-surface-2)] p-3 text-sm text-[var(--ck-muted)]">
          Ainda não há consumo realizado neste mês.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {data.realizedCategories.map((category, index) => {
            const share =
              data.realizedConsumptionCents > 0
                ? (category.valueCents / data.realizedConsumptionCents) * 100
                : 0;
            return (
              <div key={category.label}>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-[var(--ck-text)]">
                    {category.label}
                  </span>
                  <span className="shrink-0 font-geist tabular-nums text-[var(--ck-muted)]">
                    {moneyDetail(category.valueCents)}
                  </span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--ck-surface-2)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, share)}%`,
                      backgroundColor: colorForCategoria(category.label, index),
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
