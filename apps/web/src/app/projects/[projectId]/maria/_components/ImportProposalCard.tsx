"use client";

import { useEffect, useId, useRef } from "react";
import {
  isPendingImportQuestion,
  type ExpenseScheduleV1,
  type ImportSessionState,
} from "@reformaflow/domain";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";
import { moneyDetail } from "@/lib/money";
import { catMaoLabel, tipoLabel } from "@/lib/expense-options";
import { useImportExecution } from "../_hooks/useImportExecution";
import {
  formatDateOnly,
  formatDueMonth,
  formatInstantBRT,
} from "../_lib/import-format";
import {
  buildReceiptView,
  KEEP_EXISTING_TITLE,
} from "../_lib/import-receipt-view";
import { IMPORT_STATE_LABEL } from "../_lib/import-session-copy";
import { ImportReceipt } from "./ImportReceipt";
import {
  ImportReviewBlockerNotice,
  ImportDeclaredFacts,
} from "./ImportReviewBlockerNotice";

const STATE_LABEL: Record<ImportSessionState, string> = {
  ...IMPORT_STATE_LABEL,
  CONFIRMED: "Confirmada; aguardando aplicação",
  APPLIED: "Resultado guardado",
};
const focusStyle =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-darc-red motion-reduce:transition-none";

function Money({ cents }: { cents: number }) {
  return (
    <span
      data-workflow-money
      className={`${journeyStyles.money} shrink-0 font-semibold`}
    >
      {moneyDetail(cents)}
    </span>
  );
}

