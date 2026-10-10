import type { ImportSessionDraftLineV1 } from "@reformaflow/domain";
import { moneyDetail } from "@/lib/money";
import { formatDateOnly } from "../_lib/import-format";

export type ImportPurchaseContext = Pick<
  ImportSessionDraftLineV1,
  "id" | "titulo"
> &
  Partial<
    Pick<
      ImportSessionDraftLineV1,
      "fornecedor" | "amountCents" | "dataCompra" | "installmentCount"
    >
  >;

export function ImportPurchaseStrip({
  line,
  ordinal,
  total,
}: {
  line: ImportPurchaseContext;
  ordinal: number;
  total: number;
}) {
  const merchant =
    line.fornecedor && line.fornecedor !== line.titulo ? line.fornecedor : null;
  return (
    <section
      aria-label={`Compra ${ordinal} de ${total}`}
      className="min-w-0 rounded-xl border border-darc-linen bg-lifeone-surface p-3 text-sm text-darc-velvet"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-lifeone-ink-3">
        Compra {ordinal} de {total}
      </p>
      <p className="mt-1 break-words font-semibold">
        {line.titulo || "Compra sem descrição"}
      </p>
      {merchant && <p className="break-words">{merchant}</p>}
      <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-lifeone-ink-2">
        <span>
          {formatDateOnly(line.dataCompra) ?? "data não identificada"}
        </span>
        <span className="whitespace-nowrap tabular-nums">
          {line.amountCents == null
            ? "valor não identificado"
            : moneyDetail(line.amountCents)}
        </span>
        {line.installmentCount != null && (
          <span>{line.installmentCount} parcelas</span>
        )}
      </div>
    </section>
  );
}
