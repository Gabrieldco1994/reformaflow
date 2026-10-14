"use client";

import { useState, useId } from "react";
import { useEffect } from "react";
import type { ImportObservationView } from "../_lib/import-session-workflow-read";
import { useImportObservations } from "../_hooks/useImportObservations";

const IGNORED_REASON_LABEL: Record<
  NonNullable<ImportObservationView["ignoredReason"]>,
  string
> = {
  INVOICE_PAYMENT:
    "Pagamento de fatura de cartão não é uma compra e não será importado.",
};

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
  onIgnoredCountChange,
}: {
  sessionId: string;
  userId: string;
  revision: number;
  onIgnoredCountChange?: (count: number) => void;
}) {
  const query = useImportObservations(userId, sessionId, revision);
  const ignored = query.data?.filter(
    (observation) => observation.ignoredReason === "INVOICE_PAYMENT",
  );
  useEffect(() => {
    if (query.data)
      onIgnoredCountChange?.(
        query.data.filter(
          (observation) => observation.ignoredReason === "INVOICE_PAYMENT",
        ).length,
      );
  }, [query.data, onIgnoredCountChange]);

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
