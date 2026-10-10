import {
  isImportQuestion,
  type ImportViewRead,
} from "../_lib/import-session-read";
import { isPendingImportQuestion } from "@reformaflow/domain";
import { moneyDetail } from "@/lib/money";
import { formatDateOnly, formatInstantBRT } from "../_lib/import-format";
import type { NameLookup } from "../_lib/import-receipt-view";
import {
  IMPORT_AMOUNT_MEANING_LABEL,
  IMPORT_STATE_LABEL,
} from "../_lib/import-session-copy";
import {
  ImportReviewBlockerNotice,
  ImportDeclaredFacts,
} from "./ImportReviewBlockerNotice";

/**
 * Read-only presentation of a session in ANY state. It takes props only, so states the
 * server cannot produce yet (NEEDS_INPUT, REVIEW_REQUIRED…) are rendered from fixtures.
 * Every user-supplied string (file name, question, title) is plain text.
 */
export function ImportSessionBody({
  view,
  names,
}: {
  view: ImportViewRead;
  names: NameLookup;
}) {
  const expires = formatInstantBRT(view.expiresAt);
  const pending = (question: ImportViewRead["questions"][number]) =>
    !isImportQuestion(question) || isPendingImportQuestion(question);
  const documents = `${view.attachments.length} ${view.attachments.length === 1 ? "documento" : "documentos"}`;
  return (
    <div data-testid="import-session-body" className="space-y-4">
      <div>
        <h3 className="text-[17px] font-bold text-lifeone-ink">
          {IMPORT_STATE_LABEL[view.state]} · {names.card(view.cardId)}
        </h3>
        <p className="text-[13px] text-lifeone-ink-3">
          {names.project(view.ownerProjectId)}
        </p>
        {expires && (
          <p className="mt-1 text-[13px] text-lifeone-ink-2">
            Guardada até {expires}. O rascunho expira após 7 dias sem edição
            sua; consultar esta tela não renova o prazo.
          </p>
        )}
      </div>

      <section className="space-y-2">
        <p className="text-[13px] font-semibold text-lifeone-ink-2">
          {documents}
        </p>
        {view.attachments.length > 0 && (
          <ul className="space-y-1">
            {view.attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="break-words text-[14px] text-lifeone-ink"
              >
                {attachment.fileName}
                <span className="block text-[12px] text-lifeone-ink-3">
                  {attachment.materializedInSession
                    ? "Análise documental guardada"
                    : "Análise documental pendente"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.questions.some(pending) && (
        <section className="space-y-2">
          <p className="text-[13px] font-semibold text-lifeone-ink-2">
            Perguntas pendentes
          </p>
          <ul className="space-y-1">
            {view.questions.filter(pending).map((question) => (
              <li key={question.id} className="text-[14px] text-lifeone-ink">
                {question.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.questions.some((question) => !pending(question)) && (
        <section className="space-y-2">
          <p className="text-[13px] font-semibold text-lifeone-ink-2">
            Informações guardadas
          </p>
          <ul className="space-y-1">
            {view.questions
              .filter((question) => !pending(question))
              .map((question) => (
                <li key={question.id} className="text-[14px] text-lifeone-ink">
                  {question.text}
                </li>
              ))}
          </ul>
        </section>
      )}

      {view.lines.length > 0 && (
        <section className="space-y-2">
          <p className="text-[13px] font-semibold text-lifeone-ink-2">
            Compras no rascunho
          </p>
          <ul className="space-y-2">
            {view.lines.map((line) => {
              const date = formatDateOnly(line.dataCompra);
              return (
                <li
                  key={line.id}
                  className="space-y-3 rounded-2xl border border-lifeone-hairline bg-white px-4 py-3"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-lifeone-ink">
                        {line.titulo || "Compra sem título"}
                      </span>
                      <span className="block text-[12px] text-lifeone-ink-3">
                        {IMPORT_AMOUNT_MEANING_LABEL[line.amountMeaning]}
                      </span>
                      {(line.installmentCount || date) && (
                        <span className="block text-[12px] text-lifeone-ink-3">
                          {[
                            line.installmentCount
                              ? `${line.installmentCount}x`
                              : null,
                            date,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                    {line.amountCents !== null && (
                      <span
                        data-workflow-money
                        className="shrink-0 whitespace-nowrap text-[15px] font-semibold tabular-nums text-lifeone-ink"
                      >
                        {moneyDetail(line.amountCents)}
                      </span>
                    )}
                  </div>
                  <ImportReviewBlockerNotice
                    line={line}
                    blockers={view.reviewBlockers}
                    selected={view.selectedLineIds.includes(line.id)}
                  />
                  {view.declaredFacts && (
                    <ImportDeclaredFacts
                      lineId={line.id}
                      facts={view.declaredFacts}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