function Schedule({
  schedule,
  label,
}: {
  schedule: ExpenseScheduleV1;
  label: string;
}) {
  return (
    <details open className="min-w-0 rounded-xl bg-lifeone-surface p-3">
      <summary className={`cursor-pointer text-sm font-semibold ${focusStyle}`}>
        {label} ({schedule.occurrences.length} lançamentos)
      </summary>
      <p className="py-2 text-xs text-lifeone-ink-3">
        Primeiro: {formatDateOnly(schedule.occurrences[0].data)} · Último:{" "}
        {formatDateOnly(
          schedule.occurrences[schedule.occurrences.length - 1].data,
        )}
      </p>
      <ol className="divide-y divide-lifeone-hairline">
        {schedule.occurrences.map((occurrence) => (
          <li
            key={occurrence.index}
            className="flex items-start justify-between gap-3 py-2 text-sm"
          >
            <span className="min-w-0 break-words">
              <span className="block">
                {occurrence.parcela
                  ? `Parcela ${occurrence.parcela}`
                  : "Lançamento"}{" "}
                · {formatDateOnly(occurrence.data)}
              </span>
              <span className="block text-xs text-lifeone-ink-3">
                {occurrence.invoiceDueMonth === null
                  ? "Ciclo não informado"
                  : `Fatura ${formatDueMonth(occurrence.invoiceDueMonth)}`}
              </span>
            </span>
            <Money cents={occurrence.valor} />
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Candidate only: no route, chat, upload or recovery entry mounts this component. */
export function ImportProposalCard({
  sessionId,
  onRemoveSelected,
  onOpenContinuation,
  selectionPending = false,
  externalCandidateEvidence = {},
}: {
  sessionId: string;
  onRemoveSelected?: (lineId: string) => void;
  onOpenContinuation?: (sessionId: string) => void;
  selectionPending?: boolean;
  externalCandidateEvidence?: Readonly<Record<string, string>>;
}) {
  const workflow = useImportExecution(sessionId);
  const { view, catalog, pending, error, notice, financialAction } = workflow;
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (workflow.settled) heading.current?.focus();
  }, [workflow.settled]);
  const proposal = view?.proposal;
  const receipt =
    view?.receipt && catalog
      ? buildReceiptView(view.receipt, catalog.names)
      : null;
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={pending}
      className={`${journeyStyles.journey} min-w-0 space-y-4 rounded-2xl border border-lifeone-hairline bg-white p-4 text-lifeone-ink`}
    >
      <h2
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className={`text-lg font-bold ${focusStyle}`}
      >
        Revisão do lote
      </h2>
      {view && (
        <p className="text-sm text-lifeone-ink-2">
          {STATE_LABEL[view.state]} · Revisão {view.revision}
        </p>
      )}
      {pending && (
        <p role="status" className="text-sm">
          Consultando revisão…
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-lifeone-ink-2">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-darc-red">
          {error}
        </p>
      )}
      {view && catalog && (
        <p className="break-words text-sm">
          Origem: {catalog.names.project(view.ownerProjectId)} ·{" "}
          {catalog.names.card(view.cardId)}
        </p>
      )}
      {view &&
        view.lines.map((line) => (
          <ImportReviewBlockerNotice
            key={line.id}
            line={line}
            blockers={view.reviewBlockers}
            selected={view.selectedLineIds.includes(line.id)}
            externalProviderEvidence={externalCandidateEvidence[line.id]}
            hasQuestion={view.questions.some(
              (q) =>
                !("subject" in q) &&
                isPendingImportQuestion(q) &&
                q.lineIds.includes(line.id),
            )}
            pending={pending || selectionPending || Boolean(error)}
            onRemove={
              view.actions.includes("RESOLVE") ? onRemoveSelected : undefined
            }
          />
        ))}
      {receipt ? (
        <ImportReceipt view={receipt} onOpenContinuation={onOpenContinuation} />
      ) : (
        proposal &&
        catalog && (
          <>
            <p className="text-sm text-lifeone-ink-2">
              Confira as compras, as finalidades e todos os lançamentos. Este
              resumo não registra pagamentos.
            </p>
            <dl className="space-y-2 rounded-xl bg-lifeone-surface p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <dt className="min-w-0 flex-1 break-words">Total a criar</dt>
                <dd className="shrink-0">
                  <Money cents={proposal.createdEconomicTotalCents} />
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="min-w-0 flex-1 break-words">
                  Efeito no caixa do banco
                </dt>
                <dd className="shrink-0">
                  <Money cents={proposal.bankCashDeltaCents} />
                </dd>
              </div>
              {proposal.invoiceDeltas.map((delta, index) => (
                <div
                  key={index}
                  className="flex items-start justify-between gap-3"
                >
                  <dt className="min-w-0 flex-1 break-words">
                    Efeito na fatura {formatDueMonth(delta.invoiceDueMonth)}
                  </dt>
                  <dd className="shrink-0">
                    <Money cents={delta.amountCents} />
                  </dd>
                </div>
              ))}
            </dl>
            {/* Drafts have no MovimentacaoRow account IDs/actions; keep its title/meta/money anatomy. */}
            <ol aria-label="Compras do lote" className="space-y-4">
              {proposal.lines.map((line, index) => (
                <li
                  key={line.lineId}
                  className="min-w-0 space-y-3 rounded-xl border border-lifeone-hairline p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 basis-full break-words">
                      <p className="text-xs text-lifeone-ink-3">
                        Compra {index + 1} ·{" "}
                        {line.kind === "CREATE"
                          ? "A criar"
                          : "Manter existente"}
                      </p>
                      <h3 className="font-semibold">
                        {line.kind === "CREATE"
                          ? line.titulo
                          : KEEP_EXISTING_TITLE}
                      </h3>
                      {line.kind === "CREATE" && (
                        <p className="text-sm text-lifeone-ink-2">
                          {line.fornecedor !== null && `${line.fornecedor} · `}
                          {tipoLabel(line.tipoDespesa)}
                          {line.categoriaMaoDeObra !== null &&
                            ` · ${catMaoLabel(line.categoriaMaoDeObra)}`}
                          {" · "}
                          {formatDateOnly(line.dataCompra)}
                        </p>
                      )}
                    </div>
                    <Money cents={line.totalCents} />
                  </div>
                  {view && line.kind === "CREATE" && (
                    <>
                      <ImportDeclaredFacts
                        lineId={line.lineId}
                        facts={view.declaredFacts}
                      />
                      <div
                        role="group"
                        aria-label="Total do plano"
                        className="space-y-1 text-sm"
                      >
                        <p>Total do plano</p>
                        <Money cents={line.totalCents} />
                      </div>
                      {!view.declaredFacts.some(
                        (fact) =>
                          fact.lineId === line.lineId &&
                          fact.field === "dataCompra",
                      ) && (
                        <div
                          role="group"
                          aria-label="Data da compra"
                          className="space-y-1 text-sm"
                        >
                          <p>Data da compra no plano</p>
                          <p>{formatDateOnly(line.dataCompra)}</p>
                        </div>
                      )}
                    </>
                  )}
                  <Schedule
                    schedule={line.schedule}
                    label="Cronograma da origem"
                  />
                  {line.kind === "CREATE" &&
                    (line.targets.length === 0 ? (
                      <p className="text-sm">
                        Sem destino adicional; permanece na origem.
                      </p>
                    ) : (
                      <ul
                        aria-label={`Finalidades da compra ${index + 1}`}
                        className="space-y-3"
                      >
                        {line.targets.map((target) => (
                          <li key={target.projectId} className="space-y-2">
                            <div className="flex items-start justify-between gap-3 text-sm">
                              <span className="min-w-0 break-words">
                                Finalidade:{" "}
                                {catalog.names.project(target.projectId)}
                                {target.roomId !== null &&
                                  ` · ${catalog.rooms.get(`${target.projectId}/${target.roomId}`)}`}
                              </span>
                              <Money cents={target.amountCents} />
                            </div>
                            <Schedule
                              schedule={target.schedule}
                              label="Cronograma da finalidade"
                            />
                          </li>
                        ))}
                      </ul>
                    ))}
                </li>
              ))}
            </ol>
            {(proposal.deferredObservationIds.length > 0 ||
              proposal.deferredAttachmentIds.length > 0) && (
              <div className="space-y-1 rounded-xl border border-lifeone-hairline p-3 text-sm">
                <h3 className="font-semibold">Pendências fora deste lote</h3>
                <p>
                  {proposal.deferredObservationIds.length} observação(ões) e{" "}
                  {proposal.deferredAttachmentIds.length} anexo(s) não fazem
                  parte deste lote e não serão chamados de importados.
                </p>
                <p>
                  Retidos pelo menos até{" "}
                  {formatInstantBRT(proposal.retainUntil)}.
                </p>
              </div>
            )}
          </>
        )
      )}
      {view && view.questions.some(isPendingImportQuestion) && (
        <ul aria-label="Pendências da revisão" className="space-y-2 text-sm">
          {view.questions.filter(isPendingImportQuestion).map((question) => (
            <li key={question.id} className="break-words">
              {question.text} —{" "}
              {question.lineIds
                .map((id) => view.lines.find((line) => line.id === id)?.titulo)
                .join("; ")}
            </li>
          ))}
        </ul>
      )}
      {!pending && !error && view && !financialAction && !receipt && (
        <p className="text-sm text-lifeone-ink-3">
          Nenhuma ação financeira está disponível nesta revisão.
        </p>
      )}
      {financialAction && (
        <div className="space-y-3">
          {financialAction === "CONFIRM" && (
            <p className="text-sm">
              Ao confirmar, você aprova o conjunto exibido, incluindo as
              informações que forneceu. Isso não altera o documento original.
            </p>
          )}
          <Button
            className={`min-h-11 w-full ${focusStyle}`}
            onClick={() => void workflow.act()}
          >
            {financialAction === "CONFIRM"
              ? "Confirmar lote"
              : "Aplicar lote confirmado"}
          </Button>
        </div>
      )}
      {(error ||
        (!financialAction && view?.actions.includes("READ_RESULT"))) && (
        <Button
          variant="ghost"
          disabled={pending}
          className={`w-full ${focusStyle}`}
          onClick={() => void workflow.retry()}
        >
          {error ? "Consultar novamente" : "Consultar estado guardado"}
        </Button>
      )}
    </section>
  );
}
