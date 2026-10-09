"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IMPORT_SESSION_KIND,
  isPendingImportQuestion,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  challengeImportSession,
  confirmImportSession,
  executeImportSession,
  getFullImportSession,
} from "../_lib/import-session-api";
import {
  assertWorkflowReceipt,
  ImportWorkflowResponseError,
  sameImportProposal,
} from "../_lib/import-session-workflow-read";
import {
  classifyImportFailure,
  describeImportFailure,
} from "../_lib/import-session-errors";
import { importRoot } from "../_lib/import-session-keys";
import { useImportUserId } from "./useImportSessions";
import { useImportWorkflowCatalog } from "./useImportWorkflowCatalog";

type FinancialAction = "CONFIRM" | "EXECUTE";
function availableAction(view: ImportSessionViewV1): FinancialAction | null {
  if (
    !view.searchComplete ||
    view.proposal?.kind !== IMPORT_SESSION_KIND ||
    view.attachments.some(
      (a) => a.state === "RESERVED" || a.state === "UPLOADED",
    ) ||
    view.questions.some(
      (q) =>
        isPendingImportQuestion(q) &&
        q.lineIds.some((id) => view.selectedLineIds.includes(id)),
    )
  )
    return null;
  if (
    view.state === "READY" &&
    !view.confirmation &&
    view.actions.includes("CONFIRM")
  )
    return "CONFIRM";
  if (
    view.state === "CONFIRMED" &&
    view.confirmation &&
    view.actions.includes("EXECUTE")
  )
    return "EXECUTE";
  return null;
}
const visibleTuple = (v: ImportSessionViewV1) =>
  JSON.stringify([v.id, v.revision, v.proposal?.proposalHash]);
const sameActions = (a: ImportSessionViewV1, b: ImportSessionViewV1) =>
  a.actions.length === b.actions.length &&
  a.actions.every((action) => b.actions.includes(action));
const failureText = (error: unknown) =>
  describeImportFailure(classifyImportFailure(error), "detail").message;

interface Generation {
  userId: string | null;
  sessionId: string | null;
  live: boolean;
  busy: boolean;
  attempt: { tuple: string; financialRequestId: string } | null;
}
interface Feedback {
  generation: Generation;
  pending: boolean;
  error: string | null;
  notice: string | null;
}

