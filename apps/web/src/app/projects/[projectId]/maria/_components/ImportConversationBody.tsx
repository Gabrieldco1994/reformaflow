"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  isPendingImportQuestion,
  type ImportObservationQuestionV1,
} from "@reformaflow/domain";
import { useSpeechRecognition } from "@/components/agent/useSpeechRecognition";
import { useImportConversation } from "../_hooks/useImportConversation";
import { useImportManualOptions } from "../_hooks/useImportManualOptions";
import {
  useImportDocumentFlow,
  type ImportDocumentFlow,
} from "../_hooks/useImportDocumentFlow";
import {
  useCancelImportSession,
  useImportUserId,
} from "../_hooks/useImportSessions";
import { useImportCatalog } from "../_hooks/useImportCatalog";
import { buildReceiptView } from "../_lib/import-receipt-view";
import {
  ImportFocusedQuestion,
  IMPORT_QUESTION_FIELD_LABEL,
} from "./ImportFocusedQuestion";
import { ImportQuestionViewportOwner } from "./ImportQuestionViewportOwner";
import { ImportProposalCard } from "./ImportProposalCard";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { ImportResumeUpload } from "./ImportResumeUpload";
import { isPdfDocumentErrorCode } from "../_lib/import-session-errors";
import { ImportIgnoredObservations } from "./ImportIgnoredObservations";
import {
  ImportReviewBlockerNotice,
  ImportDeclaredFacts,
} from "./ImportReviewBlockerNotice";
import { ImportReceipt } from "./ImportReceipt";
import { questionIntersectsSelectedLines } from "../_lib/import-question-selection";
type AgentChannel = "TEXT" | "VOICE";

