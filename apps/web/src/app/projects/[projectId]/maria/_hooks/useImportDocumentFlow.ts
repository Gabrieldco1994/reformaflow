"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_LIMITS,
  type ImportSessionCreateRequestV1,
  type ImportSessionEntryV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  analyzeImportAttachment,
  createImportSession,
  getFullImportSession,
  reserveImportSessionAttachments,
  uploadImportSessionAttachment,
} from "../_lib/import-session-api";
import { importRoot } from "../_lib/import-session-keys";
import { importConversationFailure } from "../_lib/import-conversation-copy";
import {
  classifyImportFailure,
  describeImportFailure,
} from "../_lib/import-session-errors";
import { ImportWorkflowResponseError } from "../_lib/import-session-workflow-read";
import { useImportUserId } from "./useImportSessions";
import type { ImportEntryCard } from "../_lib/import-session-read";

type EntryFormat = Extract<
  ImportSessionEntryV1,
  { kind: "CARD_INVOICE" }
>["formats"][number];
const DECLARED_MIME: Record<EntryFormat, string> = {
  CSV: "text/csv",
  OFX: "application/x-ofx",
  PDF: "application/pdf",
  XLS: "application/vnd.ms-excel",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
interface Attempt {
  request: ImportSessionCreateRequestV1;
  ownerProjectId: string;
  files: Array<{ id: string; file: File; mime: string }>;
}
interface DocumentContext {
  key: string;
  adoptionKey: (sessionId: string) => string;
  publishSession: (sessionId: string) => void;
  recoverList: () => Promise<void>;
}

interface DocumentFailure {
  message: string;
  privateContextLost: boolean;
}
interface Generation {
  userId: string | null;
  sessionId: string | null;
  live: boolean;
  busy: boolean;
  mustRead: boolean;
  revoked: boolean;
  controller: AbortController | null;
  contextKey: string;
  invalidated: boolean;
  attempt: Attempt | null;
  adoption: { attempt: Attempt; id: string; key: string } | null;
}
interface Feedback {
  pending: boolean;
  error: DocumentFailure | null;
  notice: string | null;
}
const empty = (): Feedback => ({ pending: false, error: null, notice: null });
const newGeneration = (
  userId: string | null,
  sessionId: string | null,
  contextKey: string,
): Generation => ({
  userId,
  sessionId,
  contextKey,
  live: true,
  busy: false,
  mustRead: false,
  revoked: false,
  invalidated: false,
  controller: null,
  attempt: null,
  adoption: null,
});

/** Documentary coordinator only; server actions still own analysis eligibility. */
export function useImportDocumentFlow(
  requestedSessionId: string | null,
  context?: DocumentContext,
) {
  const userId = useImportUserId();
  const client = useQueryClient();
  const contextKey = context?.key ?? JSON.stringify(requestedSessionId);
  const scope = useRef<Generation>(
    newGeneration(userId, requestedSessionId, contextKey),
  );
  const echo = scope.current.adoption;
  if (
    scope.current.userId === userId &&
    !scope.current.invalidated &&
    echo &&
    echo.attempt === scope.current.attempt &&
    echo.id === requestedSessionId &&
    echo.key === contextKey
  ) {
    scope.current.contextKey = contextKey;
    scope.current.adoption = null;
  }
  if (
    scope.current.userId !== userId ||
    scope.current.contextKey !== contextKey ||
    scope.current.invalidated
  ) {
    scope.current.live = false;
    scope.current.controller?.abort();
    scope.current = newGeneration(userId, requestedSessionId, contextKey);
  }
  const generation = scope.current;
  const sessionId = generation.sessionId;
  useEffect(() => {
    generation.live = scope.current === generation;
    return () => {
      generation.live = false;
      generation.controller?.abort();
    };
  }, [generation]);
  const [state, setState] = useState<{
    generation: Generation;
    feedback: Feedback;
  }>(() => ({ generation, feedback: empty() }));
  const feedback = state.generation === generation ? state.feedback : empty();
  const active = () =>
    scope.current === generation && generation.live && !generation.revoked;
  const update = (patch: Partial<Feedback>) => {
    if (scope.current === generation && generation.live)
      setState((previous) => ({
        generation,
        feedback: {
          ...(previous.generation === generation ? previous.feedback : empty()),
          ...patch,
        },
      }));
  };
  const keyFor = (id: string | null) => [
    ...importRoot(userId ?? "anonymous"),
    "workflow",
    id,
  ];
  const key = keyFor(sessionId);
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(
      userId &&
      sessionId &&
      !generation.revoked &&
      (!generation.attempt || (!generation.busy && !generation.mustRead)),
    ),
    gcTime: 0,
    staleTime: generation.attempt ? Infinity : 0,
    retry: false,
    networkMode: "always",
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      if (!sessionId) throw new ImportWorkflowResponseError();
      const previousRevision =
        client.getQueryData<ImportSessionViewV1>(key)?.revision;
      const fresh = await getFullImportSession(sessionId, signal);
      signal.throwIfAborted();
      if (
        fresh.id !== generation.sessionId ||
        client.getQueryData<ImportSessionViewV1>(keyFor(generation.sessionId))
          ?.revision !== previousRevision
      )
        throw new ImportWorkflowResponseError();
      return fresh;
    },
  });
  const describe = (error: unknown): DocumentFailure => {
    const context = importConversationFailure(error);
    return {
      privateContextLost: context.privateContextLost,
      message: context.privateContextLost
        ? context.message
        : describeImportFailure(classifyImportFailure(error), "document")
            .message,
    };
  };
  const error =
    feedback.error ?? (query.isError ? describe(query.error) : null);
  if (error?.privateContextLost) {
    generation.revoked = true;
    generation.controller?.abort();
  }
  const view =
    userId && sessionId && !generation.revoked ? (query.data ?? null) : null;
  const fail = (error: unknown) => {
    generation.mustRead = true;
    const failure = describe(error);
    generation.revoked = failure.privateContextLost;
    update({ pending: false, error: failure });
  };
  const publish = (
    fresh: ImportSessionViewV1,
    previousRevision: number | undefined,
  ) => {
    if (
      fresh.id !== generation.sessionId ||
      client.getQueryData<ImportSessionViewV1>(keyFor(generation.sessionId))
        ?.revision !== previousRevision
    )
      throw new ImportWorkflowResponseError();
    client.setQueryData(keyFor(generation.sessionId), fresh);
  };

  async function recover(): Promise<void> {
    if (!active() || generation.busy || !userId) return;
    if (!sessionId && (!generation.attempt || !context)) return;
    const previousRevision =
      client.getQueryData<ImportSessionViewV1>(key)?.revision;
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    update({ pending: true });
    try {
      const fresh = sessionId
        ? await getFullImportSession(sessionId, controller.signal)
        : await context?.recoverList();
      if (!active()) return;
      controller.signal.throwIfAborted();
      if (fresh) publish(fresh, previousRevision);
      generation.mustRead = false;
      update({ pending: false, error: null });
    } catch (error) {
      if (active()) fail(error);
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  const pendingFiles = (current: ImportSessionViewV1) =>
    generation.attempt?.files.some(({ id }) => {
      const attachment = current.attachments.find((a) => a.id === id);
      return !attachment
        ? current.actions.includes("UPLOAD")
        : attachment.state !== "ATTACHED"
          ? current.actions.includes("UPLOAD")
          : attachment.canAnalyze &&
            !attachment.materializedInSession &&
            current.actions.includes("ANALYZE");
    }) ?? false;

  async function runIntake(): Promise<void> {
    const attempt = generation.attempt;
    if (
      !active() ||
      generation.busy ||
      generation.mustRead ||
      !attempt ||
      !context
    )
      return;
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    update({ pending: true, error: null, notice: null });
    try {
      let latest = generation.sessionId
        ? client.getQueryData<ImportSessionViewV1>(keyFor(generation.sessionId))
        : undefined;
      if (!generation.sessionId) {
        const created = await createImportSession(
          attempt.request,
          controller.signal,
        );
        if (!active()) return;
        controller.signal.throwIfAborted();
        // Adoption precedes both publication and the next await: no presentation remount owns this attempt.
        generation.sessionId = created.id;
        generation.adoption = {
          attempt,
          id: created.id,
          key: context.adoptionKey(created.id),
        };
        client.setQueryData(keyFor(created.id), created);
        update({ pending: true });
        context.publishSession(created.id);
        latest = created;
      }
      if (
        !latest ||
        latest.cardId !== attempt.request.cardId ||
        latest.ownerProjectId !== attempt.ownerProjectId
      )
        throw new ImportWorkflowResponseError();
      const coherent = () => {
        if (
          !latest ||
          client.getQueryData<ImportSessionViewV1>(keyFor(generation.sessionId))
            ?.revision !== latest.revision
        )
          throw new ImportWorkflowResponseError();
      };
      const missing = attempt.files.filter(
        ({ id }) => !latest?.attachments.some((a) => a.id === id),
      );
      if (missing.length) {
        if (missing.length !== attempt.files.length)
          throw new ImportWorkflowResponseError();
        coherent();
        const fresh = await reserveImportSessionAttachments(
          latest.id,
          {
            expectedRevision: latest.revision,
            files: attempt.files.map(({ id, file, mime }) => ({
              id,
              fileName: file.name,
              declaredBytes: file.size,
              mime,
            })),
          },
          controller.signal,
        );
        if (!active()) return;
        controller.signal.throwIfAborted();
        publish(fresh, latest.revision);
        latest = fresh;
      }
      let deduplicated = false;
      for (const { id, file } of attempt.files) {
        if (!active()) return;
        const attachment = latest.attachments.find((a) => a.id === id);
        if (attachment?.state === "ATTACHED") continue;
        if (!attachment || !latest.actions.includes("UPLOAD"))
          throw new ImportWorkflowResponseError();
        coherent();
        const upload = await uploadImportSessionAttachment(
          latest.id,
          id,
          file,
          controller.signal,
        );
        if (!active()) return;
        controller.signal.throwIfAborted();
        let fresh: ImportSessionViewV1;
        if ("kind" in upload) {
          deduplicated = true;
          fresh = upload.view;
        } else {
          fresh = upload;
        }
        publish(fresh, latest.revision);
        latest = fresh;
      }
      for (const { id } of attempt.files) {
        if (!active()) return;
        const attachment = latest.attachments.find((a) => a.id === id);
        if (
          !attachment?.canAnalyze ||
          attachment.materializedInSession ||
          !latest.actions.includes("ANALYZE")
        )
          continue;
        coherent();
        const fresh = await analyzeImportAttachment(
          latest.id,
          id,
          { expectedRevision: latest.revision },
          controller.signal,
        );
        if (!active()) return;
        controller.signal.throwIfAborted();
        publish(fresh, latest.revision);
        latest = fresh;
      }
      update({
        pending: false,
        error: null,
        notice: deduplicated
          ? "Este CSV idêntico já está guardado nesta importação; o arquivo repetido foi ignorado."
          : null,
      });
    } catch (error) {
      if (active()) fail(error);
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  async function consent(
    card: ImportEntryCard,
    files: readonly File[],
    formats: readonly EntryFormat[],
  ): Promise<void> {
    if (!active() || generation.busy || generation.attempt) return;
    try {
      if (
        !userId ||
        !context ||
        generation.sessionId ||
        !files.length ||
        files.length > IMPORT_SESSION_LIMITS.filesPerRequest
      )
        throw new ImportWorkflowResponseError();
      const request: ImportSessionCreateRequestV1 = {
        version: 1,
        createRequestId: crypto.randomUUID(),
        cardId: card.id,
        consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
        consentAnalyze: true,
      };
      const selected = files.map((file) => {
        const format = formats.find((f) =>
          file.name.toUpperCase().endsWith(`.${f}`),
        );
        if (
          !format ||
          file.size < 1 ||
          file.size > IMPORT_SESSION_LIMITS.bytesPerFile
        )
          throw new ImportWorkflowResponseError();
        return { id: crypto.randomUUID(), file, mime: DECLARED_MIME[format] };
      });
      generation.attempt = {
        request,
        files: selected,
        ownerProjectId: card.project.id,
      };
      await runIntake();
    } catch (error) {
      if (active()) fail(error);
    }
  }

  /**
   * After reload there is no local File. Only when the SERVER view still allows
   * UPLOAD may the user re-select and re-consent; it reuses the same authorized
   * reserve/upload/analyze steps as the first intake (`runIntake`).
   */
  const canResume =
    Boolean(context) &&
    Boolean(userId && sessionId && view) &&
    !query.isFetching &&
    !error &&
    !generation.attempt &&
    !generation.mustRead &&
    !generation.revoked &&
    Boolean(view?.actions.includes("UPLOAD"));

  async function resume(
    files: readonly File[],
    formats: readonly EntryFormat[],
  ): Promise<void> {
    if (!active() || generation.busy || generation.attempt || !canResume)
      return;
    try {
      const current = client.getQueryData<ImportSessionViewV1>(key);
      if (
        !current ||
        current.revision !== view?.revision ||
        !current.actions.includes("UPLOAD") ||
        !files.length ||
        files.length > IMPORT_SESSION_LIMITS.filesPerRequest
      )
        throw new ImportWorkflowResponseError();
      const used = new Set<string>();
      const selected = files.map((file) => {
        const format = formats.find((f) =>
          file.name.toUpperCase().endsWith(`.${f}`),
        );
        if (
          !format ||
          file.size < 1 ||
          file.size > IMPORT_SESSION_LIMITS.bytesPerFile
        )
          throw new ImportWorkflowResponseError();
        // A reservation left by the interrupted attempt is reused when it is the same file.
        const reserved = current.attachments.find(
          (a) =>
            a.state !== "ATTACHED" &&
            !used.has(a.id) &&
            a.fileName === file.name &&
            a.declaredBytes === file.size,
        );
        if (reserved) used.add(reserved.id);
        return {
          id: reserved?.id ?? crypto.randomUUID(),
          file,
          mime: DECLARED_MIME[format],
        };
      });
      generation.attempt = {
        request: {
          version: 1,
          createRequestId: crypto.randomUUID(),
          cardId: current.cardId,
          consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
          consentAnalyze: true,
        },
        files: selected,
        ownerProjectId: current.ownerProjectId,
      };
      await runIntake();
    } catch (error) {
      if (active()) fail(error);
    }
  }

  async function analyze(attachmentId?: string): Promise<void> {
    if (
      !active() ||
      generation.busy ||
      !userId ||
      !sessionId ||
      generation.mustRead
    )
      return;
    if (
      !view ||
      query.isFetching ||
      error ||
      !view.actions.includes("ANALYZE")
    ) {
      fail(new ImportWorkflowResponseError());
      return;
    }
    const references = view.attachments.filter(
      (a) =>
        a.canAnalyze && (attachmentId === undefined || a.id === attachmentId),
    );
    if (!references.length) {
      fail(new ImportWorkflowResponseError());
      return;
    }
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    update({ pending: true, error: null });
    let latest = view;
    try {
      for (const reference of references) {
        if (!active()) return;
        const attachment = latest.attachments.find(
          (a) => a.id === reference.id,
        );
        if (attachment?.materializedInSession) continue;
        if (
          !attachment?.canAnalyze ||
          !latest.actions.includes("ANALYZE") ||
          client.getQueryData<ImportSessionViewV1>(key)?.revision !==
            latest.revision
        )
          throw new ImportWorkflowResponseError();
        const fresh = await analyzeImportAttachment(
          sessionId,
          reference.id,
          { expectedRevision: latest.revision },
          controller.signal,
        );
        if (!active()) return;
        controller.signal.throwIfAborted();
        publish(fresh, latest.revision);
        latest = fresh;
      }
      update({ pending: false, error: null });
    } catch (error) {
      if (active()) fail(error);
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  return {
    sessionId,
    hasAttempt: generation.attempt !== null,
    canRetry:
      !generation.mustRead &&
      !generation.revoked &&
      Boolean(generation.attempt) &&
      (!sessionId || Boolean(view && pendingFiles(view))),
    view,
    error,
    notice: feedback.notice,
    busy: feedback.pending || query.isFetching,
    analyze,
    recover,
    consent,
    canResume,
    resume,
    retry: runIntake,
    invalidate: () => {
      generation.invalidated = true;
      generation.live = false;
      generation.controller?.abort();
      setState({ generation, feedback: empty() });
    },
  };
}

export type ImportDocumentFlow = ReturnType<typeof useImportDocumentFlow>;
