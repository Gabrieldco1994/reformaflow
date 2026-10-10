"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isPendingImportQuestion,
  parseImportDeclarationLiteral,
  parseSpokenMoney,
  type ImportCurrentLotV1,
  type ImportInterpretationResultV1,
  type ImportLineDocumentaryCommandV1,
  type ImportObservationQuestionV1,
  type ImportScopeReviewV1,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
  type ImportTypedDraftAnswerV1,
  type ImportTypedGuidedAnswerV1,
} from "@reformaflow/domain";
import type { ChatMessage } from "@/components/agent/useFinancialAgent";
import { ApiResponseError } from "@/lib/api";
import {
  continueImportAnswering,
  declareImportAnswer,
  deferImportLine,
  getFullImportSession,
  getImportCurrentLot,
  getImportResult,
  interpretImportAnswer,
  prepareImportCurrentLot,
  reactivateImportLine,
  resolveImportAnswer,
} from "../_lib/import-session-api";
import { importKeys, importRoot } from "../_lib/import-session-keys";
import {
  importConversationFailure,
  type ConversationFailure,
} from "../_lib/import-conversation-copy";
import {
  classifyImportFailure,
  isImportSessionErrorBody,
} from "../_lib/import-session-errors";
import {
  importDeclarationContext,
  isRecord,
  type ImportResultRead,
} from "../_lib/import-session-read";
import { isGuidedDraftField } from "../_lib/import-question-copy";
import { hasExactImportKeys } from "../_lib/import-session-workflow-read";
import { useImportUserId } from "./useImportSessions";

type Operation =
  | "DECLARE"
  | "RESOLVE"
  | "DEFER"
  | "REACTIVATE"
  | "CONTINUE_ANSWERING"
  | "PREPARE_CURRENT_LOT"
  | "INTERPRET";

interface Attempt {
  requestId: string;
  expectedRevision: number;
}

interface Generation {
  userId: string | null;
  sessionId: string | null;
  live: boolean;
  busy: boolean;
  attempts: Map<string, Attempt>;
  selectionFocusEpoch: number;
}

interface Local {
  failure: ConversationFailure | null;
  pending: boolean;
  currentLot: ImportCurrentLotV1 | null;
  result: ImportResultRead | null;
  editingQuestionId: string | null;
  selectionRecovery: SelectionRecovery | null;
  selectionFocus: SelectionFocus | null;
}

interface SelectionRecovery {
  phase: "VERIFY_REQUIRED" | "RETRY_READY";
  focusEpoch: number;
  key: string;
  operation: "DEFER" | "REACTIVATE";
  request: ImportLineDocumentaryCommandV1;
}

interface SelectionFocus {
  epoch: number;
  outcome: "APPLIED" | "CHANGED";
}

const empty = (): Local => ({
  failure: null,
  pending: false,
  currentLot: null,
  result: null,
  editingQuestionId: null,
  selectionRecovery: null,
  selectionFocus: null,
});

const attemptKey = (
  operation: Operation,
  reference: string,
  payload: unknown,
) => JSON.stringify([operation, reference, payload]);

type GuidedOrDraftAnswer = ImportTypedGuidedAnswerV1 | ImportTypedDraftAnswerV1;

