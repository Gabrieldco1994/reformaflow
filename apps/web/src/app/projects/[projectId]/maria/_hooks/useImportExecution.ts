"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ImportCurrentLotV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import type { ImportResultRead } from "../_lib/import-session-read";
import {
  challengeImportSession,
  confirmImportSession,
  executeConfirmedCurrentLot,
  getImportCurrentLot,
  getImportResult,
} from "../_lib/import-session-api";
import {
  classifyImportFailure,
  describeImportFailure,
} from "../_lib/import-session-errors";
import { importKeys, importRoot } from "../_lib/import-session-keys";
import { useImportUserId } from "./useImportSessions";
import type { useImportWorkflowCatalog } from "./useImportWorkflowCatalog";

type FinancialAction = "CONFIRM" | "EXECUTE";
const failureText = (error: unknown) =>
  describeImportFailure(classifyImportFailure(error), "detail").message;

interface Generation {
  userId: string | null;
  sessionId: string | null;
  live: boolean;
  busy: boolean;
  financialRequestId: string | null;
}

interface Feedback {
  generation: Generation;
  pending: boolean;
  error: string | null;
  notice: string | null;
}

interface ResultState {
  generation: Generation;
  result: ImportResultRead;
}

const financialStorageKey = (userId: string, sessionId: string) =>
  `rf:import-financial-request:${userId}:${sessionId}`;
const readFinancialRequestId = (
  userId: string | null,
  sessionId: string | null,
) => {
  if (typeof window === "undefined" || !userId || !sessionId) return null;
  return window.sessionStorage.getItem(financialStorageKey(userId, sessionId));
};
const storeFinancialRequestId = (
  userId: string,
  sessionId: string,
  requestId: string | null,
) => {
  if (typeof window === "undefined") return;
  const key = financialStorageKey(userId, sessionId);
  if (requestId === null) window.sessionStorage.removeItem(key);
  else window.sessionStorage.setItem(key, requestId);
};

/**
 * Financial actions consume the server's ready-only lot. Resolution data and
 * hidden lines are never loaded into this review query.
 */
