"use client";

import { useQuery } from "@tanstack/react-query";
import { IMPORT_SESSION_LIMITS } from "@reformaflow/domain";
import { getImportObservations } from "../_lib/import-session-api";
import { importKeys } from "../_lib/import-session-keys";
import {
  ImportWorkflowResponseError,
  type ImportObservationView,
} from "../_lib/import-session-workflow-read";

async function readAllObservations(
  sessionId: string,
  signal: AbortSignal,
): Promise<ImportObservationView[]> {
  const observations: ImportObservationView[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  const maxPages = Math.ceil(
    IMPORT_SESSION_LIMITS.parsedRowsPerSession / IMPORT_SESSION_LIMITS.pageSize,
  );
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = await getImportObservations(sessionId, cursor, signal);
    for (const item of page.items) {
      if (seenIds.has(item.id)) throw new ImportWorkflowResponseError();
      seenIds.add(item.id);
      observations.push(item);
    }
    if (observations.length > IMPORT_SESSION_LIMITS.parsedRowsPerSession)
      throw new ImportWorkflowResponseError();
    if (page.nextCursor === null) return observations;
    if (seenCursors.has(page.nextCursor))
      throw new ImportWorkflowResponseError();
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new ImportWorkflowResponseError();
}

export function useImportObservations(
  userId: string | null,
  sessionId: string | null,
  revision: number | null,
  enabled = true,
) {
  return useQuery({
    queryKey: importKeys.observations(
      userId ?? "anonymous",
      sessionId ?? "",
      revision ?? 0,
    ),
    queryFn: ({ signal }) => readAllObservations(sessionId as string, signal),
    enabled:
      enabled && userId !== null && sessionId !== null && revision !== null,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