function toDraftAnswer(
  question: ImportSessionQuestionV1,
  answer: GuidedOrDraftAnswer,
): ImportTypedDraftAnswerV1 | null {
  if (answer.kind === "UNKNOWN" || answer.kind === "REMOVE") return answer;
  if (answer.kind !== "KNOWN") return answer;
  switch (question.field) {
    case "amountCents": {
      if (typeof answer.value === "number")
        return { kind: "CENTS", value: answer.value };
      const reais = parseSpokenMoney(answer.value);
      return reais === null
        ? null
        : { kind: "CENTS", value: Math.round(reais * 100) };
    }
    case "installmentCount":
    case "installmentIndex": {
      const value =
        typeof answer.value === "number" ? answer.value : Number(answer.value);
      return Number.isSafeInteger(value)
        ? { kind: "POSITIVE_INTEGER", value }
        : null;
    }
    case "dataCompra":
    case "firstDueDate":
      return typeof answer.value === "string"
        ? { kind: "DATE", value: answer.value }
        : null;
    case "merchant":
      return typeof answer.value === "string"
        ? { kind: "TEXT", value: answer.value }
        : null;
    case "amountMeaning":
      return answer.value === "TOTAL_PURCHASE" ||
        answer.value === "INSTALLMENT_CHARGE"
        ? { kind: "AMOUNT_MEANING", value: answer.value }
        : null;
    case "targets":
    case "decision":
    case "tipoDespesa":
    case "categoriaMaoDeObra":
      return null;
  }
}

function isGuidedAnswer(
  answer: GuidedOrDraftAnswer,
): answer is ImportTypedGuidedAnswerV1 {
  return ["KNOWN", "UNKNOWN", "REMOVE"].includes(answer.kind);
}

function isTerminalInterpretationFailure(
  error: unknown,
  expectedSessionId: string,
  expectedRequestId: string,
) {
  if (!(error instanceof ApiResponseError)) return false;
  if (isImportSessionErrorBody(error.body)) {
    if (
      error.body.sessionId !== null &&
      error.body.sessionId !== expectedSessionId
    )
      return false;
    return error.body.code !== "LEASE_CONFLICT";
  }
  if (
    !isRecord(error.body) ||
    !hasExactImportKeys(error.body, ["version", "requestId", "code"]) ||
    error.body.version !== 1 ||
    error.body.requestId !== expectedRequestId
  )
    return false;
  return (
    (error.status === 503 && error.body.code === "PROVIDER_UNAVAILABLE") ||
    (error.status === 502 && error.body.code === "MODEL_OUTPUT_INVALID")
  );
}

/**
 * Documentary import coordinator.
 *
 * The browser carries typed intent and retry identity only. The server resolves
 * field, line, observation and financial context and remains the sole readiness
 * authority.
 */
