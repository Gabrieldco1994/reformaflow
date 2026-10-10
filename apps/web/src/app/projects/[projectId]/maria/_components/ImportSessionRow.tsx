import type { ImportSessionSummaryV1 } from "@reformaflow/domain";
import { formatInstantBRT } from "../_lib/import-format";
import type { NameLookup } from "../_lib/import-receipt-view";
import { IMPORT_STATE_LABEL } from "../_lib/import-session-copy";

function dateLine(summary: ImportSessionSummaryV1): string | null {
  const applied = formatInstantBRT(summary.appliedAt);
  if (applied) return `Aplicada em ${applied}`;
  const expires = formatInstantBRT(summary.expiresAt);
  if (expires) return `Guardada até ${expires}`;
  const created = formatInstantBRT(summary.createdAt);
  return created ? `Criada em ${created}` : null;
}

/**
 * Same grammar as the financial rows (title truncates on the left, state chip nowrap on
 * the right, 44px+ target) but read-only: there is no Expense behind a recovery row.
 */
export function ImportSessionRow({
  summary,
  names,
  onOpen,
}: {
  summary: ImportSessionSummaryV1;
  names: NameLookup;
  onOpen: () => void;
}) {
  const documents = `${summary.attachmentCount} ${summary.attachmentCount === 1 ? "documento" : "documentos"}`;
  const date = dateLine(summary);
  return (
    <button
      type="button"
      data-testid="import-session-row"
      data-focus-key={`row:${summary.id}`}
      onClick={onOpen}
      className="flex min-h-[64px] w-full items-center gap-3 rounded-2xl border border-lifeone-hairline bg-white px-4 py-3 text-left shadow-lifeone-card"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-lifeone-ink">
          {names.card(summary.cardId)}
        </span>
        <span className="block truncate text-[13px] text-lifeone-ink-3">
          {names.project(summary.ownerProjectId)} · {documents}
        </span>
        {date && (
          <span className="block truncate text-[12px] text-lifeone-ink-3">
            {date}
          </span>
        )}
      </span>
      <span className="shrink-0 whitespace-nowrap rounded-full bg-lifeone-surface px-3 py-1 text-[12px] font-semibold text-lifeone-ink-2">
        {IMPORT_STATE_LABEL[summary.state]}
      </span>
    </button>
  );
}
