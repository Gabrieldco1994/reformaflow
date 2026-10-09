"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ImportSessionSummaryV1 } from "@reformaflow/domain";
import { useAuth } from "@/contexts/auth-context";
import {
  cancelImportSession,
  getImportResult,
  getImportSession,
  listImportSessions,
} from "../_lib/import-session-api";
import {
  classifyImportFailure,
  describeImportFailure,
  type ImportFailure,
  type ImportFailureInfo,
} from "../_lib/import-session-errors";
import {
  importKeys,
  importRoot,
  type ImportListScope,
} from "../_lib/import-session-keys";
import type {
  ImportEntryRead,
  ImportListRead,
  ImportResultRead,
  ImportViewRead,
} from "../_lib/import-session-read";

/**
 * Recovery data is authorization-scoped and private, so it is never a cache: no gc window,
 * refetched on every open, no retry storm (the user sees the error and decides), no persistence.
 */
const FRESH_READ = {
  // Offline must fail visibly: the default 'online' mode would pause the fetch and leave "loading" forever.
  networkMode: "always",
  gcTime: 0,
  staleTime: 0,
  retry: false,
  refetchOnMount: "always",
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;
const LIST_SCOPES: readonly ImportListScope[] = ["active", "applied"];

/**
 * The QueryClient outlives logout, so the namespace of a user who left is removed here.
 * Only the OLD namespace is touched: clearing everything after the new user's hooks mounted
 * could delete a query that is already in flight for them.
 */
export function useImportUserId(): string | null {
  const { user } = useAuth();
  const client = useQueryClient();
  const userId = user?.id ?? null;
  const previous = useRef<string | null>(userId);
  useEffect(() => {
    const old = previous.current;
    previous.current = userId;
    if (old && old !== userId)
      client.removeQueries({ queryKey: importRoot(old) });
  }, [userId, client]);
  return userId;
}

export type ImportFreshness = "none" | "fresh" | "refreshing" | "stale";

export interface ImportListState {
  entry: ImportEntryRead | null;
  status: "disabled" | "loading" | "error" | "ready";
  items: ImportSessionSummaryV1[];
  hasMore: boolean;
  /** `fresh` only when a completed GET backs what is on screen. */
  freshness: ImportFreshness;
  failure: ImportFailure | null;
  failedNext: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<unknown>;
  /** Drops every loaded page and starts again from the first: pages are never mixed. */
  restart: () => Promise<unknown>;
}

export function useImportSessionList(
  userId: string | null,
  scope: ImportListScope,
): ImportListState {
  const client = useQueryClient();
  const namespace = userId ?? "anonymous";
  const key = importKeys.list(namespace, scope);
  const query = useInfiniteQuery({
    ...FRESH_READ,
    queryKey: key,
    enabled: userId !== null,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const read = await listImportSessions(scope, pageParam);
      for (const sharedScope of LIST_SCOPES) {
        if (sharedScope === scope) continue;
        client.setQueryData<InfiniteData<ImportListRead>>(
          importKeys.list(namespace, sharedScope),
          (previous) =>
            previous
              ? {
                  ...previous,
                  pages: previous.pages.map((page) => ({
                    ...page,
                    entry: read.entry,
                  })),
                }
              : previous,
        );
      }
      return read;
    },
    getNextPageParam: (last) => last.page.nextCursor,
  });
  const items = useMemo(
    () => query.data?.pages.flatMap((read) => read.page.items) ?? [],
    [query.data],
  );
  const restart = useCallback(
    () => client.resetQueries({ queryKey: key }),
    [client, key],
  );
  const failure = query.isError ? classifyImportFailure(query.error) : null;

  let status: ImportListState["status"] = "ready";
  if (userId === null) status = "disabled";
  else if (!query.data) status = query.isError ? "error" : "loading";

  let freshness: ImportFreshness = "none";
  if (query.data) {
    if (query.isError) freshness = "stale";
    else
      freshness =
        query.isFetching && !query.isFetchingNextPage ? "refreshing" : "fresh";
  }

  return {
    entry:
      userId && !query.isFetching && !query.isError
        ? (query.data?.pages.at(-1)?.entry ?? null)
        : null,
    status,
    items: userId === null ? [] : items,
    hasMore: query.hasNextPage === true,
    freshness,
    failure,
    failedNext: query.isFetchNextPageError,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => query.fetchNextPage(),
    restart,
  };
}

