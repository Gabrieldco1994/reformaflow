"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_LIMITS,
  type ImportSessionCreateRequestV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  analyzeImportAttachment,
  answerImportDocumentaryQuestion,
  createImportSession,
  getFullImportSession,
  reserveImportSessionAttachments,
  uploadImportSessionAttachment,
} from "../_lib/import-session-api";
import { importRoot } from "../_lib/import-session-keys";
import {
  classifyImportFailure,
  describeImportFailure,
  importWorkflowFailure,
  isPdfDocumentErrorCode,
  OCR_LIMIT_EXCEEDED_COPY,
  type ImportWireErrorCode,
} from "../_lib/import-session-errors";
import { ImportWorkflowResponseError } from "../_lib/import-session-workflow-read";
import { useImportUserId } from "./useImportSessions";
import type { ImportEntryCard } from "../_lib/import-session-read";
import type {
  OcrCapabilityV1,
  OcrTerminalUiState,
  OcrUiPresentation,
} from "../_types";
import {
  isSupportedImportFormats,
  type SupportedImportFormat,
} from "../_lib/import-entry-action";
import { IMPORT_FORMAT_MIME } from "../_lib/import-format";

type EntryFormat = SupportedImportFormat;
const terminal = (view: ImportSessionViewV1) =>
  view.state === "APPLIED" ||
  view.state === "CANCELLED" ||
  view.state === "EXPIRED";
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
  supportedFormats?: readonly SupportedImportFormat[];
}

interface DocumentFailure {
  message: string;
  privateContextLost: boolean;
  code?: ImportWireErrorCode | null;
  /** Local routing reference only; never rendered as document context. */
  attachmentId?: string;
  ocrKind: OcrTerminalUiState | "CONSENT_REQUIRED";
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
  documentBlocker: DocumentFailure | null;
  ocrConsentSubmissions: Set<string>;
  externalProcessingAttempts: Set<string>;
  ocrPresentation: OcrUiPresentation | null;
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
  documentBlocker: null,
  ocrConsentSubmissions: new Set(),
  externalProcessingAttempts: new Set(),
  ocrPresentation: null,
});

