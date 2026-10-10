"use client";

import { useEffect, useId, useRef } from "react";
import type { ImportCurrentLotV1 } from "@reformaflow/domain";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";
import { moneyDetail } from "@/lib/money";
import { formatDateOnly, formatDueMonth } from "../_lib/import-format";

const ACTION_LABEL: Record<ImportCurrentLotV1["actions"][number], string> = {
  CONFIRM: "Confirmar compras deste lote",
  EXECUTE: "Aplicar compras confirmadas",
};

type Props = {
  lot?: ImportCurrentLotV1 | null;
  pending?: boolean;
  error?: string | null;
  notice?: string | null;
  onConfirm?: () => void;
  /**
   * Compatibility-only props for callers still being removed from the route.
   * They never trigger a full-session review read.
   */
  sessionId?: string;
  onRemoveSelected?: (lineId: string) => void;
  selectionPending?: boolean;
};

function Money({ cents }: { cents: number }) {
  return (
    <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">
      {moneyDetail(cents)}
    </span>
  );
}

export function ImportProposalCard({
  lot,
  pending = false,
  error = null,
  notice = null,
  onConfirm,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (lot) heading.current?.focus();
  }, [lot]);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const action = lot?.actions.includes("CONFIRM")
    ? "CONFIRM"
    : lot?.actions.includes("EXECUTE")
      ? "EXECUTE"
      : null;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={pending}
      className={`${journeyStyles.journey} min-w-0 space-y-4 rounded-2xl border border-lifeone-hairline bg-white p-4 pb-6 text-lifeone-ink`}
    >
      <h2
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className="text-lg font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-darc-red"
      >
        Revisão do lote
      </h2>
      <p className="text-sm text-lifeone-ink-2">
        Confira o que será adicionado. Confirmar continua sendo uma ação
        separada.
      </p>
      {pending && <p role="status">Consultando compras prontas…</p>}
      {notice && (
        <p
          ref={noticeRef}
          role="status"
          tabIndex={-1}
          className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-darc-red"
        >
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-darc-red">
          {error}
        </p>
      )}
      {!lot && !pending && !error && !notice && (
        <p role="status">A revisão das compras prontas ainda não foi aberta.</p>
      )}
      {lot && (
        <>
          <section
            aria-labelledby={`${headingId}-included`}
            className="space-y-3"
          >
            <div>
              <h3 id={`${headingId}-included`} className="font-semibold">
                Entram neste lote
              </h3>
              <p className="text-sm text-lifeone-ink-2">
                {lot.purchases.length === 1
                  ? "1 compra pronta"
                  : `${lot.purchases.length} compras prontas`}
              </p>
            </div>
            <ol aria-label="Compras prontas deste lote" className="space-y-3">
              {lot.purchases.map((purchase, index) => (
                <li
                  key={`${purchase.title}:${purchase.purchaseDate}:${index}`}
                  className="min-w-0 space-y-2 rounded-xl border border-darc-linen p-3"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-semibold">
                        {purchase.title}
                      </p>
                      {purchase.merchant &&
                        purchase.merchant !== purchase.title && (
                          <p className="break-words text-sm text-lifeone-ink-2">
                            {purchase.merchant}
                          </p>
                        )}
                    </div>
                    <Money cents={purchase.totalCents} />
                  </div>
                  <p className="text-sm text-lifeone-ink-2">
                    {formatDateOnly(purchase.purchaseDate)}
                    {purchase.installmentIndex !== null &&
                      purchase.installmentCount !== null &&
                      ` · Parcela ${purchase.installmentIndex} de ${purchase.installmentCount}`}
                  </p>
                  <p className="text-sm font-medium">
                    {purchase.disposition === "CREATE"
                      ? "Será adicionada"
                      : "Compra existente será mantida"}
                  </p>
                  <details className="rounded-xl bg-lifeone-surface p-3 text-sm">
                    <summary
                      aria-label={`Ver detalhes de ${purchase.title}, compra ${index + 1}`}
                      className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-darc-red"
                    >
                      Ver detalhes
                    </summary>
                    <div className="space-y-3 pt-2">
                      {purchase.targets.map((target, targetIndex) => (
                        <div
                          key={`${target.projectLabel}:${target.roomLabel}:${targetIndex}`}
                          className="flex min-w-0 items-start justify-between gap-3"
                        >
                          <span className="min-w-0 break-words">
                            {target.projectLabel}
                            {target.roomLabel ? ` · ${target.roomLabel}` : ""}
                          </span>
                          <Money cents={target.amountCents} />
                        </div>
                      ))}
                      {purchase.schedule.occurrences.map((occurrence) => (
                        <div
                          key={occurrence.index}
                          className="flex items-start justify-between gap-3"
                        >
                          <span>
                            {occurrence.parcela ?? "Lançamento"} ·{" "}
                            {formatDateOnly(occurrence.data)}
                          </span>
                          <Money cents={occurrence.valor} />
                        </div>
                      ))}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          </section>

          <dl className="space-y-2 rounded-xl bg-lifeone-surface p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <dt>Total das compras deste lote</dt>
              <dd>
                <Money cents={lot.createdEconomicTotalCents} />
              </dd>
            </div>
            {lot.invoiceDeltas.map((delta) => (
              <div
                key={delta.invoiceDueMonth}
                className="flex items-start justify-between gap-3"
              >
                <dt>Fatura {formatDueMonth(delta.invoiceDueMonth)}</dt>
                <dd>
                  <Money cents={delta.amountCents} />
                </dd>
              </div>
            ))}
          </dl>

          {lot.hasRemainingWork && (
            <p className="rounded-xl border border-darc-linen bg-lifeone-surface p-3 text-sm">
              Há outras compras fora deste lote. Elas continuam no rascunho para
              depois.
            </p>
          )}

          <p className="text-sm">
            Ao confirmar, somente as compras mostradas em “Entram neste lote”
            serão adicionadas.
          </p>
          {action && (
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={pending || Boolean(error) || !onConfirm}
              onClick={onConfirm}
            >
              {ACTION_LABEL[action]}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
