"use client";

import { useEffect, useRef, useState } from "react";
import type { OcrCandidateView, OcrConsentIntentV2 } from "../_types";

export type OcrCandidateLoader = (
  intent: OcrConsentIntentV2,
  signal: AbortSignal,
) => Promise<readonly OcrCandidateView[]>;

interface ReviewState {
  scopeKey: string;
  candidates: readonly OcrCandidateView[];
  pending: boolean;
  error: boolean;
  attempted: boolean;
}

const empty = (scopeKey: string): ReviewState => ({
  scopeKey,
  candidates: [],
  pending: false,
  error: false,
  attempted: false,
});

/**
 * Owns only ephemeral OCR UI state. A loader must already be bound by its
 * adapter to the current authorized session/artifact route; the UI supplies
 * no actor, tenant, project, provider or artifact authority fields.
 */
export function useOcrReview({
  scopeKey,
  enabled,
  loadCandidates,
}: {
  scopeKey: string;
  enabled: boolean;
  loadCandidates?: OcrCandidateLoader;
}) {
  const scope = useRef(scopeKey);
  scope.current = scopeKey;
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<ReviewState>(() => empty(scopeKey));
  const current = state.scopeKey === scopeKey ? state : empty(scopeKey);

  useEffect(() => {
    request.current++;
    controller.current?.abort();
    controller.current = null;
    setState(empty(scopeKey));
    return () => {
      request.current++;
      controller.current?.abort();
    };
  }, [scopeKey]);

  async function start() {
    if (!enabled || !loadCandidates || current.pending || current.attempted)
      return;
    const ordinal = ++request.current;
    const admittedScope = scopeKey;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setState({
      scopeKey: admittedScope,
      candidates: [],
      pending: true,
      error: false,
      attempted: true,
    });
    try {
      const candidates = await loadCandidates(
        { version: 2, consentExternalProcessing: true },
        abort.signal,
      );
      if (
        abort.signal.aborted ||
        ordinal !== request.current ||
        admittedScope !== scope.current
      )
        return;
      setState({
        scopeKey: admittedScope,
        candidates,
        pending: false,
        error: false,
        attempted: true,
      });
    } catch {
      if (
        abort.signal.aborted ||
        ordinal !== request.current ||
        admittedScope !== scope.current
      )
        return;
      setState({
        scopeKey: admittedScope,
        candidates: [],
        pending: false,
        error: true,
        attempted: true,
      });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }

  return { ...current, start };
}