function Conversation({
  sessionId,
  documents,
  continuationFocusSessionId,
  onContinuationRequest,
  onContinuationFocusComplete,
  originChannel = "TEXT",
}: {
  sessionId: string | null;
  documents: ImportDocumentFlow;
  continuationFocusSessionId?: string | null;
  onContinuationRequest?: (sessionId: string) => void;
  onContinuationFocusComplete?: (sessionId: string) => void;
  originChannel?: AgentChannel;
}) {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const conversation = useImportConversation(sessionId, true, originChannel);
  const router = useRouter();
  const { cancel } = useCancelImportSession(conversation.userId);
  const { view, question, error } = conversation;
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const busy = conversation.busy || documents.busy;
  const documentBlocked = isPdfDocumentErrorCode(documents.error?.code);
  const privateContextLost =
    error?.privateContextLost || documents.error?.privateContextLost;
  const guided =
    !privateContextLost &&
    conversation.guided &&
    view?.lines.some(
      (line) =>
        line.id === conversation.guided?.lineId &&
        line.observationIds.includes(conversation.guided.observationId),
    )
      ? conversation.guided
      : null;
  const relatedQuestions =
    question && "subject" in question && view
      ? view.questions.filter(
          (candidate): candidate is ImportObservationQuestionV1 =>
            "subject" in candidate &&
            candidate.lineIds[0] === question.lineIds[0] &&
            candidate.subject.observationId ===
              question.subject.observationId &&
            isPendingImportQuestion(candidate),
        )
      : undefined;
  const speech = useSpeechRecognition();
  const manualOptions = useImportManualOptions(
    conversation.userId,
    sessionId ?? "",
    view?.ownerProjectId ?? null,
    question,
  );
  const { names } = useImportCatalog(
    conversation.userId,
    conversation.result !== null,
  );
  const receipt = conversation.result?.receipt
    ? buildReceiptView(conversation.result.receipt, names)
    : null;
  const openContinuation = useCallback(
    (continuationSessionId: string) => {
      onContinuationRequest?.(continuationSessionId);
      router.replace(
        `/projects/${encodeURIComponent(projectId)}/maria?importSessionId=${encodeURIComponent(continuationSessionId)}`,
      );
    },
    [onContinuationRequest, projectId, router],
  );
  const conversationRegion = useRef<HTMLElement>(null);
  const focusForContinuation =
    sessionId !== null && continuationFocusSessionId === sessionId;
  useEffect(() => {
    if (!focusForContinuation || !sessionId) return;
    const region = conversationRegion.current;
    region?.focus();
    if (region && document.activeElement === region)
      onContinuationFocusComplete?.(sessionId);
  }, [focusForContinuation, onContinuationFocusComplete, sessionId]);
  const onIgnoredCountChange = useCallback(
    (count: number) => setIgnoredCount(count),
    [],
  );
  const ignoredOnly =
    Boolean(view) &&
    view!.lines.length === 0 &&
    ignoredCount > 0 &&
    !receipt &&
    !conversation.review;
  const [voiceError, setVoiceError] = useState("");
  const [voiceCapture, setVoiceCapture] = useState<{
    id: number;
    text: string;
    questionId: string;
    revision: number;
  } | null>(null);
  const captureGeneration = useRef(0);
  useEffect(() => {
    captureGeneration.current++;
    speech.stop();
    setVoiceCapture(null);
    return () => {
      captureGeneration.current++;
      speech.stop();
    };
    // A new revision invalidates old capture and playback, not just rendered text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view?.revision,
    privateContextLost,
    documents.busy,
    Boolean(documents.error),
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
  const captureVoice = () => {
    const generation = ++captureGeneration.current;
    const admittedQuestionId = question?.id ?? null;
    const admittedRevision = view?.revision ?? null;
    setVoiceError("");
    speech.start({
      onResult: (text) => {
        if (
          generation !== captureGeneration.current ||
          !admittedQuestionId ||
          admittedRevision === null
        )
          return;
        conversation.setVoiceLiteral(text);
        setVoiceCapture({
          id: generation,
          text,
          questionId: admittedQuestionId,
          revision: admittedRevision,
        });
      },
      onError: (message) => {
        if (generation === captureGeneration.current) setVoiceError(message);
      },
    });
  };
  const mayAnswer = Boolean(view?.actions.includes("RESOLVE"));
  const mayReview = Boolean(
    view?.actions.some((a) => ["PREPARE", "CONFIRM", "EXECUTE"].includes(a)),
  );
  const cancelIgnoredOnly = async () => {
    if (
      !sessionId ||
      !view ||
      !view.actions.includes("CANCEL") ||
      cancelPending ||
      !window.confirm(
        "Cancelar esta importação? Nenhum lançamento será criado. Você poderá pedir outra importação à Maria.",
      )
    )
      return;
    setCancelPending(true);
    setCancelError(null);
    try {
      const outcome = await cancel(sessionId, view.revision);
      if (outcome.kind === "cancelled") {
        router.replace(`/projects/${encodeURIComponent(projectId)}/maria`);
        return;
      }
      if (outcome.kind === "conflict" || outcome.kind === "already-applied") {
        await conversation.recover(true);
        setCancelError(
          "O estado mudou antes do cancelamento. A importação foi consultada novamente; confira as ações disponíveis.",
        );
        return;
      }
      if (outcome.kind === "failed") {
        setCancelError(outcome.info.message);
        return;
      }
      setCancelError("O cancelamento já está em andamento.");
    } finally {
      setCancelPending(false);
    }
  };

  return (
    <section
      ref={conversationRegion}
      tabIndex={-1}
      aria-label="Conversa da importação"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <ImportQuestionViewportOwner>
        <p className="text-sm text-lifeone-ink-2">
          Importação {sessionId}
          {view ? ` · Revisão ${view.revision}` : ""}
        </p>
        {busy && <p role="status">Consultando a importação…</p>}
        {error && (
          <div role="alert" className="space-y-2 text-sm text-darc-red">
            <p>{error.message}</p>
            {!error.privateContextLost && error.recovery !== "NONE" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void conversation.recover()}
                className="min-h-11 rounded-xl border px-3"
              >
                Consultar estado guardado
              </button>
            )}
          </div>
        )}
        {voiceError && (
          <p role="alert" className="text-sm text-darc-red">
            {voiceError}
          </p>
        )}
        {view &&
          conversation.userId &&
          view.attachments.some(
            (attachment) => attachment.state === "ATTACHED",
          ) && (
            <ImportIgnoredObservations
              sessionId={sessionId}
              userId={conversation.userId}
              revision={view.revision}
              onIgnoredCountChange={onIgnoredCountChange}
            />
          )}
        {view && (
          <ImportLocalDocuments
            view={view}
            pending={busy}
            disabled={Boolean(error) || conversation.review}
            remoteError={documents.error?.message}
            onAnalyze={(id) => void documents.analyze(id)}
            onRecover={() => void documents.recover()}
          />
        )}
        {view && (
          <ImportResumeUpload
            view={view}
            documents={documents}
            disabled={Boolean(error) || conversation.review}
          />
        )}
        {(ignoredOnly || documentBlocked) && (
          <section
            aria-label={
              documentBlocked
                ? "Substituir documento ou cancelar"
                : "Nenhuma compra importável"
            }
            className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm"
          >
            <h3 className="font-semibold">
              {documentBlocked
                ? "Este documento não pode ser analisado"
                : "Nenhuma compra para revisar"}
            </h3>
            {documentBlocked ? (
              <p>
                Para substituir o documento, cancele esta importação e peça
                outra à Maria com um arquivo legível. Não há confirmação
                financeira nem tentativa de OCR aqui.
              </p>
            ) : (
              <p>
                Este CSV contém apenas lançamentos ignorados, como pagamentos de
                fatura. Eles são informativos e não podem ser importados como
                compras.
              </p>
            )}
            {view?.actions.includes("CANCEL") ? (
              <button
                type="button"
                disabled={cancelPending || busy}
                onClick={() => void cancelIgnoredOnly()}
                className="min-h-11 rounded-xl border px-3"
              >
                {cancelPending
                  ? "Cancelando importação…"
                  : "Cancelar e voltar à Maria para pedir outra importação"}
              </button>
            ) : (
              <p>
                O servidor não oferece cancelamento neste estado. Consulte
                “Importações da Maria” acima para ver as ações disponíveis antes
                de iniciar outra importação.
              </p>
            )}
            {cancelError && (
              <p role="alert" className="text-darc-red">
                {cancelError}
              </p>
            )}
          </section>
        )}
        {view &&
          !conversation.review &&
          view.lines.map((line) => (
            <ImportReviewBlockerNotice
              key={line.id}
              line={line}
              blockers={view.reviewBlockers}
              selected={view.selectedLineIds.includes(line.id)}
              showLine
              hasQuestion={view.questions.some(
                (q) =>
                  !("subject" in q) &&
                  isPendingImportQuestion(q) &&
                  q.lineIds.includes(line.id),
              )}
              pending={busy || Boolean(error) || Boolean(documents.error)}
              onInclude={
                view.actions.includes("RESOLVE")
                  ? (id) => void conversation.addToSelection(id)
                  : undefined
              }
              onRemove={
                view.actions.includes("RESOLVE")
                  ? (id) => void conversation.removeFromSelection(id)
                  : undefined
              }
            />
          ))}
        {view && !conversation.review && (
          <div className="space-y-3">
            {view.lines.map((line) => (
              <ImportDeclaredFacts
                key={line.id}
                lineId={line.id}
                facts={view.declaredFacts}
              />
            ))}
            {view.questions
              .filter(
                (question) =>
                  "subject" in question &&
                  !isPendingImportQuestion(question) &&
                  questionIntersectsSelectedLines(
                    question,
                    view.selectedLineIds,
                  ),
              )
              .map((question) => (
                <div key={question.id} className="space-y-2 text-sm">
                  <p>{question.text}</p>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !mayAnswer ||
                      Boolean(error) ||
                      Boolean(documents.error)
                    }
                    aria-label={`Editar compra ${question.lineIds[0]}: ${IMPORT_QUESTION_FIELD_LABEL[question.field]}`}
                    className="min-h-11 rounded-xl border px-3"
                    onClick={() => conversation.editQuestion(question.id)}
                  >
                    Editar {IMPORT_QUESTION_FIELD_LABEL[question.field]}
                  </button>
                </div>
              ))}
          </div>
        )}
        {conversation.review && !documents.error && (
          <ImportProposalCard
            sessionId={sessionId}
            onOpenContinuation={openContinuation}
            selectionPending={
              busy || Boolean(error) || Boolean(documents.error)
            }
            onRemoveSelected={(id) => void conversation.removeFromSelection(id)}
          />
        )}
        {receipt && (
          <ImportReceipt view={receipt} onOpenContinuation={openContinuation} />
        )}
        {conversation.result && !receipt && (
          <p role="status">
            Esta importação ainda não tem comprovante disponível.
          </p>
        )}
        {view && !busy && !error && !documents.error && (
          <div className="flex flex-wrap gap-2">
            {mayReview && (
              <button
                type="button"
                onClick={() => void conversation.openReview()}
                className="min-h-11 rounded-xl border px-3"
              >
                Abrir revisão do lote
              </button>
            )}
            {view.actions.includes("READ_RESULT") && (
              <button
                type="button"
                onClick={() => void conversation.readResult()}
                className="min-h-11 rounded-xl border px-3"
              >
                Consultar comprovante
              </button>
            )}
          </div>
        )}
        {!error?.privateContextLost && (
          <div className="min-w-0 space-y-3">
            {guided && (
              <div className="space-y-1 break-words text-sm">
                <p>
                  Resposta recebida · Compra {guided.lineId} · Observação{" "}
                  {guided.observationId}
                </p>
                <p>{guided.literal}</p>
              </div>
            )}
            {question && view && (
              <>
                <ImportFocusedQuestion
                  question={question}
                  lines={view.lines}
                  value={conversation.literal}
                  onTextChange={conversation.setLiteral}
                  inputLabel="Sua resposta sobre esta compra"
                  inputHint="Confira esta informação antes de guardar. Digitar ou falar nunca envia automaticamente."
                  contextKey={JSON.stringify([
                    conversation.userId,
                    sessionId,
                    view.revision,
                    view.actions,
                    Boolean(error),
                    Boolean(documents.error),
                  ])}
                  ownerProjectId={
                    manualOptions.ownerProjectId ?? view.ownerProjectId
                  }
                  declaredFacts={view.declaredFacts}
                  relatedQuestions={relatedQuestions}
                  guided={
                    "subject" in question &&
                    guided?.lineId === question.lineIds[0] &&
                    guided.observationId === question.subject.observationId
                  }
                  onStartGuided={conversation.startGuidedAnswer}
                  onChooseQuestion={conversation.editQuestion}
                  candidates={manualOptions.candidates}
                  targetProjects={manualOptions.projects}
                  optionsPending={manualOptions.pending}
                  optionsError={manualOptions.error}
                  voiceCapture={voiceCapture}
                  revision={view.revision}
                  onVoiceGuidance={setVoiceError}
                  pending={busy}
                  disabled={!mayAnswer}
                  onAnswer={
                    error || documents.error
                      ? undefined
                      : (answer) => {
                          if ("draftAnswer" in answer)
                            void conversation.saveFocusedDraft(answer);
                          else void conversation.saveDeclaration(answer);
                        }
                  }
                />
                {manualOptions.error && (
                  <button
                    type="button"
                    className="min-h-11 rounded-xl border px-3"
                    onClick={() => void manualOptions.retry?.()}
                  >
                    Consultar opções novamente
                  </button>
                )}
                <button
                  type="button"
                  onClick={captureVoice}
                  disabled={
                    busy ||
                    !mayAnswer ||
                    !speech.supported ||
                    Boolean(error) ||
                    Boolean(documents.error)
                  }
                  className="min-h-11 w-full rounded-xl bg-darc-red px-4 font-semibold text-white disabled:opacity-50"
                >
                  {speech.listening
                    ? "Ouvindo…"
                    : "Responder por voz sem enviar"}
                </button>
              </>
            )}
          </div>
        )}
      </ImportQuestionViewportOwner>
    </section>
  );
}