/** Inactive consumer. Server actions are the gate; state alone never authorizes a write. */
export function useImportExecution(sessionId: string | null) {
  const userId = useImportUserId();
  const client = useQueryClient();
  const scope = useRef<Generation>({
    userId,
    sessionId,
    live: true,
    busy: false,
    attempt: null,
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
      attempt: null,
    };
  }
  const generation = scope.current;
  useEffect(() => {
    generation.live = true;
    return () => {
      generation.live = false;
    };
  }, [generation]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const key = [...importRoot(userId ?? "anonymous"), "workflow", sessionId];
  const query = useQuery({
    queryKey: key,
    enabled: userId !== null && sessionId !== null,
    networkMode: "always",
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      if (sessionId === null) throw new ImportWorkflowResponseError();
      const view = await getFullImportSession(sessionId);
      signal.throwIfAborted();
      if (view.id !== sessionId) throw new ImportWorkflowResponseError();
      return view;
    },
  });
  const view =
    userId !== null && sessionId !== null ? (query.data ?? null) : null;
  const catalog = useImportWorkflowCatalog(userId, view);
  const local = feedback?.generation === generation ? feedback : null;
  const pending =
    query.isFetching || catalog.pending || local?.pending === true;
  const error =
    local?.error ?? (query.isError ? failureText(query.error) : catalog.error);
  const financialAction =
    view && catalog.data && !pending && !error ? availableAction(view) : null;
  const active = () => scope.current === generation && generation.live;
  const report = (next: Omit<Feedback, "generation">) => {
    if (active()) setFeedback({ generation, ...next });
  };
  const publish = (next: ImportSessionViewV1) => {
    if (active()) client.setQueryData(key, next);
  };
  async function readCurrent() {
    if (sessionId === null) throw new ImportWorkflowResponseError();
    const fresh = await getFullImportSession(sessionId);
    if (fresh.id !== sessionId) throw new ImportWorkflowResponseError();
    return fresh;
  }
  async function retry() {
    if (!active() || generation.busy || !userId || !sessionId) return;
    generation.busy = true;
    report({ pending: true, error: null, notice: null });
    try {
      const fresh = await readCurrent();
      if (!active()) return;
      publish(fresh);
      await catalog.retry();
      if (!active()) return;
      report({ pending: false, error: null, notice: null });
    } catch (error) {
      report({ pending: false, error: failureText(error), notice: null });
    } finally {
      generation.busy = false;
    }
  }
  async function act() {
    if (!active() || generation.busy || !view || !financialAction || !sessionId)
      return;
    generation.busy = true;
    const visible = view;
    const tuple = visibleTuple(visible);
    report({ pending: true, error: null, notice: null });
    let sentWrite = false;
    try {
      let fresh = await readCurrent();
      if (!active()) return;
      publish(fresh);
      if (
        visibleTuple(fresh) !== tuple ||
        !sameActions(fresh, visible) ||
        availableAction(fresh) !== financialAction
      ) {
        report({
          pending: false,
          error: null,
          notice:
            "A revisão mudou. Confira a proposta atual e escolha a ação novamente.",
        });
        return;
      }
      if (!sameImportProposal(fresh.proposal, visible.proposal))
        throw new ImportWorkflowResponseError();
      let financialRequestId = fresh.confirmation?.financialRequestId;
      if (financialAction === "CONFIRM") {
        if (!fresh.proposal) throw new ImportWorkflowResponseError();
        if (generation.attempt?.tuple !== tuple)
          generation.attempt = {
            tuple,
            financialRequestId: crypto.randomUUID(),
          };
        financialRequestId = generation.attempt.financialRequestId;
        const request = {
          expectedRevision: visible.revision,
          proposalHash: fresh.proposal.proposalHash,
        };
        const challenge = await challengeImportSession(sessionId, request);
        if (!active()) return;
        if (Date.parse(challenge.expiresAt) <= Date.now())
          throw new ImportWorkflowResponseError();
        sentWrite = true;
        const confirmed = await confirmImportSession(sessionId, {
          ...request,
          financialRequestId,
          nonce: challenge.nonce,
        });
        if (!active()) return;
        if (
          confirmed.sessionId !== sessionId ||
          confirmed.financialRequestId !== financialRequestId
        )
          throw new ImportWorkflowResponseError();
        // The confirm response deliberately has no actions. Only a new authorized read can permit execute.
        fresh = await readCurrent();
        if (!active()) return;
        publish(fresh);
        if (availableAction(fresh) !== "EXECUTE") {
          report({ pending: false, error: null, notice: null });
          return;
        }
        if (
          fresh.confirmation?.financialRequestId !== financialRequestId ||
          fresh.confirmation.confirmedRevision !== visible.revision ||
          fresh.confirmation.proposalHash !== visible.proposal?.proposalHash ||
          !sameImportProposal(fresh.proposal, visible.proposal)
        )
          throw new ImportWorkflowResponseError();
      }
      if (
        !financialRequestId ||
        fresh.confirmation?.financialRequestId !== financialRequestId
      )
        throw new ImportWorkflowResponseError();
      sentWrite = true;
      const receipt = await executeImportSession(
        sessionId,
        { financialRequestId },
        fresh.ownerProjectId,
      );
      if (!active()) return;
      assertWorkflowReceipt(receipt, fresh);
      const persisted = await readCurrent();
      if (!active()) return;
      publish(persisted);
      report({ pending: false, error: null, notice: null });
    } catch (error) {
      if (!active()) return;
      if (sentWrite) {
        try {
          const persisted = await readCurrent();
          if (!active()) return;
          publish(persisted);
          report({
            pending: false,
            error: null,
            notice:
              "A resposta da ação não pôde ser confirmada. O estado guardado foi consultado; confira-o antes de continuar.",
          });
        } catch (readError) {
          report({
            pending: false,
            error: failureText(readError),
            notice:
              "Resultado incerto. Consulte o estado guardado; não inicie outro lote.",
          });
        }
      } else {
        report({ pending: false, error: failureText(error), notice: null });
      }
    } finally {
      generation.busy = false;
    }
  }
  return {
    view,
    pending,
    error,
    notice: local?.notice ?? null,
    financialAction,
    act,
    retry,
    catalog: catalog.data,
    settled: local && !local.pending ? local : null,
  };
}
