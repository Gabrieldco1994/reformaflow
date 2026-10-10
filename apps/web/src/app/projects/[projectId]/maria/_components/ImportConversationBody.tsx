"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { useSpeechRecognition } from "@/components/agent/useSpeechRecognition";
import { Button } from "@/components/ui/button";
import { useImportConversation } from "../_hooks/useImportConversation";
import {
  useImportDocumentFlow,
  type ImportDocumentFlow,
} from "../_hooks/useImportDocumentFlow";
import { useImportExecution } from "../_hooks/useImportExecution";
import { useImportUserId } from "../_hooks/useImportSessions";
import { ImportFocusedQuestion } from "./ImportFocusedQuestion";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { ImportProposalCard } from "./ImportProposalCard";
import { ImportSelectionRow } from "./ImportSelectionRow";

const IMPORT_CONVERSATION_SCROLL_STYLE = {
  paddingBottom: "calc(var(--rf-bottom-chrome, 0px) + 12px)",
  scrollPaddingBottom: "calc(var(--rf-bottom-chrome, 0px) + 12px)",
} satisfies CSSProperties;

function Conversation({
  sessionId,
  documents,
}: {
  sessionId: string | null;
  documents: ImportDocumentFlow;
}) {
  const conversation = useImportConversation(sessionId, true);
  const execution = useImportExecution(sessionId, conversation.currentLot);
  const speech = useSpeechRecognition();
  const reviewRef = useRef<HTMLDivElement>(null);
  const consultRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const changedAlertRef = useRef<HTMLDivElement>(null);
  const reviewActionRef = useRef<HTMLButtonElement>(null);
  const upToDateRef = useRef<HTMLParagraphElement>(null);
  const { view, question, error, currentLot } = conversation;
  const { guidedReview, guidedFocus } = conversation;
  const busy = conversation.busy || documents.busy || execution.pending;
  const privateContextLost =
    error?.privateContextLost || documents.error?.privateContextLost;
  const selectionRecoveryReady = Boolean(conversation.retryableSelection);
  const selectionActionsBlocked =
    Boolean(error) || selectionRecoveryReady || Boolean(documents.error);

  useEffect(() => {
    if (currentLot) reviewRef.current?.scrollIntoView({ block: "start" });
  }, [currentLot]);

  const activeLine = question
    ? view?.lines.find((line) =>
        guidedFocus
          ? line.id === guidedFocus.lineId
          : question.lineIds.includes(line.id),
      )
    : null;
  const deferredLines =
    view?.lines.filter(
      (line) =>
        line.decision.kind === "DEFER" &&
        !view.selectedLineIds.includes(line.id),
    ) ?? [];
  const canResolve = Boolean(view?.actions.includes("RESOLVE"));
  const canPrepare = guidedReview
    ? guidedReview.actions.some((action) => action === "REVIEW_READY")
    : Boolean(
        view?.actions.some((action) =>
          ["PREPARE", "CONFIRM", "EXECUTE"].includes(action),
        ),
      );
  const selectionFocus = conversation.selectionRecoveryFocus;
  const guidedChoicePending = guidedReview?.progress === "READY_WITH_PENDING";
  const guidedPreparationPending =
    guidedReview?.progress === "ANSWERING" &&
    guidedReview.focus === null &&
    guidedReview.actions.includes("CONTINUE_ANSWERING") &&
    question === null &&
    currentLot === null &&
    !error &&
    !selectionRecoveryReady &&
    !documents.error;
  const showFocusedQuestion =
    Boolean(view && question && activeLine) && !guidedChoicePending;

  useEffect(() => {
    if (!selectionFocus || busy) return;
    if (selectionFocus.outcome === "VERIFY_REQUIRED") {
      consultRef.current?.focus();
      return;
    }
    if (selectionFocus.outcome === "RETRY_READY") {
      retryRef.current?.focus();
      return;
    }
    if (selectionFocus.outcome === "CHANGED") {
      changedAlertRef.current?.focus();
      return;
    }
    if (question && activeLine) return;
    (
      reviewActionRef.current ??
      reviewRef.current ??
      upToDateRef.current
    )?.focus();
  }, [
    activeLine?.id,
    busy,
    currentLot !== null,
    question?.id,
    selectionFocus?.epoch,
    selectionFocus?.outcome,
  ]);

  if (!sessionId || !conversation.userId) {
    return (
      <p role="alert">
        Abra uma importação sob sua sessão autenticada para continuar.
      </p>
    );
  }
  if (privateContextLost)
    return <p role="alert">{error?.message ?? documents.error?.message}</p>;

  const captureVoice = () =>
    new Promise<string>((resolve, reject) => {
      if (!speech.supported) {
        reject(new Error("microphone unavailable"));
        return;
      }
      speech.start({
        onResult: resolve,
        onError: (message) => reject(new Error(message)),
      });
    });

  if (currentLot) {
    return (
      <section
        aria-label="Conversa da importação"
        aria-busy={busy}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-1 py-3"
        style={IMPORT_CONVERSATION_SCROLL_STYLE}
      >
        <div ref={reviewRef} tabIndex={-1}>
          <ImportProposalCard
            lot={execution.lot ?? currentLot}
            pending={execution.pending}
            error={execution.error}
            notice={execution.notice}
            onConfirm={
              execution.financialAction ? () => void execution.act() : undefined
            }
          />
        </div>
        {execution.error && (
          <Button
            type="button"
            variant="secondary"
            className="mt-3 min-h-11 w-full sm:w-auto"
            onClick={() => void execution.retry()}
          >
            Consultar estado guardado
          </Button>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label="Conversa da importação"
      aria-busy={busy}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto px-1 py-3"
      style={IMPORT_CONVERSATION_SCROLL_STYLE}
    >
      <div className="space-y-4">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-darc-velvet">
            Revise as compras do arquivo
          </h2>
          <p className="text-sm text-lifeone-ink-2">
            Resolva uma compra por vez. Compras pendentes podem ficar para
            depois, sem serem importadas neste lote.
          </p>
        </header>

        {error && (
          <div
            ref={changedAlertRef}
            role="alert"
            tabIndex={selectionFocus?.outcome === "CHANGED" ? -1 : undefined}
            className="space-y-2 text-sm text-darc-red"
          >
            <p>{error.message}</p>
            {error.recovery !== "NONE" && (
              <Button
                ref={consultRef}
                type="button"
                variant="secondary"
                className="min-h-11"
                disabled={busy}
                onClick={() => void conversation.recover()}
              >
                Consultar estado guardado
              </Button>
            )}
          </div>
        )}

        {conversation.retryableSelection && (
          <div className="space-y-2">
            <p role="status" className="text-sm text-lifeone-ink-2">
              A tentativa não foi guardada. Você pode repeti-la.
            </p>
            <Button
              ref={retryRef}
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={conversation.busy || documents.busy}
              onClick={() => void conversation.retrySelection()}
            >
              Repetir esta tentativa
            </Button>
          </div>
        )}

        {documents.error && (
          <p role="alert" className="text-sm text-darc-red">
            {documents.error.message}
          </p>
        )}

        {view && view.lines.length === 0 && (
          <ImportLocalDocuments
            view={view}
            pending={busy}
            disabled={Boolean(error)}
            remoteError={documents.error?.message}
            onAnalyze={(id) => void documents.analyze(id)}
            onRecover={() => void documents.recover()}
          />
        )}

        {guidedChoicePending && (
          <section
            aria-label="Compras prontas e respostas pendentes"
            className="space-y-3 rounded-xl border border-darc-linen bg-lifeone-surface p-4"
          >
            <p role="status" className="font-semibold">
              Já há compras prontas para revisar.
            </p>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap">
              {guidedReview?.actions.includes("REVIEW_READY") && (
                <Button
                  ref={reviewActionRef}
                  type="button"
                  className="min-h-11"
                  disabled={busy || selectionActionsBlocked}
                  onClick={() => void conversation.reviewCurrentLot()}
                >
                  Revisar as prontas agora
                </Button>
              )}
              {guidedReview?.actions.includes("CONTINUE_ANSWERING") && (
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  disabled={busy || selectionActionsBlocked}
                  onClick={conversation.continueGuidedReview}
                >
                  Continuar respondendo
                </Button>
              )}
            </div>
          </section>
        )}

        {guidedPreparationPending && (
          <section className="space-y-3 rounded-xl border border-darc-linen bg-lifeone-surface p-4">
            <p role="status" className="text-sm text-lifeone-ink-2">
              Há mais perguntas sobre estas compras. Vamos preparar a próxima
              para você responder.
            </p>
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              aria-busy={busy}
              disabled={busy}
              onClick={() => void conversation.prepareCurrentLot()}
            >
              Continuar respondendo
            </Button>
          </section>
        )}

        {view && showFocusedQuestion && question && activeLine && (
          <>
            <ImportFocusedQuestion
              question={question}
              lines={view.lines}
              inputLabel="Sua resposta"
              inputHint="Use o controle acima; você poderá conferir antes de guardar."
              pending={busy}
              disabled={!canResolve || selectionActionsBlocked}
              declaredFacts={view.declaredFacts}
              guidedFocus={guidedFocus}
              focusRequest={
                selectionFocus?.outcome === "APPLIED"
                  ? selectionFocus.epoch
                  : undefined
              }
              onSave={(command) => conversation.saveGuidedAnswer(command)}
              onInterpret={(text) => conversation.interpretAnswer(text)}
              onVoice={captureVoice}
            />
            <section className="space-y-2 rounded-xl border border-darc-linen px-3 pb-3 pt-8 text-sm md:pt-5">
              <p>
                Esta compra ficará fora deste lote atual e poderá ser retomada
                depois.
              </p>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 w-full sm:w-auto"
                disabled={busy || !canResolve || selectionActionsBlocked}
                onClick={() =>
                  void conversation.removeFromSelection(activeLine.id)
                }
              >
                Responder depois
              </Button>
            </section>
          </>
        )}

        {view &&
          !question &&
          !busy &&
          !guidedChoicePending &&
          !guidedPreparationPending && (
            <p
              ref={upToDateRef}
              role="status"
              tabIndex={-1}
              className="rounded-xl bg-lifeone-surface p-3 text-sm"
            >
              As respostas deste lote estão em dia. Revise as compras prontas
              antes de confirmar.
            </p>
          )}

        {deferredLines.length > 0 && (
          <details open className="rounded-xl border border-darc-linen p-3">
            <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-darc-red">
              Compras para retomar depois
            </summary>
            <ul className="space-y-3 pt-2">
              {deferredLines.map((line) => {
                const ordinal = view
                  ? view.lines.findIndex(
                      (candidate) => candidate.id === line.id,
                    ) + 1
                  : 1;
                return (
                  <li key={line.id}>
                    <ImportSelectionRow
                      line={line}
                      selected={false}
                      selectionAtLimit={false}
                      pending={busy || selectionActionsBlocked}
                      ordinal={ordinal}
                      total={view?.lines.length ?? 1}
                      onAdd={(id) => void conversation.addToSelection(id)}
                    />
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        {view &&
          canPrepare &&
          guidedReview?.progress !== "READY_WITH_PENDING" && (
            <section className="space-y-2 border-t border-darc-linen pt-4">
              <p className="text-sm text-lifeone-ink-2">
                Você ainda verá um resumo separado antes de confirmar. O
                servidor incluirá somente as compras prontas.
              </p>
              <Button
                ref={reviewActionRef}
                type="button"
                className="min-h-11 w-full sm:w-auto"
                disabled={busy || selectionActionsBlocked}
                onClick={() => void conversation.reviewCurrentLot()}
              >
                {guidedReview
                  ? "Revisar as prontas agora"
                  : "Revisar compras prontas"}
              </Button>
            </section>
          )}
      </div>
    </section>
  );
}

function StandaloneConversation({ sessionId }: { sessionId: string | null }) {
  const documents = useImportDocumentFlow(sessionId);
  return <Conversation sessionId={sessionId} documents={documents} />;
}

/** The actor/session key destroys local media state on an identity change. */
export function ImportConversationBody({
  sessionId,
  documents,
}: {
  sessionId: string | null;
  documents?: ImportDocumentFlow;
}) {
  const userId = useImportUserId();
  return documents ? (
    <Conversation
      key={JSON.stringify([userId, sessionId])}
      sessionId={sessionId}
      documents={documents}
    />
  ) : (
    <StandaloneConversation
      key={JSON.stringify([userId, sessionId])}
      sessionId={sessionId}
    />
  );
}