export function useImportConversation(
  sessionId: string | null,
  _documentaryRead = false,
) {
  const userId = useImportUserId();
  const client = useQueryClient();
  const scope = useRef<Generation>({
    userId,
    sessionId,
    live: true,
    busy: false,
    attempts: new Map(),
    selectionFocusEpoch: 0,
  });
  if (
    scope.current.userId !== userId ||
    scope.current.sessionId !== sessionId
  ) {
    scope.current.live = false;
    scope.current = {
      userId,
      sessionId,
      live: true,
      busy: false,
      attempts: new Map(),
      selectionFocusEpoch: 0,
    };
  }
  const generation = scope.current;
  useEffect(() => {
    generation.live = true;
    return () => {
      generation.live = false;
    };
  }, [generation]);

  const [state, setState] = useState<{ generation: Generation; local: Local }>(
    () => ({ generation, local: empty() }),
  );
  const local = state.generation === generation ? state.local : empty();
  const active = () => scope.current === generation && generation.live;
  const update = (patch: Partial<Local>) => {
    if (!active()) return;
    setState((previous) => ({
      generation,
      local: {
        ...(previous.generation === generation ? previous.local : empty()),
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
      local.currentLot === null &&
      !local.failure?.privateContextLost,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      if (!sessionId) throw new Error("Missing import session");
      const view = await getFullImportSession(sessionId, signal);
      signal.throwIfAborted();
      if (view.id !== sessionId) throw new Error("Unexpected import session");
      return view;
    },
  });

  const queryFailure = query.isError
    ? importConversationFailure(query.error)
    : null;
  const failure = local.failure ?? queryFailure;
  const view =
    userId && sessionId && !failure?.privateContextLost
      ? (query.data ?? null)
      : null;
  const selectedPendingQuestions =
    view?.questions.filter(
      (candidate) =>
        isPendingImportQuestion(candidate) &&
        candidate.lineIds.some((lineId) =>
          view.selectedLineIds.includes(lineId),
        ),
    ) ?? [];
  const guidedFocus = view?.guidedReview?.focus ?? null;
  const guidedQuestion = guidedFocus
    ? selectedPendingQuestions.find(
        (candidate) => candidate.id === guidedFocus.questionId,
      )
    : null;
  const selectedNonGuidedQuestions = selectedPendingQuestions.filter(
    (candidate) => !isGuidedDraftField(candidate.field),
  );
  const fallbackQuestion =
    selectedNonGuidedQuestions.find(
      (candidate) => candidate.id === local.editingQuestionId,
    ) ??
    selectedNonGuidedQuestions[0] ??
    null;
  const question = guidedFocus
    ? guidedQuestion
    : view?.guidedReview
      ? fallbackQuestion
      : (selectedPendingQuestions.find(
          (candidate) => candidate.id === local.editingQuestionId,
        ) ??
        selectedPendingQuestions[0] ??
        null);
  const pending = local.pending || query.isFetching;

  const publish = (fresh: ImportSessionViewV1) => {
    if (active()) client.setQueryData(key, fresh);
  };
  const readCurrent = async () => {
    if (!sessionId) throw new Error("Missing import session");
    const fresh = await getFullImportSession(sessionId);
    if (fresh.id !== sessionId) throw new Error("Unexpected import session");
    return fresh;
  };
  const rememberAttempt = (
    operation: Operation,
    reference: string,
    payload: unknown,
    revision: number,
  ) => {
    const key = attemptKey(operation, reference, payload);
    const remembered = generation.attempts.get(key);
    if (remembered) return { key, attempt: remembered };
    const attempt = {
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
    };
    generation.attempts.set(key, attempt);
    return { key, attempt };
  };
  const begin = () => {
    if (!active() || generation.busy) return false;
    generation.busy = true;
    update({ pending: true, failure: null, selectionFocus: null });
    return true;
  };
  const finish = () => {
    generation.busy = false;
  };
  const fail = (
    error: unknown,
    selectionRecovery: SelectionRecovery | null = null,
  ) => {
    update({
      pending: false,
      failure: importConversationFailure(error),
      selectionRecovery,
    });
  };

  const selectionOutcomeUnknown = (error: unknown) => {
    const failure = classifyImportFailure(error);
    return (
      failure.kind === "offline" ||
      failure.kind === "timeout" ||
      failure.kind === "malformed" ||
      failure.kind === "unknown"
    );
  };

  const selectionWasApplied = (
    fresh: ImportSessionViewV1,
    recovery: SelectionRecovery,
  ) => {
    const line = fresh.lines.find(
      (candidate) => candidate.id === recovery.request.lineId,
    );
    if (!line) return false;
    return recovery.operation === "DEFER"
      ? line.decision.kind === "DEFER" &&
          !fresh.selectedLineIds.includes(line.id)
      : line.decision.kind !== "DEFER" &&
          fresh.selectedLineIds.includes(line.id);
  };

  const selectionCanReplay = (
    fresh: ImportSessionViewV1,
    recovery: SelectionRecovery,
  ) => {
    if (
      fresh.revision !== recovery.request.expectedRevision ||
      !fresh.actions.includes("RESOLVE")
    )
      return false;
    const line = fresh.lines.find(
      (candidate) => candidate.id === recovery.request.lineId,
    );
    if (!line) return false;
    return recovery.operation === "DEFER"
      ? fresh.selectedLineIds.includes(line.id)
      : line.decision.kind === "DEFER" &&
          !fresh.selectedLineIds.includes(line.id);
  };

  async function saveGuidedAnswer(command: {
    questionId: string;
    answer: GuidedOrDraftAnswer;
  }) {
    if (!view || !sessionId || !question || !view.actions.includes("RESOLVE"))
      return null;
    if (command.questionId !== question.id || !begin()) return null;
    const transport =
      "subject" in question
        ? isGuidedAnswer(command.answer)
          ? { operation: "DECLARE" as const, answer: command.answer }
          : null
        : (() => {
            const answer = toDraftAnswer(question, command.answer);
            return answer ? { operation: "RESOLVE" as const, answer } : null;
          })();
    if (!transport) {
      fail(new Error("Invalid guided answer"));
      return null;
    }
    const remembered = rememberAttempt(
      transport.operation,
      question.id,
      transport.answer,
      view.revision,
    );
    try {
      const receipt =
        transport.operation === "DECLARE"
          ? await declareImportAnswer(sessionId, {
              version: 1,
              ...remembered.attempt,
              questionId: question.id,
              answer: transport.answer,
            })
          : await resolveImportAnswer(sessionId, {
              version: 1,
              ...remembered.attempt,
              questionId: question.id,
              answer: transport.answer,
            });
      const fresh = await readCurrent();
      if (!active() || fresh.revision !== receipt.revision)
        throw new Error("Import command/read mismatch");
      publish(fresh);
      generation.attempts.delete(remembered.key);
      update({
        pending: false,
        failure: null,
        editingQuestionId: null,
        selectionRecovery: null,
        selectionFocus:
          fresh.guidedReview?.focus &&
          fresh.guidedReview.focus.questionId !== question.id
            ? {
                epoch: ++generation.selectionFocusEpoch,
                outcome: "APPLIED",
              }
            : null,
      });
      return receipt;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      finish();
    }
  }

  async function retrySelection() {
    const recovery = local.selectionRecovery;
    if (!recovery || recovery.phase !== "RETRY_READY" || !sessionId || !begin())
      return null;
    try {
      const receipt =
        recovery.operation === "DEFER"
          ? await deferImportLine(sessionId, recovery.request)
          : await reactivateImportLine(sessionId, recovery.request);
      const confirmed = await readCurrent();
      if (!active() || confirmed.revision < receipt.revision)
        throw new Error("Import command/read mismatch");
      publish(confirmed);
      generation.attempts.delete(recovery.key);
      update({
        pending: false,
        failure: null,
        editingQuestionId: null,
        selectionRecovery: null,
        selectionFocus: {
          epoch: recovery.focusEpoch,
          outcome: "APPLIED",
        },
      });
      return receipt;
    } catch (error) {
      if (selectionOutcomeUnknown(error))
        fail(error, { ...recovery, phase: "VERIFY_REQUIRED" });
      else {
        generation.attempts.delete(recovery.key);
        fail(error);
      }
      return null;
    } finally {
      finish();
    }
  }

  async function saveDeclaration(answer: { id: string; text: string }) {
    if (
      !view ||
      !question ||
      !("subject" in question) ||
      answer.id !== question.id
    )
      return null;
    const parsed = parseImportDeclarationLiteral(
      importDeclarationContext(question, view.declaredFacts),
      answer.text,
    );
    if (parsed.kind !== "VALID") {
      fail(new Error("Invalid guided answer"));
      return null;
    }
    const typed: ImportTypedGuidedAnswerV1 =
      parsed.answer.value === null
        ? { kind: "UNKNOWN" }
        : { kind: "KNOWN", value: parsed.answer.value };
    return saveGuidedAnswer({ questionId: question.id, answer: typed });
  }

  async function changeSelection(
    lineId: string,
    operation: "DEFER" | "REACTIVATE",
  ) {
    if (!view || !sessionId || !view.actions.includes("RESOLVE")) return null;
    const line = view.lines.find((candidate) => candidate.id === lineId);
    const valid =
      line &&
      (operation === "DEFER"
        ? view.selectedLineIds.includes(lineId)
        : !view.selectedLineIds.includes(lineId) &&
          line.decision.kind === "DEFER");
    if (!valid || !begin()) return null;
    const focusEpoch = ++generation.selectionFocusEpoch;
    const remembered = rememberAttempt(
      operation,
      lineId,
      { lineId },
      view.revision,
    );
    const request = {
      version: 1 as const,
      ...remembered.attempt,
      lineId,
    };
    try {
      const receipt =
        operation === "DEFER"
          ? await deferImportLine(sessionId, request)
          : await reactivateImportLine(sessionId, request);
      const fresh = await readCurrent();
      if (!active() || fresh.revision < receipt.revision)
        throw new Error("Import command/read mismatch");
      publish(fresh);
      generation.attempts.delete(remembered.key);
      update({
        pending: false,
        failure: null,
        editingQuestionId: null,
        selectionRecovery: null,
        selectionFocus: { epoch: focusEpoch, outcome: "APPLIED" },
      });
      return receipt;
    } catch (error) {
      if (selectionOutcomeUnknown(error))
        fail(error, {
          phase: "VERIFY_REQUIRED",
          focusEpoch,
          key: remembered.key,
          operation,
          request,
        });
      else {
        generation.attempts.delete(remembered.key);
        fail(error);
      }
      return null;
    } finally {
      finish();
    }
  }

  async function prepareCurrentLot({ review }: { review: boolean }) {
    if (!view || !sessionId) return null;
    const guidedProgress = view.guidedReview?.progress;
    if (
      review &&
      (guidedProgress === "READY" || guidedProgress === "READY_WITH_PENDING")
    )
      return openReadyCurrentLot();
    if ((!review && guidedProgress !== "ANSWERING") || !begin()) return null;
    const remembered = rememberAttempt(
      "PREPARE_CURRENT_LOT",
      sessionId,
      {},
      view.revision,
    );
    try {
      const receipt = await prepareImportCurrentLot(sessionId, {
        version: 1,
        ...remembered.attempt,
      });
      if (receipt.outcome === "NEEDS_INPUT") {
        const fresh = await readCurrent();
        if (!active() || fresh.revision !== receipt.revision)
          throw new Error("Import command/read mismatch");
        publish(fresh);
        generation.attempts.delete(remembered.key);
        update({
          pending: false,
          failure: null,
          selectionFocus: fresh.guidedReview?.focus
            ? {
                epoch: ++generation.selectionFocusEpoch,
                outcome: "APPLIED",
              }
            : null,
        });
        return null;
      }
      if (receipt.outcome !== "CURRENT_LOT_READY")
        throw new Error("Current lot is not ready");
      const fresh = await readCurrent();
      if (!active() || fresh.revision !== receipt.revision)
        throw new Error("Import command/read mismatch");
      publish(fresh);
      if (!review) {
        generation.attempts.delete(remembered.key);
        update({
          pending: false,
          failure: null,
          selectionFocus: fresh.guidedReview?.focus
            ? {
                epoch: ++generation.selectionFocusEpoch,
                outcome: "APPLIED",
              }
            : null,
        });
        return null;
      }
      const lot = await getImportCurrentLot(sessionId);
      if (lot.revision !== receipt.revision)
        throw new Error("Current lot command/read mismatch");
      generation.attempts.delete(remembered.key);
      update({ pending: false, failure: null, currentLot: lot });
      await client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
      return lot;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      finish();
    }
  }

  async function openReadyCurrentLot() {
    if (!view || !sessionId) return null;
    const progress = view.guidedReview?.progress;
    if (
      progress !== "READY" &&
      progress !== "READY_WITH_PENDING" &&
      view.guidedReview
    )
      return null;
    if (!begin()) return null;
    try {
      const lot = await getImportCurrentLot(sessionId);
      if (
        !active() ||
        lot.revision !== view.revision ||
        (progress === "READY" &&
          (lot.state !== "READY" || lot.hasRemainingWork)) ||
        (progress === "READY_WITH_PENDING" &&
          (lot.state !== "READY_WITH_PENDING" || !lot.hasRemainingWork))
      )
        throw new Error("Current lot command/read mismatch");
      update({ pending: false, failure: null, currentLot: lot });
      await client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
      return lot;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      finish();
    }
  }

  async function continueGuidedReview() {
    if (
      !view ||
      !sessionId ||
      view.guidedReview?.progress !== "READY_WITH_PENDING" ||
      !view.guidedReview.actions.includes("CONTINUE_ANSWERING") ||
      !begin()
    )
      return null;
    const remembered = rememberAttempt(
      "CONTINUE_ANSWERING",
      sessionId,
      {},
      view.revision,
    );
    try {
      const receipt = await continueImportAnswering(sessionId, {
        version: 1,
        ...remembered.attempt,
      });
      if (receipt.outcome !== "NEEDS_INPUT")
        throw new Error("Import continuation did not request input");
      const fresh = await readCurrent();
      if (!active() || fresh.revision !== receipt.revision)
        throw new Error("Import command/read mismatch");
      publish(fresh);
      generation.attempts.delete(remembered.key);
      update({
        pending: false,
        failure: null,
        editingQuestionId: null,
        selectionRecovery: null,
        selectionFocus: fresh.guidedReview?.focus
          ? {
              epoch: ++generation.selectionFocusEpoch,
              outcome: "APPLIED",
            }
          : null,
      });
      return receipt;
    } catch (error) {
      if (!selectionOutcomeUnknown(error))
        generation.attempts.delete(remembered.key);
      fail(error);
      return null;
    } finally {
      finish();
    }
  }

  async function interpretAnswer(
    text: string,
  ): Promise<ImportInterpretationResultV1> {
    if (
      !view ||
      !sessionId ||
      !question ||
      !("subject" in question) ||
      !text.trim()
    )
      throw new Error("Interpretation is unavailable");
    const remembered = rememberAttempt(
      "INTERPRET",
      question.id,
      text,
      view.revision,
    );
    try {
      const outcome = await interpretImportAnswer(sessionId, {
        version: 1,
        ...remembered.attempt,
        questionId: question.id,
        text,
        consentExternalProcessing: true,
      });
      generation.attempts.delete(remembered.key);
      return outcome;
    } catch (error) {
      if (
        isTerminalInterpretationFailure(
          error,
          sessionId,
          remembered.attempt.requestId,
        )
      )
        generation.attempts.delete(remembered.key);
      // Unknown outcomes and lease conflicts retain the id for deliberate retry.
      throw error;
    }
  }

  async function recover(readResult = false) {
    if (!active() || generation.busy || !sessionId) return;
    generation.busy = true;
    update({ pending: true, failure: null });
    try {
      if (local.currentLot) {
        const lot = await getImportCurrentLot(sessionId);
        generation.attempts.clear();
        update({
          pending: false,
          currentLot: lot,
          selectionRecovery: null,
        });
        return;
      }
      const fresh = await readCurrent();
      publish(fresh);
      const selectionRecovery = local.selectionRecovery;
      if (selectionRecovery && selectionRecovery.phase === "VERIFY_REQUIRED") {
        if (selectionWasApplied(fresh, selectionRecovery)) {
          generation.attempts.delete(selectionRecovery.key);
          update({
            pending: false,
            failure: null,
            editingQuestionId: null,
            selectionRecovery: null,
            selectionFocus: {
              epoch: selectionRecovery.focusEpoch,
              outcome: "APPLIED",
            },
          });
          return;
        }
        if (selectionCanReplay(fresh, selectionRecovery)) {
          update({
            pending: false,
            failure: null,
            selectionRecovery: {
              ...selectionRecovery,
              phase: "RETRY_READY",
            },
          });
          return;
        }
        generation.attempts.delete(selectionRecovery.key);
        update({
          pending: false,
          failure: {
            message:
              "A importação mudou. Confira o estado atual antes de tentar novamente.",
            recovery: "NONE",
            privateContextLost: false,
          },
          selectionRecovery: null,
          selectionFocus: {
            epoch: selectionRecovery.focusEpoch,
            outcome: "CHANGED",
          },
        });
        return;
      }
      let result: ImportResultRead | null = null;
      if (readResult || fresh.state === "APPLIED") {
        result = await getImportResult(sessionId);
        client.setQueryData(importKeys.result(userId!, sessionId), result);
      }
      const continuationKey = attemptKey("CONTINUE_ANSWERING", sessionId, {});
      const continuation = generation.attempts.get(continuationKey);
      const continuationNotApplied =
        continuation !== undefined &&
        fresh.revision === continuation.expectedRevision &&
        fresh.guidedReview?.progress === "READY_WITH_PENDING" &&
        fresh.guidedReview.actions.includes("CONTINUE_ANSWERING");
      const continuationApplied =
        continuation !== undefined &&
        fresh.revision === continuation.expectedRevision + 1 &&
        fresh.guidedReview?.progress === "ANSWERING";
      generation.attempts.clear();
      if (continuationNotApplied && continuation)
        generation.attempts.set(continuationKey, continuation);
      update({
        pending: false,
        failure: null,
        result,
        selectionRecovery: null,
        selectionFocus:
          continuationApplied && fresh.guidedReview?.focus
            ? {
                epoch: ++generation.selectionFocusEpoch,
                outcome: "APPLIED",
              }
            : null,
      });
    } catch (error) {
      const selectionRecovery = local.selectionRecovery;
      fail(
        error,
        selectionRecovery?.phase === "VERIFY_REQUIRED"
          ? selectionRecovery
          : null,
      );
    } finally {
      finish();
    }
  }

  function editQuestion(id: string) {
    if (
      !view?.questions.some(
        (candidate) =>
          candidate.id === id &&
          candidate.lineIds.some((lineId) =>
            view.selectedLineIds.includes(lineId),
          ),
      )
    )
      return;
    update({ editingQuestionId: id, failure: null });
  }

  return {
    userId,
    view,
    question,
    guidedReview: view?.guidedReview ?? null,
    guidedFocus,
    error: failure,
    busy: pending,
    currentLot: local.currentLot,
    review: local.currentLot !== null,
    result: local.result,
    saveDeclaration,
    saveGuidedAnswer,
    continueGuidedReview,
    interpretAnswer,
    prepareCurrentLot: () => prepareCurrentLot({ review: false }),
    reviewCurrentLot: () => prepareCurrentLot({ review: true }),
    retryableSelection:
      local.selectionRecovery?.phase === "RETRY_READY"
        ? {
            operation: local.selectionRecovery.operation,
            lineId: local.selectionRecovery.request.lineId,
          }
        : null,
    selectionRecoveryFocus: local.selectionRecovery
      ? {
          epoch: local.selectionRecovery.focusEpoch,
          outcome: local.selectionRecovery.phase,
        }
      : local.selectionFocus,
    retrySelection,
    editQuestion,
    recover,
    addToSelection: (lineId: string) => changeSelection(lineId, "REACTIVATE"),
    removeFromSelection: (lineId: string) => changeSelection(lineId, "DEFER"),
    // Legacy no-op surface retained only while sibling route tests migrate.
    messages: [] as ChatMessage[],
    literal: "",
    guided: null,
    scopeReview: null as ImportScopeReviewV1 | null,
    scopeRevision: null,
    attachmentId: null,
    setLiteral: (_literal: string) => undefined,
    setAttachmentId: (_attachmentId: string | null) => undefined,
    startGuidedAnswer: () => undefined,
    approveScope: async () => null,
    send: async (
      _literal: string,
      _channel: "TEXT" | "VOICE" = "TEXT",
      explicit?: "CONTINUE" | "OPEN_REVIEW" | "READ_RESULT",
    ): Promise<ChatMessage | null> => {
      if (explicit === "OPEN_REVIEW") await prepareCurrentLot({ review: true });
      if (explicit === "READ_RESULT") await recover(true);
      return null;
    },
  };
}

export type ImportFocusedServerQuestion = ImportSessionQuestionV1;
export type ImportFocusedDocumentaryQuestion = ImportObservationQuestionV1;
