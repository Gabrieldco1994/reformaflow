"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isPendingImportQuestion,
  normalizeImportDeclaration,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  editImportSession,
  answerImportDocumentaryQuestion,
  answerImportFocusedDraftQuestion,
  getFullImportSession,
  getImportResult,
  prepareImportSession,
  type ImportQuestionAnswerInput,
} from "../_lib/import-session-api";
import { importKeys, importRoot } from "../_lib/import-session-keys";
import { ImportWorkflowResponseError } from "../_lib/import-session-workflow-read";
import {
  importWorkflowFailure,
  type ImportWorkflowFailure,
} from "../_lib/import-session-errors";
import { importReceiptSpeech } from "../_lib/import-session-copy";
import {
  importDeclarationContext,
  type ImportResultRead,
} from "../_lib/import-session-read";
import { useImportUserId } from "./useImportSessions";
import {
  isFocusedDraftQuestion,
  sameFocusedValue,
  validFocusedDraftAnswer,
  verifiedFocusedDraftAnswer,
} from "../_lib/import-focused-draft";
import { serializeFocusedDraftAnswerRequest } from "../_lib/import-focused-draft-transport";

interface ChatMessage {
  role: "user" | "assistant";
  mode: "IMPORT";
  content: string;
  speechText?: string | null;
  importRevision?: number;
}

interface Generation {
  userId: string | null;
  sessionId: string | null;
  initialChannel: "TEXT" | "VOICE";
  live: boolean;
  busy: boolean;
  controller: AbortController | null;
  revoked: ImportWorkflowFailure | null;
}
interface Local {
  literal: string;
  focus: ImportSessionQuestionV1 | null | undefined;
  editingQuestionId: string | null;
  guided: { lineId: string; observationId: string; literal: string } | null;
  attachmentId: string | null;
  channel: "TEXT" | "VOICE";
  failure: ImportWorkflowFailure | null;
  pending: boolean;
  review: boolean;
  result: ImportResultRead | null;
  messages: ChatMessage[];
}
const empty = (channel: "TEXT" | "VOICE" = "TEXT"): Local => ({
  literal: "",
  focus: undefined,
  editingQuestionId: null,
  guided: null,
  attachmentId: null,
  channel,
  failure: null,
  pending: false,
  review: false,
  result: null,
  messages: [],
});
const sameFocus = (
  a: Pick<ImportSessionQuestionV1, "id" | "field" | "lineIds">,
  b: Pick<ImportSessionQuestionV1, "id" | "field" | "lineIds">,
) =>
  a.id === b.id &&
  a.field === b.field &&
  a.lineIds.length === b.lineIds.length &&
  a.lineIds.every((id) => b.lineIds.includes(id));
const firstPendingQuestionForSelection = (
  view: ImportSessionViewV1,
): ImportSessionQuestionV1 | null =>
  view.questions.find(
    (question) =>
      isPendingImportQuestion(question) &&
      (view.selectedLineIds.length === 0 ||
        question.lineIds.some((id) => view.selectedLineIds.includes(id))),
  ) ?? null;

