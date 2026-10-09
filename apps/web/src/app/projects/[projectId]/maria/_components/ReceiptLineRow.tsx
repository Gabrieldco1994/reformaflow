import type { ReceiptLineView } from "../_lib/import-receipt-view";

/** Read-only row over the approved snapshot: same grammar as the financial rows, no Expense fields. */
export function ReceiptLineRow({ line }: { line: ReceiptLineView }) {
  const meta = [line.outcomeLabel, line.purchaseDate]
    .filter(Boolean)
    .join(" · ");
  // Short schedules stay open; long ones (up to 24 approved occurrences) fold but remain fully readable.
  const openByDefault = line.occurrences.length <= 3;
  return (
    <li
      data-testid="receipt-line"
      className="space-y-2 rounded-2xl border border-lifeone-hairline bg-white px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-lifeone-ink">
            {line.title}
          </span>
          <span className="block text-[12px] text-lifeone-ink-3">{meta}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-[15px] font-semibold tabular-nums text-lifeone-ink">
          {line.totalLabel}
        </span>
      </div>
      <details
        open={openByDefault}
        className="rounded-xl bg-lifeone-surface px-3"
      >
        <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-semibold text-lifeone-ink-2">
          Cronograma aprovado ({line.occurrences.length}{" "}
          {line.occurrences.length === 1 ? "lançamento" : "lançamentos"})
        </summary>
        <ul className="divide-y divide-lifeone-hairline pb-2">
          {line.occurrences.map((occurrence) => (
            <li
              key={occurrence.index}
              data-testid="receipt-occurrence"
              className="flex items-start gap-3 py-2 text-[13px]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-lifeone-ink-2">
                  {occurrence.label}
                  {occurrence.dateLabel ? ` · ${occurrence.dateLabel}` : ""}
                </span>
                {occurrence.cycleLabel && (
                  <span className="block text-[12px] text-lifeone-ink-3">
                    Fatura {occurrence.cycleLabel}
                  </span>
                )}
              </span>
              <span className="shrink-0 whitespace-nowrap tabular-nums text-lifeone-ink">
                {occurrence.valueLabel}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <p className="text-[12px] text-lifeone-ink-3">
        Origem: <span className="text-lifeone-ink-2">{line.sourceName}</span>
      </p>
      {line.targets.length > 0 && (
        <ul className="space-y-1">
          {line.targets.map((target, index) => (
            <li key={index} className="flex items-center gap-3 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-lifeone-ink-2">
                → {target.name}
              </span>
              <span className="shrink-0 whitespace-nowrap tabular-nums text-lifeone-ink">
                {target.amountLabel}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
