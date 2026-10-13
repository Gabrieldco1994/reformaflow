"use client";

import { useEffect } from "react";
import { useImportSessionList } from "./useImportSessions";

export function usePersistedImportContinuation(
  userId: string | null,
  sessionId: string | null,
  enabled: boolean,
): string | null {
  const applied = useImportSessionList(userId, "applied", enabled);
  const continuationSessionId =
    applied.items.find((summary) => summary.id === sessionId)
      ?.continuationSessionId ?? null;

  useEffect(() => {
    if (
      applied.status !== "ready" ||
      continuationSessionId ||
      !applied.hasMore ||
      applied.loadingMore ||
      applied.failedNext
    )
      return;
    void applied.loadMore();
  }, [
    applied.failedNext,
    applied.hasMore,
    applied.loadMore,
    applied.loadingMore,
    applied.status,
    continuationSessionId,
  ]);

  return continuationSessionId;
}
