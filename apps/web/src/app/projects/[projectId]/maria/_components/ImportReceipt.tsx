import type { ReceiptView } from "../_lib/import-receipt-view";
import { ReceiptLineRow } from "./ReceiptLineRow";

export function ImportReceipt({
  view,
  onOpenContinuation,
}: {
  view: ReceiptView;
  onOpenContinuation?: (sessionId: string) => void;
}) {
  return (
    <div data-testid="import-receipt" className="space-y-4">
      <div>
        <h3 className="text-[17px] font-bold text-lifeone-ink">
          Comprovante da importação
        </h3>
        {view.appliedAtLabel && (
          <p className="text-[13px] text-lifeone-ink-3">
            Aplicada em {view.appliedAtLabel}
          </p>
        )}
      </div>

      <dl className="space-y-1 rounded-2xl border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[14px]">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-lifeone-ink-2">Total criado</dt>
          <dd className="whitespace-nowrap font-semibold tabular-nums text-lifeone-ink">
            {view.createdTotalLabel}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-lifeone-ink-2">Efeito no caixa do banco</dt>
          <dd className="whitespace-nowrap tabular-nums text-lifeone-ink">
            {view.bankCashDeltaLabel}
          </dd>
        </div>
        {view.invoiceDeltas.map((delta) => (
          <div
            key={delta.monthLabel}
            className="flex items-center justify-between gap-3"
          >
            <dt className="text-lifeone-ink-2">Fatura de {delta.monthLabel}</dt>
            <dd className="whitespace-nowrap tabular-nums text-lifeone-ink">
              {delta.amountLabel}
            </dd>
          </div>
        ))}
      </dl>

      <ul className="space-y-2">
        {view.lines.map((line) => (
          <ReceiptLineRow key={line.lineId} line={line} />
        ))}
      </ul>

      {view.continuationSessionId && onOpenContinuation && (
        <button
          type="button"
          onClick={() =>
            onOpenContinuation(view.continuationSessionId as string)
          }
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-lifeone-hairline bg-white px-4 text-[14px] font-semibold text-lifeone-ink"
        >
          Ver rascunho restante
        </button>
      )}
    </div>
  );
}
