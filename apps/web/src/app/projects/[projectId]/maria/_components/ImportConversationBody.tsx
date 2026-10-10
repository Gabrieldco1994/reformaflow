"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  isPendingImportQuestion,
  type ImportObservationQuestionV1,
} from "@reformaflow/domain";
import { useSpeechRecognition } from "@/components/agent/useSpeechRecognition";
import { VoiceAssistantOverlay } from "@/components/agent/VoiceAssistantOverlay";
import {
  isStreamingTtsSupported,
  streamSpeak,
  type StreamTtsHandle,
} from "@/lib/streaming-tts";
import { useImportConversation } from "../_hooks/useImportConversation";
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
import { ImportProposalCard } from "./ImportProposalCard";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { ImportResumeUpload } from "./ImportResumeUpload";
import { ImportIgnoredObservations } from "./ImportIgnoredObservations";
import {
  ImportReviewBlockerNotice,
  ImportDeclaredFacts,
} from "./ImportReviewBlockerNotice";
import { ImportReceipt } from "./ImportReceipt";
import { MariaDock } from "./MariaDock";
import { MariaMessageBubble } from "./MariaMessageBubble";

function Conversation({
  sessionId,
  documents,
}: {
  sessionId: string | null;
  documents: ImportDocumentFlow;
}) {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const conversation = useImportConversation(sessionId, true);
  const router = useRouter();
  const { cancel } = useCancelImportSession(conversation.userId);
  const { view, question, error } = conversation;
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const busy = conversation.busy || documents.busy;
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
  const { names } = useImportCatalog(
    conversation.userId,
    conversation.result !== null,
  );
  const receipt = conversation.result?.receipt
    ? buildReceiptView(conversation.result.receipt, names)
    : null;
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
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [speaking, setSpeaking] = useState<number | null>(null);
  const audio = useRef<StreamTtsHandle | null>(null);
  const captureGeneration = useRef(0);
  const audioGeneration = useRef(0);
  const stopAudio = () => {
    audioGeneration.current++;
    audio.current?.stop();
    audio.current = null;
    setSpeaking(null);
  };
  useEffect(() => {
    captureGeneration.current++;
    speech.stop();
    stopAudio();
    setVoiceOpen(false);
    return () => {
      captureGeneration.current++;
      audioGeneration.current++;
      speech.stop();
      audio.current?.stop();
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
  const send: typeof conversation.send = (...args) => {
    if (documents.busy || documents.error) {
      setVoiceError("Consulte o estado dos documentos antes de responder.");
      return Promise.resolve(null);
    }
    return conversation.send(...args);
  };
  const captureVoice = () => {
    const generation = ++captureGeneration.current;
    setVoiceError("");
    speech.start({
      onResult: (text) => {
        if (generation !== captureGeneration.current) return;
        void send(text, "VOICE");
      },
      onError: (message) => {
        if (generation === captureGeneration.current) setVoiceError(message);
      },
    });
  };
  const openVoice = () => {
    captureGeneration.current++;
    speech.stop();
    stopAudio();
    setVoiceOpen(true);
  };
  const mayAnswer = Boolean(view?.actions.includes("RESOLVE"));
  const mayReview = Boolean(
    view?.actions.some((a) => ["PREPARE", "CONFIRM", "EXECUTE"].includes(a)),
  );
  const scopeReview = conversation.scopeReview;
  const canSpeak = (index: number) => {
    const message = conversation.messages[index];
    return (
      !busy &&
      !error &&
      message?.importRevision === view?.revision &&
      Boolean(message?.speechText)
    );
  };
  const rejectGenericAction = () =>
    setVoiceError(
      "A confirmação financeira só está disponível no card de revisão.",
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
      aria-label="Conversa da importação"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
    >
      <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-y-contain px-1 py-3">
        <p className="text-sm text-lifeone-ink-2">
          Importação {sessionId}
          {view ? ` · Revisão ${view.revision}` : ""}
        </p>
        {conversation.messages.map((message, index) => (
          <MariaMessageBubble
            key={index}
            message={message}
            index={index}
            precedingUserText=""
            confirmed={false}
            onConfirm={rejectGenericAction}
            onEdit={rejectGenericAction}
            speaking={speaking === index}
            ttsSupported={isStreamingTtsSupported() && canSpeak(index)}
            onToggleSpeak={() => {
              if (!canSpeak(index)) return;
              const wasSpeaking = speaking === index;
              stopAudio();
              if (wasSpeaking || !message.speechText) return;
              const generation = audioGeneration.current;
              setSpeaking(index);
              audio.current = streamSpeak({
                text: message.speechText,
                onEnd: () => {
                  if (generation === audioGeneration.current) setSpeaking(null);
                },
                onError: () => {
                  if (generation !== audioGeneration.current) return;
                  setSpeaking(null);
                  setVoiceError(
                    "Não foi possível reproduzir o áudio. A resposta continua disponível para leitura.",
                  );
                },
              });
            }}
          />
        ))}
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
        {ignoredOnly && (
          <section
            aria-label="Nenhuma compra importável"
            className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm"
          >
            <h3 className="font-semibold">Nenhuma compra para revisar</h3>
            <p>
              Este CSV contém apenas lançamentos ignorados, como pagamentos de
              fatura. Eles são informativos e não podem ser importados como
              compras.
            </p>
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
                  "subject" in question && !isPendingImportQuestion(question),
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
        {scopeReview && view && (
          <section
            aria-label="Revisar alcance da resposta"
            className="space-y-3 rounded-xl border p-4"
          >
            <h3 className="font-semibold">
              Aplicar esta resposta às compras deste anexo?
            </h3>
            <p className="break-words">Resposta: {conversation.literal}</p>
            <p className="break-words">
              Anexo:{" "}
              {
                view.attachments.find((a) => a.id === scopeReview.attachmentId)
                  ?.fileName
              }
            </p>
            <ul className="space-y-2">
              {scopeReview.lineIds.map((id) => (
                <li key={id} className="break-words">
                  {view.lines.find((line) => line.id === id)?.titulo} — Compra{" "}
                  {id}
                </li>
              ))}
            </ul>
            <p className="text-sm">
              Somente o campo da pergunta será alterado. Isto não confirma
              lançamentos.
            </p>
            <button
              type="button"
              disabled={
                busy ||
                Boolean(error) ||
                Boolean(documents.error) ||
                conversation.scopeRevision !== view.revision
              }
              onClick={() => void conversation.approveScope()}
              className="min-h-11 rounded-xl border px-3"
            >
              Aplicar resposta a estas compras
            </button>
          </section>
        )}
        {conversation.review && (
          <ImportProposalCard
            sessionId={sessionId}
            selectionPending={
              busy || Boolean(error) || Boolean(documents.error)
            }
            onRemoveSelected={(id) => void conversation.removeFromSelection(id)}
          />
        )}
        {receipt && <ImportReceipt view={receipt} />}
        {conversation.result && !receipt && (
          <p role="status">
            Esta importação ainda não tem comprovante disponível.
          </p>
        )}
        {view && !busy && !error && !documents.error && (
          <div className="flex flex-wrap gap-2">
            {question && isPendingImportQuestion(question) && (
              <button
                type="button"
                onClick={() => void send("Continuar", "TEXT", "CONTINUE")}
                className="min-h-11 rounded-xl border px-3"
              >
                Consultar pergunta atual
              </button>
            )}
            {mayReview && (
              <button
                type="button"
                onClick={() =>
                  void send("Abrir revisão", "TEXT", "OPEN_REVIEW")
                }
                className="min-h-11 rounded-xl border px-3"
              >
                Abrir revisão do lote
              </button>
            )}
            {view.actions.includes("READ_RESULT") && (
              <button
                type="button"
                onClick={() => void conversation.recover(true)}
                className="min-h-11 rounded-xl border px-3"
              >
                Consultar comprovante
              </button>
            )}
          </div>
        )}
        {question &&
          !("subject" in question) &&
          view &&
          !error?.privateContextLost && (
            <label className="block text-sm">
              Alcance da resposta
              <select
                value={conversation.attachmentId ?? ""}
                disabled={busy || !mayAnswer}
                onChange={(event) =>
                  conversation.setAttachmentId(event.target.value || null)
                }
                className="mt-1 block min-h-11 w-full min-w-0 rounded-xl border px-3"
              >
                <option value="">Compras desta pergunta</option>
                {view.attachments
                  .filter((a) => a.state === "ATTACHED")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      Todas de {a.fileName}
                    </option>
                  ))}
              </select>
            </label>
          )}
        {!error?.privateContextLost && (
          <>
            {guided && (
              <div className="space-y-1 break-words text-sm">
                <p>
                  Resposta recebida · Compra {guided.lineId} · Observação{" "}
                  {guided.observationId}
                </p>
                <p>{guided.literal}</p>
              </div>
            )}
            <MariaDock
              importMode
              input={conversation.literal}
              onInputChange={conversation.setLiteral}
              onSubmit={(text) => {
                void send(text);
              }}
              onMic={captureVoice}
              listening={speech.listening}
              micSupported={speech.supported}
              disabled={
                busy ||
                !view ||
                Boolean(error) ||
                Boolean(documents.error) ||
                (Boolean(question) && !mayAnswer)
              }
              onOpenVoiceConversation={openVoice}
              composer={
                question && view ? (
                  <ImportFocusedQuestion
                    question={question}
                    lines={view.lines}
                    value={conversation.literal}
                    onTextChange={conversation.setLiteral}
                    inputLabel="Sua resposta sobre esta compra"
                    inputHint={
                      "subject" in question
                        ? "Confira esta informação antes de guardar. Digitar ou falar não envia uma declaração."
                        : "Responda com suas palavras. O servidor verificará a resposta."
                    }
                    contextKey={JSON.stringify([
                      conversation.userId,
                      sessionId,
                      view.revision,
                      view.actions,
                      Boolean(error),
                      Boolean(documents.error),
                    ])}
                    declaredFacts={view.declaredFacts}
                    relatedQuestions={relatedQuestions}
                    guided={
                      "subject" in question &&
                      guided?.lineId === question.lineIds[0] &&
                      guided.observationId === question.subject.observationId
                    }
                    onStartGuided={conversation.startGuidedAnswer}
                    onChooseQuestion={conversation.editQuestion}
                    pending={busy}
                    disabled={!mayAnswer}
                    onAnswer={
                      "subject" in question && (error || documents.error)
                        ? undefined
                        : (answer) => {
                            if ("subject" in question)
                              void conversation.saveDeclaration(answer);
                            else void send(answer.text);
                          }
                    }
                  />
                ) : undefined
              }
            />
          </>
        )}
      </div>
      {voiceOpen && !error?.privateContextLost && (
        <VoiceAssistantOverlay
          autoStart
          send={(text) => send(text, "VOICE")}
          onClose={() => setVoiceOpen(false)}
        />
      )}
    </section>
  );
}

function StandaloneConversation({ sessionId }: { sessionId: string | null }) {
  const documents = useImportDocumentFlow(sessionId);
  return <Conversation sessionId={sessionId} documents={documents} />;
}

/** The actor/session key destroys local media state, not the public host's documentary attempt. */
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
