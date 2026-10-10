import { formatCurrency, formatDateBR } from "@/lib/utils";
import type { CardImportReviewItem } from "@reformaflow/domain";
import { isBlockedReview } from "../_lib/import-review";

const REASON_COPY: Record<string, string> = {
  REVIEW_REQUIRED:
    "Já existe uma compra parecida neste cartão, com o mesmo número de parcelas, mas com valor por parcela diferente.",
  REVIEW_STALE:
    "O que você viu mudou antes de confirmar. Confira de novo as compras abaixo.",
  BLOCKED_IDENTITY:
    "Esta linha está bloqueada para importação e não há como liberá-la aqui.",
};

interface Props {
  review: CardImportReviewItem;
  /** true quando o usuário marcou "É outra compra" para o fingerprint atual. */
  consented: boolean;
  onToggle: (next: boolean) => void;
}

export function ReviewCandidatesNotice({ review, consented, onToggle }: Props) {
  const blocked = isBlockedReview(review);
  const canConsent = !blocked && !!review.fingerprint;
  return (
    <div className="mt-2 rounded-r-lg border-l-2 border-orange-400 bg-orange-50 py-1.5 pl-3 pr-2">
      <p className="text-xs font-medium text-orange-800">
        {blocked ? "⛔ Bloqueada" : "⚠ Possível mesma compra"}
      </p>
      <p className="text-xs text-orange-700">
        {REASON_COPY[review.reason] ??
          "Esta linha precisa da sua decisão antes de ser importada."}
      </p>
      {review.candidates.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-orange-900">
          {review.candidates.map((c) => (
            <li key={c.expenseId} className="break-words">
              {c.titulo ?? "(sem título)"} · {c.installmentCount}×{" "}
              <span className="whitespace-nowrap font-medium">
                {formatCurrency(c.seriesAmountCents / 100)}
              </span>
              {c.dataCompra ? <> · {formatDateBR(c.dataCompra)}</> : null}
            </li>
          ))}
        </ul>
      )}
      {!blocked && !canConsent && (
        <p className="mt-1 text-xs text-orange-800">
          Não há mais nada para confirmar aqui. Gere uma nova prévia para
          conferir de novo.
        </p>
      )}
      {canConsent && (
        <>
          <label className="mt-1 inline-flex min-h-11 items-center gap-2 text-xs font-medium text-orange-900">
            <input
              type="checkbox"
              checked={consented}
              onChange={(event) => onToggle(event.currentTarget.checked)}
              className="h-4 w-4 shrink-0 accent-orange-600"
            />
            É outra compra
          </label>
          {!consented && (
            <span className="sr-only">
              Esta linha não será importada enquanto a caixa não for marcada.
            </span>
          )}
        </>
      )}
    </div>
  );
}