export function useImportExecution(
  sessionId: string | null,
  initialLot: ImportCurrentLotV1 | null = null,
) {
  const userId = useImportUserId();
  const client = useQueryClient();
  const scope = useRef<Generation>({
    userId,
    sessionId,
    live: true,
    busy: false,
    financialRequestId: readFinancialRequestId(userId, sessionId),
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
      financialRequestId: readFinancialRequestId(userId, sessionId),
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
  const key = [
    ...importRoot(userId ?? "anonymous"),
    "current-lot",
    sessionId,
    initialLot?.state,
    initialLot?.revision,
    initialLot?.confirmationHash,
  ];
  const query = useQuery({
    queryKey: key,
    enabled: userId !== null && sessionId !== null && initialLot !== null,
    initialData: initialLot ?? undefined,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      if (!sessionId) throw new Error("Missing import session");
      return getImportCurrentLot(sessionId);
    },
  });
  useEffect(() => {
    if (initialLot) client.setQueryData(key, initialLot);
    // The query key is fully determined by these scalar identity members.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, initialLot, userId, sessionId]);
  const local = feedback?.generation === generation ? feedback : null;
  const [resultState, setResultState] = useState<ResultState | null>(null);
  const result =
    resultState?.generation === generation ? resultState.result : null;
  const applied = result?.state === "APPLIED";
  const lot = applied ? null : initialLot ? (query.data ?? initialLot) : null;
  const pending = query.isFetching || local?.pending === true;
  const error =
    local?.error ?? (query.isError ? failureText(query.error) : null);
  const financialAction: FinancialAction | null =
    !lot || pending || error
      ? null
      : lot.actions.includes("CONFIRM")
        ? "CONFIRM"
        : lot.actions.includes("EXECUTE") && generation.financialRequestId
          ? "EXECUTE"
          : null;
  const active = () => scope.current === generation && generation.live;
  const report = (next: Omit<Feedback, "generation">) => {
    if (active()) setFeedback({ generation, ...next });
  };
  const cacheResult = (next: ImportResultRead) => {
    if (!active()) return false;
    if (userId && sessionId)
      client.setQueryData(importKeys.result(userId, sessionId), next);
    setResultState({ generation, result: next });
    return true;
  };
  const completeApplied = (next: ImportResultRead) => {
    if (next.state !== "APPLIED" || next.receipt === null)
      throw new Error("Current lot was not applied");
    if (!cacheResult(next)) return;
    generation.financialRequestId = null;
    if (userId && sessionId) storeFinancialRequestId(userId, sessionId, null);
    report({
      pending: false,
      error: null,
      notice: "Compras deste lote adicionadas.",
    });
  };

  async function retry() {
    if (!active() || generation.busy || !sessionId || !initialLot) return;
    generation.busy = true;
    report({ pending: true, error: null, notice: null });
    try {
      const result = await getImportResult(sessionId);
      if (!active()) return;
      if (result.state === "APPLIED") {
        completeApplied(result);
        return;
      }
      if (!cacheResult(result)) return;
      const fresh = await getImportCurrentLot(sessionId);
      if (!active()) return;
      client.setQueryData(key, fresh);
      report({ pending: false, error: null, notice: null });
    } catch (error) {
      report({ pending: false, error: failureText(error), notice: null });
    } finally {
      generation.busy = false;
    }
  }

  async function act() {
    if (!active() || generation.busy || !sessionId || !lot || !financialAction)
      return;
    generation.busy = true;
    report({ pending: true, error: null, notice: null });
    try {
      const fresh = await getImportCurrentLot(sessionId);
      if (!active()) return;
      if (
        fresh.revision !== lot.revision ||
        fresh.confirmationHash !== lot.confirmationHash ||
        !fresh.actions.includes(financialAction)
      ) {
        if (!active()) return;
        client.setQueryData(key, fresh);
        report({
          pending: false,
          error: null,
          notice:
            "A revisão mudou. Confira as compras atuais antes de continuar.",
        });
        return;
      }
      if (financialAction === "CONFIRM") {
        const confirmationHash = fresh.confirmationHash;
        const financialRequestId =
          generation.financialRequestId ?? crypto.randomUUID();
        if (!active()) return;
        generation.financialRequestId = financialRequestId;
        const request = {
          expectedRevision: fresh.revision,
          confirmationHash,
        };
        if (!active()) return;
        const challenge = await challengeImportSession(sessionId, request);
        if (!active()) return;
        if (userId)
          storeFinancialRequestId(userId, sessionId, financialRequestId);
        if (!active()) return;
        const confirmation = await confirmImportSession(sessionId, {
          ...request,
          financialRequestId,
          nonce: challenge.nonce,
        });
        if (!active()) return;
        if (
          confirmation.sessionId !== sessionId ||
          confirmation.financialRequestId !== financialRequestId
        )
          throw new Error("Unexpected confirmation response");
        if (confirmation.state === "CONFIRMED") {
          if (!active()) return;
          await executeConfirmedCurrentLot(sessionId, { financialRequestId });
          if (!active()) return;
        } else if (confirmation.state !== "APPLIED")
          throw new Error("Current lot was not confirmed");
      } else {
        const financialRequestId = generation.financialRequestId;
        if (!financialRequestId) throw new Error("Missing financial request");
        if (!active()) return;
        await executeConfirmedCurrentLot(sessionId, { financialRequestId });
        if (!active()) return;
      }
      const financialRequestId = generation.financialRequestId;
      if (!financialRequestId) throw new Error("Missing financial request");
      if (!active()) return;
      const result = await getImportResult(sessionId);
      if (!active()) return;
      completeApplied(result);
    } catch (error) {
      report({
        pending: false,
        error: failureText(error),
        notice:
          "O estado financeiro não foi presumido. Consulte o estado guardado antes de tentar novamente.",
      });
    } finally {
      generation.busy = false;
    }
  }

  return {
    lot,
    pending,
    error,
    notice: local?.notice ?? null,
    result,
    financialAction,
    act,
    retry,
    catalog: null as ReturnType<typeof useImportWorkflowCatalog>["data"],
    settled: local && !local.pending ? local : null,
    /** Compile-only bridge for old route tests; production review uses `lot`. */
    view: null as ImportSessionViewV1 | null,
  };
}