/** Inactive consumer; all financial actions remain inside ImportProposalCard. */
export function useImportConversation(
  sessionId: string | null,
  documentaryRead = false,
  initialChannel: "TEXT" | "VOICE" = "TEXT",
) {
  const userId = useImportUserId();
  const client = useQueryClient();
  const scope = useRef<Generation>({
    userId,
    sessionId,
    initialChannel,
    live: true,
    busy: false,
    controller: null,
    revoked: null,
  });
  if (
    scope.current.userId !== userId ||
    scope.current.sessionId !== sessionId
  ) {
    scope.current.live = false;
    scope.current.controller?.abort();
    scope.current = {
      userId,
      sessionId,
      initialChannel,
      live: true,
      busy: false,
      controller: null,
      revoked: null,
    };
  }
  const generation = scope.current;
  useEffect(() => {
    generation.live = true;
    return () => {
      generation.live = false;
      generation.controller?.abort();
    };
  }, [generation]);
  const [state, setState] = useState<{ generation: Generation; local: Local }>(
    () => ({ generation, local: empty(generation.initialChannel) }),
  );
  const local =
    state.generation === generation
      ? state.local
      : empty(generation.initialChannel);
  const active = () =>
    scope.current === generation && generation.live && !generation.revoked;
  const update = (patch: Partial<Local>) => {
    if (active())
      setState((previous) => ({
        generation,
        local: {
          ...(previous.generation === generation
            ? previous.local
            : empty(generation.initialChannel)),
          ...patch,
        },
      }));
  };
  const key = [...importRoot(userId ?? "anonymous"), "workflow", sessionId];
  const query = useQuery({
    queryKey: key,
    enabled:
      userId !== null &&
      sessionId !== null &&
      !documentaryRead &&
      !generation.revoked &&
      !local.failure?.privateContextLost,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      if (!sessionId) throw new ImportWorkflowResponseError();
      const previousRevision =
        client.getQueryData<ImportSessionViewV1>(key)?.revision;
      const view = await getFullImportSession(sessionId, signal);
      signal.throwIfAborted();
      if (
        view.id !== sessionId ||
        client.getQueryData<ImportSessionViewV1>(key)?.revision !==
          previousRevision
      )
        throw new ImportWorkflowResponseError();
      return view;
    },
  });
  const failure =
    generation.revoked ??
    local.failure ??
    (query.isError ? importWorkflowFailure(query.error) : null);
  if (failure?.privateContextLost) {
    generation.revoked = failure;
    generation.controller?.abort();
  }
  const view =
    userId && sessionId && !generation.revoked ? (query.data ?? null) : null;
  const question = generation.revoked
    ? null
    : (view?.questions.find((q) => q.id === local.editingQuestionId) ??
      view?.questions.find(
        (q) =>
          isPendingImportQuestion(q) &&
          local.focus &&
          sameFocus(q, local.focus),
      ) ??
      (view ? firstPendingQuestionForSelection(view) : null) ??
      null);
  const literal =
    question && local.focus && !sameFocus(question, local.focus)
      ? ""
      : local.literal;
  const pending = !generation.revoked && (local.pending || query.isFetching);
  const snapshotStillCurrent = (revision: number | undefined) =>
    client.getQueryData<ImportSessionViewV1>(key)?.revision === revision;
  const fail = (error: unknown) => {
    const failure = importWorkflowFailure(error);
    update(
      failure.privateContextLost
        ? { ...empty(generation.initialChannel), failure }
        : {
            pending: false,
            failure,
            review: false,
            result: null,
          },
    );
  };

  async function readCurrent(signal?: AbortSignal) {
    if (!sessionId) throw new ImportWorkflowResponseError();
    const fresh = await getFullImportSession(sessionId, signal);
    if (fresh.id !== sessionId) throw new ImportWorkflowResponseError();
    return fresh;
  }
  const reviewReady = (fresh: ImportSessionViewV1) =>
    Boolean(
      fresh.proposal &&
      ((fresh.state === "READY" && fresh.actions.includes("CONFIRM")) ||
        (fresh.state === "CONFIRMED" && fresh.actions.includes("EXECUTE"))),
    );
  const preparedOutcome = (
    previous: ImportSessionViewV1,
    fresh: ImportSessionViewV1,
  ): "READY" | "NEEDS_INPUT" | null => {
    const common =
      fresh.id === previous.id &&
      fresh.ownerProjectId === previous.ownerProjectId &&
      fresh.cardId === previous.cardId &&
      fresh.revision === previous.revision + 1 &&
      fresh.confirmation === null &&
      fresh.receipt === null &&
      sameFocusedValue(fresh.attachments, previous.attachments) &&
      sameFocusedValue(fresh.selectedLineIds, previous.selectedLineIds);
    if (!common) return null;
    if (
      fresh.state === "READY" &&
      reviewReady(fresh) &&
      sameFocusedValue(fresh.lines, previous.lines) &&
      sameFocusedValue(fresh.questions, previous.questions) &&
      sameFocusedValue(fresh.declaredFacts, previous.declaredFacts)
    )
      return "READY";
    if (
      fresh.state === "NEEDS_INPUT" &&
      fresh.proposal === null &&
      fresh.actions.includes("RESOLVE") &&
      !fresh.actions.some((action) =>
        ["CONFIRM", "EXECUTE", "READ_RESULT"].includes(action),
      ) &&
      fresh.questions.some(
        (question) =>
          isPendingImportQuestion(question) &&
          question.lineIds.some((id) => fresh.selectedLineIds.includes(id)),
      )
    )
      return "NEEDS_INPUT";
    return null;
  };

  const acceptPrepared = (
    fresh: ImportSessionViewV1,
    outcome: "READY" | "NEEDS_INPUT",
  ) => {
    client.setQueryData(key, fresh);
    update({
      pending: false,
      failure: null,
      review: outcome === "READY",
      focus:
        outcome === "NEEDS_INPUT"
          ? firstPendingQuestionForSelection(fresh)
          : null,
      literal: "",
    });
  };

  async function openReview() {
    if (!active() || generation.busy) return null;
    if (!view || !sessionId || failure) {
      if (!failure) fail(new ImportWorkflowResponseError());
      return null;
    }
    if (reviewReady(view)) {
      update({ review: true, failure: null });
      return view;
    }
    if (!view.actions.includes("PREPARE")) {
      fail(new ImportWorkflowResponseError());
      return null;
    }
    const expectedRevision = view.revision;
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    update({ pending: true, failure: null, result: null });
    try {
      const fresh = await prepareImportSession(
        sessionId,
        { expectedRevision },
        controller.signal,
      );
      const outcome = preparedOutcome(view, fresh);
      if (!active() || !snapshotStillCurrent(expectedRevision) || !outcome)
        throw new ImportWorkflowResponseError();
      acceptPrepared(fresh, outcome);
      return fresh;
    } catch (error) {
      if (!active()) return null;
      try {
        const recovered = await readCurrent(controller.signal);
        const outcome = preparedOutcome(view, recovered);
        if (active() && snapshotStillCurrent(expectedRevision) && outcome) {
          acceptPrepared(recovered, outcome);
          return recovered;
        }
      } catch {
        // A lost mutation response authorizes one read, never a blind retry.
      }
      if (active()) fail(error);
      return null;
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  async function readResult() {
    if (!active() || generation.busy || !view || !sessionId || !userId)
      return null;
    const expectedRevision = view.revision;
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    update({ pending: true, failure: null });
    try {
      const result = await getImportResult(sessionId, controller.signal);
      if (!active() || !snapshotStillCurrent(expectedRevision))
        throw new ImportWorkflowResponseError();
      importReceiptSpeech(result);
      client.setQueryData(importKeys.result(userId, sessionId), result);
      update({ pending: false, failure: null, result });
      return result;
    } catch (error) {
      if (active()) fail(error);
      return null;
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  async function saveFocusedDraft(accepted: ImportQuestionAnswerInput) {
    if (!active() || generation.busy) return null;
    if (
      !view ||
      !sessionId ||
      !question ||
      failure ||
      !isFocusedDraftQuestion(question) ||
      !("draftAnswer" in accepted) ||
      accepted.id !== question.id ||
      accepted.draftAnswer.field !== question.field ||
      !validFocusedDraftAnswer(accepted.draftAnswer) ||
      !view.actions.includes("RESOLVE") ||
      !question.lineIds.every((id) => view.lines.some((line) => line.id === id))
    ) {
      fail(new ImportWorkflowResponseError());
      return null;
    }
    const answer = accepted.draftAnswer;
    const expectedRevision = view.revision;
    const request = serializeFocusedDraftAnswerRequest({
      answerRequestId: crypto.randomUUID(),
      expectedRevision,
      questionId: question.id,
      channel: local.channel,
      literal: accepted.text,
      answer,
    });
    if (request === null) {
      fail(new ImportWorkflowResponseError());
      return null;
    }
    const admitted = [
      view.questions,
      view.actions,
      view.lines,
      view.selectedLineIds,
      view.declaredFacts,
    ];
    const visibleContext = () => {
      const cached = client.getQueryData<ImportSessionViewV1>(key);
      return (
        snapshotStillCurrent(expectedRevision) &&
        sameFocusedValue(
          [
            cached?.questions,
            cached?.actions,
            cached?.lines,
            cached?.selectedLineIds,
            cached?.declaredFacts,
          ],
          admitted,
        )
      );
    };
    if (!visibleContext()) {
      fail(new ImportWorkflowResponseError());
      return null;
    }
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    const history: ChatMessage[] = [
      ...local.messages,
      { role: "user", mode: "IMPORT", content: accepted.text },
    ];
    update({
      pending: true,
      failure: null,
      review: false,
      result: null,
      messages: history,
    });
    try {
      const fresh = await answerImportFocusedDraftQuestion(
        sessionId,
        request,
        controller.signal,
      );
      if (!active()) return null;
      if (
        !visibleContext() ||
        !verifiedFocusedDraftAnswer(view, fresh, question, answer)
      )
        throw new ImportWorkflowResponseError();
      const content =
        fresh.revision === expectedRevision
          ? "Essa informação já estava guardada. Nenhuma alteração foi feita."
          : "Informação guardada no rascunho. Nenhum lançamento financeiro foi confirmado.";
      const assistant: ChatMessage = {
        role: "assistant",
        mode: "IMPORT",
        content,
        speechText: content,
        importRevision: fresh.revision,
      };
      client.setQueryData(key, fresh);
      update({
        pending: false,
        failure: null,
        literal: "",
        editingQuestionId: null,
        focus: firstPendingQuestionForSelection(fresh),
        messages: [...history, assistant],
      });
      return assistant;
    } catch (error) {
      if (!active()) return null;
      if (
        !importWorkflowFailure(error).privateContextLost &&
        visibleContext()
      ) {
        try {
          const recovered = await readCurrent(controller.signal);
          if (!active()) return null;
          if (
            visibleContext() &&
            verifiedFocusedDraftAnswer(view, recovered, question, answer)
          )
            client.setQueryData(key, recovered);
        } catch {
          // Recovery is a read, never an acknowledgment or permission to retry.
        }
      }
      if (active()) fail(error);
      return null;
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }
  async function saveDeclaration(accepted: ImportQuestionAnswerInput) {
    if (!active() || generation.busy) return null;
    if (
      !view ||
      !sessionId ||
      !question ||
      !("subject" in question) ||
      accepted.id !== question.id ||
      !("input" in accepted) ||
      !("answer" in accepted) ||
      failure ||
      !view.actions.includes("RESOLVE")
    ) {
      fail(new ImportWorkflowResponseError());
      return null;
    }
    const normalized = normalizeImportDeclaration(
      importDeclarationContext(question, view.declaredFacts),
      accepted.input,
    );
    const answer = accepted.answer;
    if (
      normalized.kind !== "VALID" ||
      normalized.answer.field !== answer.field ||
      normalized.answer.meaningContext !== answer.meaningContext ||
      normalized.answer.value !== answer.value
    ) {
      fail(new ImportWorkflowResponseError());
      return null;
    }
    const expectedRevision = view.revision;
    const admittedContext = JSON.stringify([
      view.questions,
      view.actions,
      view.declaredFacts,
    ]);
    const visibleContext = () => {
      const cached = client.getQueryData<ImportSessionViewV1>(key);
      return (
        snapshotStillCurrent(expectedRevision) &&
        JSON.stringify([
          cached?.questions,
          cached?.actions,
          cached?.declaredFacts,
        ]) === admittedContext
      );
    };
    if (!visibleContext()) {
      fail(new ImportWorkflowResponseError());
      return null;
    }
    const sameSubject = (fact: ImportSessionViewV1["declaredFacts"][number]) =>
      fact.questionId === question.id &&
      fact.lineId === question.lineIds[0] &&
      fact.observationId === question.subject.observationId &&
      fact.field === answer.field &&
      fact.meaningContext === answer.meaningContext;
    const verified = (fresh: ImportSessionViewV1) => {
      const fact = fresh.declaredFacts.find(sameSubject);
      const previousFact = view.declaredFacts.find(sameSubject);
      return (
        fresh.id === sessionId &&
        !!fact &&
        fact.status === (answer.value === null ? "UNKNOWN" : "CURRENT") &&
        fact.value === answer.value &&
        (fresh.revision === expectedRevision + 1 ||
          (fresh.revision === expectedRevision &&
            fresh.expiresAt === view.expiresAt &&
            previousFact?.status === fact.status &&
            previousFact?.value === answer.value))
      );
    };
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    const displayLiteral =
      accepted.input.kind === "VALUE" ? accepted.input.text : literal;
    const history: ChatMessage[] = [
      ...local.messages,
      { role: "user", mode: "IMPORT", content: displayLiteral },
    ];
    update({
      pending: true,
      failure: null,
      review: false,
      result: null,
      messages: history,
    });
    try {
      const fresh = await answerImportDocumentaryQuestion(
        sessionId,
        {
          version: 1,
          answerRequestId: crypto.randomUUID(),
          expectedRevision,
          questionId: question.id,
          channel: local.channel,
          input: accepted.input,
          answer,
        },
        controller.signal,
      );
      if (!active()) return null;
      if (!visibleContext() || !verified(fresh))
        throw new ImportWorkflowResponseError();
      const content =
        fresh.revision === expectedRevision
          ? "Essa informação já estava guardada. Nenhuma alteração foi feita."
          : "Resposta documental guardada. Informação fornecida por você; o documento original foi preservado.";
      const assistant: ChatMessage = {
        role: "assistant",
        mode: "IMPORT",
        content,
        speechText: content,
        importRevision: fresh.revision,
      };
      client.setQueryData(key, fresh);
      update({
        pending: false,
        failure: null,
        literal: "",
        editingQuestionId: null,
        focus: firstPendingQuestionForSelection(fresh),
        messages: [...history, assistant],
      });
      return assistant;
    } catch (error) {
      if (!active()) return null;
      // A lost/malformed response is not permission to resend or announce success.
      // Consult the authoritative fact only while the original consumer is current.
      if (
        !importWorkflowFailure(error).privateContextLost &&
        visibleContext()
      ) {
        try {
          const recovered = await readCurrent(controller.signal);
          if (!active()) return null;
          if (visibleContext() && verified(recovered))
            client.setQueryData(key, recovered);
        } catch {
          // Keep the original failure visible; recovery never acknowledges a save.
        }
      }
      if (!active()) return null;
      fail(error);
      return null;
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  function editQuestion(id: string) {
    if (!active() || generation.busy) return;
    const selected = view?.questions.find((question) => question.id === id);
    if (
      !selected ||
      !("subject" in selected) ||
      failure ||
      !view?.actions.includes("RESOLVE")
    ) {
      fail(new ImportWorkflowResponseError());
      return;
    }
    update({
      focus: selected,
      editingQuestionId: selected.id,
      literal: "",
      attachmentId: null,
      guided:
        local.guided?.lineId === selected.lineIds[0] &&
        local.guided.observationId === selected.subject.observationId
          ? local.guided
          : null,
    });
  }

  function startGuidedAnswer() {
    if (!active() || generation.busy) return;
    if (
      !question ||
      !("subject" in question) ||
      !literal.trim() ||
      failure ||
      !view?.actions.includes("RESOLVE")
    ) {
      fail(new ImportWorkflowResponseError());
      return;
    }
    update({
      guided: {
        lineId: question.lineIds[0],
        observationId: question.subject.observationId,
        literal,
      },
      literal: "",
      attachmentId: null,
    });
  }

  async function recover(readResult = false) {
    if (
      !active() ||
      generation.busy ||
      !userId ||
      !sessionId ||
      failure?.privateContextLost
    )
      return;
    const revision = client.getQueryData<ImportSessionViewV1>(key)?.revision;
    generation.busy = true;
    update({ pending: true, review: false });
    const controller = new AbortController();
    generation.controller = controller;
    try {
      const fresh = await readCurrent(controller.signal);
      if (!active()) return;
      if (!snapshotStillCurrent(revision))
        throw new ImportWorkflowResponseError();
      let result: ImportResultRead | null = null;
      if (
        readResult ||
        failure?.recovery === "READ_RESULT" ||
        fresh.state === "APPLIED"
      ) {
        result = await getImportResult(sessionId, controller.signal);
        if (!active()) return;
        if (!snapshotStillCurrent(revision))
          throw new ImportWorkflowResponseError();
        importReceiptSpeech(result);
      }
      client.setQueryData(key, fresh);
      update({
        pending: false,
        failure: null,
        result,
        editingQuestionId: null,
      });
    } catch (error) {
      if (active()) fail(error);
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  async function changeSelection(lineId: string, include: boolean) {
    if (!active() || generation.busy) return;
    if (!view || !sessionId || failure || !view.actions.includes("RESOLVE"))
      return;
    const currentView =
      client.getQueryData<ImportSessionViewV1>(key) ?? undefined;
    if (
      !currentView ||
      currentView.id !== sessionId ||
      currentView.revision !== view.revision ||
      !currentView.actions.includes("RESOLVE")
    ) {
      fail(new ImportWorkflowResponseError());
      return;
    }
    const hasLine = currentView.lines.some((line) => line.id === lineId);
    const wasSelected = currentView.selectedLineIds.includes(lineId);
    if (!hasLine || wasSelected === include) return;
    const selectedLineIds = include
      ? [...currentView.selectedLineIds, lineId]
      : currentView.selectedLineIds.filter((id) => id !== lineId);
    const expectedRevision = currentView.revision;
    generation.busy = true;
    update({ pending: true });
    try {
      const fresh = await editImportSession(sessionId, {
        expectedRevision,
        questionId: null,
        replaceLines: [],
        selectedLineIds,
      });
      if (!active()) return;
      if (fresh.id !== sessionId || !snapshotStillCurrent(expectedRevision))
        throw new ImportWorkflowResponseError();
      client.setQueryData(key, fresh);
      update({
        pending: false,
        failure: null,
        review: false,
        result: null,
      });
    } catch (error) {
      if (active()) fail(error);
    } finally {
      generation.busy = false;
    }
  }
  async function addToSelection(lineId: string) {
    return changeSelection(lineId, true);
  }
  async function removeFromSelection(lineId: string) {
    return changeSelection(lineId, false);
  }

  return {
    ...(generation.revoked ? empty(generation.initialChannel) : local),
    userId,
    view,
    question,
    literal: generation.revoked ? "" : literal,
    error: failure,
    busy: pending,
    openReview,
    readResult,
    saveDeclaration,
    saveFocusedDraft,
    editQuestion,
    startGuidedAnswer,
    recover,
    addToSelection,
    removeFromSelection,
    setLiteral: (literal: string) =>
      update({
        literal,
        channel: "TEXT",
        focus: question,
      }),
    setVoiceLiteral: (literal: string) =>
      update({
        literal,
        channel: "VOICE",
        focus: question,
      }),
    setAttachmentId: (attachmentId: string | null) => {
      if (
        attachmentId !== null &&
        !view?.attachments.some(
          (a) => a.id === attachmentId && a.state === "ATTACHED",
        )
      ) {
        fail(new ImportWorkflowResponseError());
        return;
      }
      update({ attachmentId });
    },
  };
}
