import {
  IMPORT_SESSION_LIMITS,
  type ImportSessionDraftLineV1,
} from "@reformaflow/domain";
import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/utils";

type SelectionStatus = "SELECTED" | "DEFERRED" | "AVAILABLE" | "IGNORED_POLICY";
type IgnoredReason = Extract<
  ImportSessionDraftLineV1["decision"],
  { kind: "IGNORED_POLICY" }
>["reason"];

const STATUS_LABEL: Record<SelectionStatus, string> = {
  SELECTED: "Precisa de resposta",
  DEFERRED: "Ficará para depois",
  AVAILABLE: "Disponível para retomar",
  IGNORED_POLICY: "Ignorada por política",
};

const IGNORED_REASON: Record<IgnoredReason, string> = {
  INVOICE_PAYMENT:
    "Pagamento de fatura ignorado por política. Ele continua visível nesta importação.",
  CARD_PAYS_CARD:
    "Pagamento entre cartões ignorado por política. Ele continua visível nesta importação.",
};

export function ImportSelectionRow({
  line,
  selected,
  selectionAtLimit,
  pending,
  onAdd,
  onRemove,
  children,
  ordinal = 1,
  total = 1,
}: {
  line: ImportSessionDraftLineV1;
  selected: boolean;
  selectionAtLimit: boolean;
  pending: boolean;
  onAdd?: (lineId: string) => void;
  onRemove?: (lineId: string) => void;
  children?: ReactNode;
  ordinal?: number;
  total?: number;
}) {
  const ignored =
    line.decision.kind === "IGNORED_POLICY" ? line.decision : null;
  const status: SelectionStatus = ignored
    ? "IGNORED_POLICY"
    : selected
      ? "SELECTED"
      : line.decision.kind === "DEFER"
        ? "DEFERRED"
        : "AVAILABLE";
  const mayAdd = status === "DEFERRED" && !selectionAtLimit && onAdd;

  return (
    <section
      role="group"
      aria-label={`Compra ${ordinal} de ${total}: ${STATUS_LABEL[status]}`}
      className={`min-w-0 space-y-3 rounded-xl border p-3 text-sm text-lifeone-ink ${
        status === "SELECTED"
          ? "border-brand-600 bg-brand-50"
          : status === "IGNORED_POLICY"
            ? "border-lifeone-hairline bg-lifeone-surface"
            : "border-lifeone-hairline bg-white"
      }`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-semibold">
            {line.titulo || "Compra sem descrição"}
          </p>
          {line.fornecedor && (
            <p className="break-words text-lifeone-ink-2">{line.fornecedor}</p>
          )}
        </div>
        <p className="shrink-0 whitespace-nowrap font-semibold tabular-nums">
          {line.amountCents === null
            ? "Valor não informado"
            : formatCurrency(line.amountCents / 100)}
        </p>
      </div>

      <p className="font-medium">{STATUS_LABEL[status]}</p>
      {status === "DEFERRED" && (
        <p>Esta compra ficou fora do lote atual e pode ser retomada depois.</p>
      )}
      {ignored && <p>{IGNORED_REASON[ignored.reason]}</p>}
      {status === "AVAILABLE" && selectionAtLimit && (
        <p>
          Limite de {IMPORT_SESSION_LIMITS.selectedLines} compras selecionadas
          atingido. Retire uma compra para adicionar esta.
        </p>
      )}

      {status === "SELECTED" && onRemove && (
        <button
          type="button"
          disabled={pending}
          aria-label={`Responder depois à compra ${ordinal} de ${total}`}
          onClick={() => onRemove(line.id)}
          className="min-h-11 rounded-xl border border-brand-600 px-3 font-medium text-brand-700 focus-visible:outline focus-visible:outline-2"
        >
          Responder depois
        </button>
      )}
      {mayAdd && (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAdd?.(line.id)}
          className="min-h-11 rounded-xl bg-brand-600 px-3 font-medium text-white focus-visible:outline focus-visible:outline-2"
        >
          Continuar compra {ordinal} de {total}
        </button>
      )}

      {children}
    </section>
  );
}
