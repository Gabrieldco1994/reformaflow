"use client";

import type { ImportSessionSummaryV1 } from "@reformaflow/domain";
import type { ImportListState } from "../_hooks/useImportSessions";
import type { NameLookup } from "../_lib/import-receipt-view";
import { describeImportFailure } from "../_lib/import-session-errors";
import { ImportFailureNotice } from "./ImportFailureNotice";
import { ImportSessionRow } from "./ImportSessionRow";

const STALE =
  "Não foi possível carregar mais importações. O que aparece pode estar desatualizado.";

export function ImportSessionList({
  list,
  names,
  onOpen,
}: {
  list: ImportListState;
  names: NameLookup;
  onOpen: (summary: ImportSessionSummaryV1) => void;
}) {
  if (list.status === "loading" || list.status === "disabled") {
    return (
      <p role="status" className="text-[14px] text-lifeone-ink-3">
        Carregando importações…
      </p>
    );
  }
  if (list.status === "error" && list.failure) {
    const info = describeImportFailure(list.failure, "list");
    return (
      <ImportFailureNotice
        message={info.message}
        actionLabel={info.retryable ? "Tentar de novo" : "Recomeçar a lista"}
        onAction={() => void list.restart()}
      />
    );
  }
  return (
    <div className="space-y-3">
      {list.failedNext && (
        <ImportFailureNotice
          message={STALE}
          actionLabel="Recomeçar a lista"
          onAction={() => void list.restart()}
        />
      )}
      {list.freshness === "refreshing" && (
        <p role="status" className="text-[13px] text-lifeone-ink-3">
          Atualizando…
        </p>
      )}
      {list.items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-lifeone-hairline px-4 py-6 text-center text-[14px] text-lifeone-ink-3">
          Nenhuma importação para retomar
        </p>
      ) : (
        <ul className="space-y-2">
          {list.items.map((summary) => (
            <li key={summary.id}>
              <ImportSessionRow
                summary={summary}
                names={names}
                onOpen={() => onOpen(summary)}
              />
            </li>
          ))}
        </ul>
      )}
      {list.hasMore && !list.failedNext && (
        <button
          type="button"
          disabled={list.loadingMore}
          onClick={() => void list.loadMore()}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-lifeone-hairline bg-white px-4 text-[14px] font-semibold text-lifeone-ink disabled:opacity-60"
        >
          {list.loadingMore ? "Carregando…" : "Ver mais"}
        </button>
      )}
    </div>
  );
}