const ocrCapabilityOf = (value: ImportSessionViewV1): OcrCapabilityV1 | null =>
  value.ocrCapability ?? null;

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
  const adopting = Boolean(
    scope.current.userId === userId &&
    !scope.current.invalidated &&
    echo &&
    echo.attempt === scope.current.attempt &&
    echo.id === requestedSessionId &&
    echo.key === contextKey,
  );
  if (
    scope.current.userId !== userId ||
    (scope.current.sessionId !== requestedSessionId &&
      scope.current.adoption === null) ||
    (scope.current.contextKey !== contextKey && !adopting) ||
    scope.current.invalidated
  ) {
    scope.current.live = false;
    scope.current.controller?.abort();
    scope.current = newGeneration(userId, requestedSessionId, contextKey);
  }
  const generation = scope.current;
  const sessionId = generation.sessionId;
  const generationBusy = generation.busy;
  useEffect(() => {
    // Keep the token while its controller owns I/O; consume only after an exact
    // target render commits and the documentary attempt has settled.
    if (adopting && scope.current === generation && !generationBusy) {
      generation.contextKey = contextKey;
      generation.adoption = null;
    }
  }, [adopting, contextKey, generation, generationBusy]);
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
      const fresh = await getFullImportSession(
        sessionId,
        signal,
        "WORKFLOW_VIEW",
      );
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
  const ocrFailureKind = (
    failure: ReturnType<typeof classifyImportFailure>,
    attempted: boolean,
  ): DocumentFailure["ocrKind"] => {
    if (failure.kind === "api") {
      switch (failure.error.code) {
        case "OCR_REQUIRED":
          return attempted ? "OCR_ATTEMPT_UNKNOWN" : "CONSENT_REQUIRED";
        case "OCR_UNAVAILABLE":
        case "CAPABILITY_DISABLED":
          return "OCR_UNAVAILABLE";
        case "OCR_SAFETY_BLOCKED":
          return "OCR_SAFETY_BLOCKED";
        case "OCR_MALFORMED_RESPONSE":
          return "OCR_MALFORMED_RESPONSE";
        case "OCR_ATTEMPT_UNKNOWN":
          return "OCR_ATTEMPT_UNKNOWN";
        case "OCR_BUDGET_EXHAUSTED":
          return "OCR_BUDGET_EXHAUSTED";
        case "LIMIT_EXCEEDED":
          return attempted ? "LIMIT_EXCEEDED" : "OCR_UNAVAILABLE";
        case "DOCUMENT_UNREADABLE":
          return "DOCUMENT_UNREADABLE";
        case "PDF_PASSWORD_REQUIRED":
          return "PDF_PASSWORD_REQUIRED";
        case "UNSUPPORTED_DOCUMENT":
          return "UNSUPPORTED_DOCUMENT";
        default:
          return attempted ? "OCR_ATTEMPT_UNKNOWN" : "OCR_UNAVAILABLE";
      }
    }
    return attempted ? "OCR_ATTEMPT_UNKNOWN" : "OCR_UNAVAILABLE";
  };
  const describe = (error: unknown): DocumentFailure => {
    const context = importWorkflowFailure(error);
    const classified = classifyImportFailure(error);
    const info = describeImportFailure(classified, "document");
    return {
      privateContextLost: context.privateContextLost,
      code: info.code,
      message: context.privateContextLost ? context.message : info.message,
      ocrKind: ocrFailureKind(classified, false),
    };
  };
  const error =
    feedback.error ??
    generation.documentBlocker ??
    (query.isError ? describe(query.error) : null);
  if (error?.privateContextLost) {
    generation.revoked = true;
    generation.controller?.abort();
  }
  const view =
    userId && sessionId && !generation.revoked ? (query.data ?? null) : null;
  const fail = (error: unknown, attachmentId?: string) => {
    generation.mustRead = true;
    const attempted = Boolean(
      attachmentId && generation.externalProcessingAttempts.has(attachmentId),
    );
    const classified = classifyImportFailure(error);
    const described = describe(error);
    const cachedView = client.getQueryData<ImportSessionViewV1>(key);
    const cachedCapability = cachedView ? ocrCapabilityOf(cachedView) : null;
    const capabilityAttachment =
      cachedCapability?.status === "AVAILABLE"
        ? cachedCapability.attachments.find(
            (candidate) => candidate.attachmentId === attachmentId,
          )
        : null;
    const failure = {
      ...described,
      message:
        described.code === "LIMIT_EXCEEDED" && attempted
          ? OCR_LIMIT_EXCEEDED_COPY
          : described.message,
      attachmentId,
      ocrKind:
        described.code === "OCR_REQUIRED" && !capabilityAttachment
          ? ("OCR_UNAVAILABLE" as const)
          : ocrFailureKind(classified, attempted),
    };
    const terminalDocumentFailure =
      isPdfDocumentErrorCode(failure.code) ||
      (failure.code === "LIMIT_EXCEEDED" && attempted);
    const terminalOcrPresentation = terminalDocumentFailure || attempted;
    if (terminalDocumentFailure) generation.documentBlocker = failure;
    const attachment = attachmentId
      ? cachedView?.attachments.find(
          (candidate) => candidate.id === attachmentId,
        )
      : null;
    if (
      terminalOcrPresentation &&
      attachment?.fileName.toLocaleLowerCase("en-US").endsWith(".pdf")
    )
      generation.ocrPresentation = {
        attachmentId: attachment.id,
        kind: failure.ocrKind,
      };
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
        ? await getFullImportSession(
            sessionId,
            controller.signal,
            "WORKFLOW_VIEW",
          )
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
      generation.documentBlocker ||
      !context
    )
      return;
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    update({ pending: true, error: null, notice: null });
    let activeAttachmentId: string | undefined;
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
        terminal(latest) ||
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
        activeAttachmentId = id;
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
          ? "Este arquivo idêntico já está guardado nesta importação; o arquivo repetido foi ignorado."
          : null,
      });
    } catch (error) {
      if (active()) fail(error, activeAttachmentId);
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
        files.length > IMPORT_SESSION_LIMITS.filesPerRequest ||
        !isSupportedImportFormats([...formats]) ||
        (context.supportedFormats &&
          formats.some((format) => !context.supportedFormats?.includes(format)))
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
        return {
          id: crypto.randomUUID(),
          file,
          mime: IMPORT_FORMAT_MIME[format],
        };
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
    !generation.documentBlocker &&
    Boolean(view && !terminal(view)) &&
    (context?.supportedFormats?.length ?? 1) > 0 &&
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
        terminal(current) ||
        current.revision !== view?.revision ||
        !current.actions.includes("UPLOAD") ||
        !files.length ||
        files.length > IMPORT_SESSION_LIMITS.filesPerRequest ||
        !isSupportedImportFormats([...formats]) ||
        (context?.supportedFormats &&
          formats.some((format) => !context.supportedFormats?.includes(format)))
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
          mime: IMPORT_FORMAT_MIME[format],
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
      generation.documentBlocker ||
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
    let activeAttachmentId: string | undefined;
    try {
      for (const reference of references) {
        if (!active()) return;
        activeAttachmentId = reference.id;
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
      if (active()) fail(error, activeAttachmentId);
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  async function consentExternalProcessing(
    attachmentId: string,
  ): Promise<void> {
    if (
      !active() ||
      generation.busy ||
      !userId ||
      !sessionId ||
      generation.ocrConsentSubmissions.has(attachmentId) ||
      generation.externalProcessingAttempts.has(attachmentId)
    )
      return;
    const latest = client.getQueryData<ImportSessionViewV1>(key);
    const attachment = latest?.attachments.find(
      (candidate) => candidate.id === attachmentId,
    );
    const capability = latest ? ocrCapabilityOf(latest) : null;
    const capabilityAttachment =
      capability?.status === "AVAILABLE"
        ? capability.attachments.find(
            (candidate) => candidate.attachmentId === attachmentId,
          )
        : null;
    if (
      !latest ||
      terminal(latest) ||
      !latest.actions.includes("ANALYZE") ||
      !attachment?.canAnalyze ||
      attachment.materializedInSession ||
      !capabilityAttachment
    )
      return;

    generation.ocrConsentSubmissions.add(attachmentId);
    generation.busy = true;
    const controller = new AbortController();
    generation.controller = controller;
    update({ pending: true, error: null });
    try {
      if (
        capabilityAttachment.consentedRequestId !== null &&
        capabilityAttachment.consentedRevision !== null
      ) {
        if (capabilityAttachment.consentedRevision !== latest.revision)
          throw new ImportWorkflowResponseError();
        generation.externalProcessingAttempts.add(attachmentId);
        const fresh = await analyzeImportAttachment(
          sessionId,
          attachmentId,
          {
            version: 2,
            expectedRevision: capabilityAttachment.consentedRevision,
            requestId: capabilityAttachment.consentedRequestId,
            consentExternalProcessing: true,
          },
          controller.signal,
        );
        if (!active()) return;
        controller.signal.throwIfAborted();
        publish(fresh, latest.revision);
        generation.ocrPresentation = null;
        generation.mustRead = false;
        update({ pending: false, error: null });
        return;
      }
      const requestId = crypto.randomUUID();
      const answerRequestId = crypto.randomUUID();
      const consented = await answerImportDocumentaryQuestion(
        sessionId,
        {
          version: 1,
          answerRequestId,
          expectedRevision: latest.revision,
          questionId: capabilityAttachment.questionId,
          channel: "TEXT",
          input: { kind: "VALUE", text: "ALLOW_EXTERNAL_PROCESSING" },
          answer: {
            field: "externalOcrConsent",
            value: "ALLOW_EXTERNAL_PROCESSING",
            attachmentId,
            requestId,
            consentPolicyVersion: 1,
            provider: "GOOGLE_VERTEX_AI",
            purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW",
            region: "southamerica-east1",
            retentionDays: 7,
            sendsFullOriginal: true,
            includesMetadataAndEmbeddedContent: true,
            includesPotentiallyNonVisibleContent: true,
          },
        },
        controller.signal,
      );
      if (!active()) return;
      controller.signal.throwIfAborted();
      const consentedCapability = ocrCapabilityOf(consented);
      const persisted = consentedCapability?.attachments.find(
        (candidate) => candidate.attachmentId === attachmentId,
      );
      if (
        consentedCapability?.status !== "AVAILABLE" ||
        persisted?.consentedRequestId !== requestId ||
        persisted.consentedRevision !== consented.revision
      )
        throw new ImportWorkflowResponseError();
      publish(consented, latest.revision);

      // Only the provider call closes this one-shot lock. Persisting consent is
      // a separate documentary write and is never treated as provider success.
      generation.externalProcessingAttempts.add(attachmentId);
      const fresh = await analyzeImportAttachment(
        sessionId,
        attachmentId,
        {
          version: 2,
          expectedRevision: consented.revision,
          requestId,
          consentExternalProcessing: true,
        },
        controller.signal,
      );
      if (!active()) return;
      controller.signal.throwIfAborted();
      publish(fresh, consented.revision);
      if (generation.documentBlocker?.attachmentId === attachmentId)
        generation.documentBlocker = null;
      generation.ocrPresentation = null;
      generation.mustRead = false;
      update({ pending: false, error: null });
    } catch (error) {
      if (active()) fail(error, attachmentId);
    } finally {
      generation.busy = false;
      if (generation.controller === controller) generation.controller = null;
    }
  }

  const projectedCapability = view ? ocrCapabilityOf(view) : null;
  const projectedTerminalPresentations =
    projectedCapability?.terminalOutcomes?.map(
      (outcome): OcrUiPresentation => ({
        attachmentId: outcome.attachmentId,
        kind: outcome.code,
      }),
    ) ?? [];
  const projectedTerminalIds = new Set(
    projectedTerminalPresentations.map(
      (presentation) => presentation.attachmentId,
    ),
  );
  const listedCapability = view
    ? projectedCapability?.attachments.find(
        (candidate) =>
          !projectedTerminalIds.has(candidate.attachmentId) &&
          view.attachments.some(
            (attachment) =>
              attachment.id === candidate.attachmentId &&
              attachment.canAnalyze &&
              !attachment.materializedInSession,
          ),
      )
    : null;
  const localOcrPresentation =
    generation.ocrPresentation &&
    !projectedTerminalIds.has(generation.ocrPresentation.attachmentId)
      ? generation.ocrPresentation
      : null;
  const baseOcrPresentation =
    localOcrPresentation ??
    (listedCapability && view
      ? ({
          attachmentId: listedCapability.attachmentId,
          kind:
            projectedCapability?.status === "AVAILABLE"
              ? listedCapability.consentedRequestId === null
                ? "CONSENT_REQUIRED"
                : "CONSENTED_READY"
              : "OCR_UNAVAILABLE",
        } as const)
      : null);
  const actionableOcrPresentation = baseOcrPresentation
    ? {
        ...baseOcrPresentation,
        kind:
          feedback.pending &&
          generation.ocrConsentSubmissions.has(baseOcrPresentation.attachmentId)
            ? ("REQUESTING" as const)
            : (baseOcrPresentation.kind === "CONSENT_REQUIRED" ||
                  baseOcrPresentation.kind === "CONSENTED_READY") &&
                (!view ||
                  projectedCapability?.status !== "AVAILABLE" ||
                  !projectedCapability.attachments.some(
                    (candidate) =>
                      candidate.attachmentId ===
                        baseOcrPresentation.attachmentId &&
                      (baseOcrPresentation.kind === "CONSENT_REQUIRED"
                        ? candidate.consentedRequestId === null &&
                          candidate.consentedRevision === null
                        : candidate.consentedRequestId !== null &&
                          candidate.consentedRevision !== null),
                  ))
              ? ("OCR_UNAVAILABLE" as const)
              : baseOcrPresentation.kind,
      }
    : null;
  const ocrUiStates = [
    ...projectedTerminalPresentations,
    ...(actionableOcrPresentation ? [actionableOcrPresentation] : []),
  ];
  const ocrUiState = ocrUiStates[0] ?? null;
  const ocrRequiredAttachmentId =
    ocrUiState?.kind === "CONSENT_REQUIRED" ? ocrUiState.attachmentId : null;

  return {
    sessionId,
    hasAttempt: generation.attempt !== null,
    supportedFormats: context?.supportedFormats ?? (["CSV"] as const),
    canRetry:
      !generation.mustRead &&
      !generation.revoked &&
      !generation.documentBlocker &&
      Boolean(generation.attempt) &&
      (!sessionId || Boolean(view && !terminal(view) && pendingFiles(view))),
    view,
    error,
    notice: feedback.notice,
    busy: feedback.pending || query.isFetching,
    analyze,
    consentExternalProcessing,
    ocrRequiredAttachmentId,
    ocrUiState,
    ocrUiStates,
    ocrConsentAttempted: Boolean(
      baseOcrPresentation &&
      generation.externalProcessingAttempts.has(
        baseOcrPresentation.attachmentId,
      ),
    ),
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