export interface ImportReadState<T> {
  status: "disabled" | "loading" | "error" | "ready";
  data: T | null;
  freshness: ImportFreshness;
  failure: ImportFailure | null;
  retry: () => Promise<unknown>;
}

function readState<T>(
  query: {
    data: T | undefined;
    isError: boolean;
    isFetching: boolean;
    error: unknown;
    refetch: () => Promise<unknown>;
  },
  enabled: boolean,
): ImportReadState<T> {
  let status: ImportReadState<T>["status"] = "ready";
  if (!enabled) status = "disabled";
  else if (query.data === undefined)
    status = query.isError ? "error" : "loading";
  let freshness: ImportFreshness = "none";
  if (query.data !== undefined) {
    freshness = query.isError
      ? "stale"
      : query.isFetching
        ? "refreshing"
        : "fresh";
  }
  return {
    status,
    data: enabled ? (query.data ?? null) : null,
    freshness,
    failure: query.isError ? classifyImportFailure(query.error) : null,
    retry: query.refetch,
  };
}

export function useImportSession(userId: string | null, id: string | null) {
  const enabled = userId !== null && id !== null;
  const query = useQuery<ImportViewRead>({
    ...FRESH_READ,
    queryKey: importKeys.session(userId ?? "anonymous", id ?? ""),
    enabled,
    queryFn: () => getImportSession(id as string),
  });
  const state = readState(query, enabled);
  return { ...state, view: state.data };
}

export function useImportResult(userId: string | null, id: string | null) {
  const enabled = userId !== null && id !== null;
  const query = useQuery<ImportResultRead>({
    ...FRESH_READ,
    queryKey: importKeys.result(userId ?? "anonymous", id ?? ""),
    enabled,
    queryFn: () => getImportResult(id as string),
  });
  const state = readState(query, enabled);
  return { ...state, result: state.data };
}

export type CancelOutcome =
  | { kind: "cancelled"; view: ImportViewRead }
  /** 409 REVISION_CONFLICT: the session moved on; the caller shows the current state. */
  | { kind: "conflict" }
  /** 409 ALREADY_APPLIED: the caller looks the receipt up; it may still 404 generically. */
  | { kind: "already-applied" }
  | { kind: "failed"; failure: ImportFailure; info: ImportFailureInfo }
  /** A second tap while the first request is still running: nothing is sent. */
  | { kind: "busy" };

export function useCancelImportSession(userId: string | null) {
  const client = useQueryClient();
  const inFlight = useRef(false);

  const cancel = useCallback(
    async (id: string, expectedRevision: number): Promise<CancelOutcome> => {
      if (inFlight.current) return { kind: "busy" };
      inFlight.current = true;
      const reload = () => {
        if (userId === null) return;
        void client.resetQueries({
          queryKey: importKeys.list(userId, "active"),
        });
        void client.resetQueries({
          queryKey: importKeys.list(userId, "applied"),
        });
        void client.invalidateQueries({
          queryKey: importKeys.session(userId, id),
        });
      };
      try {
        const view = await cancelImportSession(id, expectedRevision);
        reload();
        return { kind: "cancelled", view };
      } catch (error) {
        const failure = classifyImportFailure(error);
        reload();
        if (
          failure.kind === "api" &&
          failure.error.code === "REVISION_CONFLICT"
        )
          return { kind: "conflict" };
        if (failure.kind === "api" && failure.error.code === "ALREADY_APPLIED")
          return { kind: "already-applied" };
        return {
          kind: "failed",
          failure,
          info: describeImportFailure(failure, "cancel"),
        };
      } finally {
        inFlight.current = false;
      }
    },
    [client, userId],
  );

  return { cancel };
}
