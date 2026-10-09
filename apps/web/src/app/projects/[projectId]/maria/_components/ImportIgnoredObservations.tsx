"use client";

import { useState, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { IMPORT_SESSION_LIMITS } from "@reformaflow/domain";
import { getImportObservations } from "../_lib/import-session-api";
import { importKeys } from "../_lib/import-session-keys";
import { ImportWorkflowResponseError } from "../_lib/import-session-workflow-read";
import type { ImportObservationView } from "../_lib/import-session-workflow-read";

const IGNORED_REASON_LABEL: Record<
  NonNullable<ImportObservationView["ignoredReason"]>,
  string
> = {
  INVOICE_PAYMENT:
    "Pagamento de fatura de cartão não é uma compra e não será importado.",
};

async function readAllObservations(
  sessionId: string,
  signal: AbortSignal,
): Promise<ImportObservationView[]> {
  const observations: ImportObservationView[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  const maxPages = Math.ceil(
    IMPORT_SESSION_LIMITS.parsedRowsPerSession / IMPORT_SESSION_LIMITS.pageSize,
  );
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await getImportObservations(sessionId, cursor, signal);
    for (const item of page.items) {
      if (seenIds.has(item.id)) throw new ImportWorkflowResponseError();
      seenIds.add(item.id);
      observations.push(item);
    }
    if (observations.length > IMPORT_SESSION_LIMITS.parsedRowsPerSession)
      throw new ImportWorkflowResponseError();
    if (page.nextCursor === null) return observations;
    if (seenCursors.has(page.nextCursor))
      throw new ImportWorkflowResponseError();
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new ImportWorkflowResponseError();
}

function IgnoredObservation({
  observation,
}: {
  observation: ImportObservationView;
}) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  if (!observation.ignoredReason) return null;
  const label =
    observation.text.trim() || `Lançamento ${observation.reference}`;

  return (
    <li>
      <article
        role="group"
        aria-label={`Linha ignorada: ${label}`}
        className="space-y-2 rounded-xl border border-lifeone-hairline bg-lifeone-surface p-3 text-sm"
      >
        <p className="break-words">{label}</p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={reasonId}
          onClick={() => setOpen((value) => !value)}
          className="min-h-11 rounded-xl border border-lifeone-hairline bg-white px-3 font-semibold"
        >
          {open ? "Ocultar motivo" : "Ver motivo"}
        </button>
        {open && (
          <p id={reasonId} role="status" className="text-lifeone-ink-2">
            {IGNORED_REASON_LABEL[observation.ignoredReason]}
          </p>
        )}
      </article>
    </li>
  );
}

export function ImportIgnoredObservations({
  sessionId,
  userId,
  revision,
}: {
  sessionId: string;
  userId: string;
  revision: number;
}) {
  const query = useQuery({
    queryKey: importKeys.observations(userId, sessionId, revision),
    queryFn: ({ signal }) => readAllObservations(sessionId, signal),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const ignored = query.data?.filter(
    (observation) => observation.ignoredReason === "INVOICE_PAYMENT",
  );

  if (query.isPending)
    return <p role="status">Consultando itens não importados…</p>;
  if (query.isError)
    return (
      <div role="alert" className="space-y-2 text-sm text-darc-red">
        <p>Não foi possível consultar os itens não importados.</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="min-h-11 rounded-xl border px-3"
        >
          Consultar novamente
        </button>
      </div>
    );
  if (!ignored?.length) return null;

  return (
    <section
      aria-label="Cobranças não importadas"
      className="space-y-2 rounded-xl border border-lifeone-hairline p-3"
    >
      <h3 className="font-semibold">Cobranças não importadas</h3>
      <ul className="space-y-2">
        {ignored.map((observation) => (
          <IgnoredObservation key={observation.id} observation={observation} />
        ))}
      </ul>
    </section>
  );
}