function StandaloneConversation({
  sessionId,
  continuationFocusSessionId,
  onContinuationRequest,
  onContinuationFocusComplete,
  originChannel,
}: {
  sessionId: string | null;
  continuationFocusSessionId?: string | null;
  onContinuationRequest?: (sessionId: string) => void;
  onContinuationFocusComplete?: (sessionId: string) => void;
  originChannel?: AgentChannel;
}) {
  const documents = useImportDocumentFlow(sessionId);
  return (
    <Conversation
      sessionId={sessionId}
      documents={documents}
      continuationFocusSessionId={continuationFocusSessionId}
      onContinuationRequest={onContinuationRequest}
      onContinuationFocusComplete={onContinuationFocusComplete}
      originChannel={originChannel}
    />
  );
}

/** The actor/session key destroys local media state, not the public host's documentary attempt. */
export function ImportConversationBody({
  sessionId,
  documents,
  continuationFocusSessionId,
  onContinuationRequest,
  onContinuationFocusComplete,
  originChannel,
}: {
  sessionId: string | null;
  documents?: ImportDocumentFlow;
  continuationFocusSessionId?: string | null;
  onContinuationRequest?: (sessionId: string) => void;
  onContinuationFocusComplete?: (sessionId: string) => void;
  originChannel?: AgentChannel;
}) {
  const userId = useImportUserId();
  return documents ? (
    <Conversation
      key={JSON.stringify([userId, sessionId])}
      sessionId={sessionId}
      documents={documents}
      continuationFocusSessionId={continuationFocusSessionId}
      onContinuationRequest={onContinuationRequest}
      onContinuationFocusComplete={onContinuationFocusComplete}
      originChannel={originChannel}
    />
  ) : (
    <StandaloneConversation
      key={JSON.stringify([userId, sessionId])}
      sessionId={sessionId}
      continuationFocusSessionId={continuationFocusSessionId}
      onContinuationRequest={onContinuationRequest}
      onContinuationFocusComplete={onContinuationFocusComplete}
      originChannel={originChannel}
    />
  );
}
