import { api } from "@/lib/api";
import type {
  ImportDeclarationAnswerV1,
  ImportDeclarationUiInputV1,
  ImportChatChannel,
  ImportSessionDocumentaryAnswerRequestV1,
  ImportSessionCandidateV1,
  ImportSessionChallengeRequestV1,
  ImportSessionConfirmRequestV1,
  ImportSessionCreateRequestV1,
  ImportSessionEditRequestV1,
  ImportSessionExecuteRequestV1,
  ImportSessionFocusedDraftAnswerRequestV1,
  ImportSessionPageV1,
  ImportSessionReserveRequestV1,
  ImportSessionRevisionRequestV1,
  ImportSessionSummaryV1,
  ImportSessionUploadResponseV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  readImportCandidatePage,
  readImportChallenge,
  readImportConfirmation,
  readImportObservationPage,
  readImportWorkflowReceipt,
  readImportWorkflowView,
  type ImportObservationView,
} from "./import-session-workflow-read";
import type { ImportListScope } from "./import-session-keys";
import type { FocusedDraftAnswer } from "./import-focused-draft-types";
import {
  isResultRead,
  isRecord,
  isSummaryPage,
  isViewRead,
  isImportEntryCards,
  readImportEntry,
  type ImportEntryCard,
  type ImportListRead,
  type ImportResultRead,
  type ImportViewRead,
} from "./import-session-read";

/** Authenticated UI transport; the server owns availability and actions. */
const UI_HEADERS = { "x-rf-import-ui": "1" } as const;

export class ImportMalformedResponseError extends Error {
  constructor() {
    super("Unexpected import session response");
    this.name = "ImportMalformedResponseError";
  }
}

function malformed(): never {
  throw new ImportMalformedResponseError();
}

const enc = encodeURIComponent;

/** The documentary variant carries the exact local preview accepted by the human. */
export type ImportQuestionAnswerInput =
  | { id: string; text: string }
  | { id: string; text: string; draftAnswer: FocusedDraftAnswer }
  | {
      id: string;
      text: string;
      input: ImportDeclarationUiInputV1;
      answer: ImportDeclarationAnswerV1;
    };

export async function answerImportFocusedDraftQuestion(
  id: string,
  request: ImportSessionFocusedDraftAnswerRequestV1,
  signal?: AbortSignal,
): Promise<ImportSessionViewV1> {
  const view = readImportWorkflowView(
    await api.patch<unknown>(`/import-sessions/${enc(id)}/draft`, request, {
      headers: { ...UI_HEADERS },
      signal,
    }),
  );
  return view.id === id ? view : malformed();
}

export async function answerImportDocumentaryQuestion(
  id: string,
  request: ImportSessionDocumentaryAnswerRequestV1 & {
    channel: ImportChatChannel;
  },
  signal?: AbortSignal,
): Promise<ImportSessionViewV1> {
  const view = readImportWorkflowView(
    await api.post<unknown>(
      `/import-sessions/${enc(id)}/documentary-answer`,
      request,
      { headers: { ...UI_HEADERS }, signal },
    ),
  );
  return view.id === id ? view : malformed();
}

export async function createImportSession(
  request: ImportSessionCreateRequestV1,
  signal?: AbortSignal,
): Promise<ImportSessionViewV1> {
  const view = readImportWorkflowView(
    await api.post<unknown>("/import-sessions", request, {
      headers: { ...UI_HEADERS },
      signal,
    }),
  );
  return view.cardId === request.cardId ? view : malformed();
}

export async function reserveImportSessionAttachments(
  id: string,
  request: ImportSessionReserveRequestV1,
  signal?: AbortSignal,
): Promise<ImportSessionViewV1> {
  const view = readImportWorkflowView(
    await api.post<unknown>(
      `/import-sessions/${enc(id)}/attachments`,
      request,
      {
        headers: { ...UI_HEADERS },
        signal,
      },
    ),
  );
  return view.id === id ? view : malformed();
}

export async function uploadImportSessionAttachment(
  id: string,
  attachmentId: string,
  body: Blob,
  signal?: AbortSignal,
): Promise<ImportSessionUploadResponseV1> {
  const response = await api.putBytes<unknown>(
    `/import-sessions/${enc(id)}/attachments/${enc(attachmentId)}/content`,
    body,
    { headers: { ...UI_HEADERS }, signal },
  );
  if (
    isRecord(response) &&
    Object.keys(response).length === 3 &&
    Object.hasOwn(response, "kind") &&
    Object.hasOwn(response, "attachmentId") &&
    Object.hasOwn(response, "view")
  ) {
    if (
      response.kind !== "DEDUPLICATED" ||
      response.attachmentId !== attachmentId
    )
      return malformed();
    const view = readImportWorkflowView(response.view);
    return view.id === id &&
      view.attachments.some(
        (attachment) =>
          attachment.id !== attachmentId && attachment.state === "ATTACHED",
      )
      ? { kind: "DEDUPLICATED", attachmentId, view }
      : malformed();
  }
  const view = readImportWorkflowView(response);
  return view.id === id &&
    view.attachments.some(
      (attachment) =>
        attachment.id === attachmentId && attachment.state === "ATTACHED",
    )
    ? view
    : malformed();
}

export async function analyzeImportAttachment(
  sessionId: string,
  attachmentId: string,
  request: ImportSessionRevisionRequestV1,
  signal?: AbortSignal,
): Promise<ImportSessionViewV1> {
  const view = readImportWorkflowView(
    await api.post<unknown>(
      `/import-sessions/${enc(sessionId)}/attachments/${enc(attachmentId)}/analyze`,
      request,
      { headers: { ...UI_HEADERS }, signal },
    ),
  );
  return view.id === sessionId &&
    view.attachments.some(
      (attachment) =>
        attachment.id === attachmentId && attachment.materializedInSession,
    )
    ? view
    : malformed();
}

export async function listImportSessions(
  scope: ImportListScope,
  cursor?: string | null,
): Promise<ImportListRead> {
  const page = await api.get<unknown>(
    `/import-sessions?state=${scope}${cursor ? `&cursor=${enc(cursor)}` : ""}`,
  );
  if (!isSummaryPage(page) || !isRecord(page)) return malformed();
  return {
    page: { items: page.items, nextCursor: page.nextCursor },
    entry: readImportEntry(page),
  };
}

export async function listImportEntryCards(
  signal?: AbortSignal,
): Promise<ImportEntryCard[]> {
  const cards = await api.get<unknown>("/tenant/credit-cards", { signal });
  return isImportEntryCards(cards) ? cards : malformed();
}

export async function getImportSession(id: string): Promise<ImportViewRead> {
  const view = await api.get<unknown>(`/import-sessions/${enc(id)}`);
  return isViewRead(view) ? view : malformed();
}

export async function getImportResult(
  id: string,
  signal?: AbortSignal,
): Promise<ImportResultRead> {
  const path = `/import-sessions/${enc(id)}/result`;
  const result = signal
    ? await api.get<unknown>(path, { signal })
    : await api.get<unknown>(path);
  return isResultRead(result) ? result : malformed();
}

export async function cancelImportSession(
  id: string,
  expectedRevision: number,
): Promise<ImportViewRead> {
  const view = await api.post<unknown>(
    `/import-sessions/${enc(id)}/cancel`,
    { expectedRevision },
    { headers: { ...UI_HEADERS } },
  );
  return isViewRead(view) ? view : malformed();
}

export async function getFullImportSession(id: string, signal?: AbortSignal) {
  const path = `/import-sessions/${enc(id)}`;
  return readImportWorkflowView(
    signal
      ? await api.get<unknown>(path, { signal })
      : await api.get<unknown>(path),
  );
}

export async function editImportSession(
  id: string,
  request: ImportSessionEditRequestV1,
) {
  const view = readImportWorkflowView(
    await api.patch<unknown>(`/import-sessions/${enc(id)}/draft`, request, {
      headers: { ...UI_HEADERS },
    }),
  );
  return view.id === id ? view : malformed();
}

export async function prepareImportSession(
  id: string,
  request: ImportSessionRevisionRequestV1,
  signal?: AbortSignal,
) {
  const view = readImportWorkflowView(
    await api.post<unknown>(`/import-sessions/${enc(id)}/prepare`, request, {
      headers: { ...UI_HEADERS },
      signal,
    }),
  );
  return view.id === id ? view : malformed();
}

export async function getImportObservations(
  id: string,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<ImportSessionPageV1<ImportObservationView>> {
  return readImportObservationPage(
    await api.get<unknown>(
      `/import-sessions/${enc(id)}/observations${cursor == null ? "" : `?cursor=${enc(cursor)}`}`,
      { signal },
    ),
  );
}

export async function getImportCandidates(
  id: string,
  lineId: string,
  cursor?: string | null,
): Promise<ImportSessionPageV1<ImportSessionCandidateV1>> {
  return readImportCandidatePage(
    await api.get<unknown>(
      `/import-sessions/${enc(id)}/candidates?lineId=${enc(lineId)}${cursor == null ? "" : `&cursor=${enc(cursor)}`}`,
    ),
    lineId,
  );
}

export async function challengeImportSession(
  id: string,
  request: ImportSessionChallengeRequestV1,
) {
  return readImportChallenge(
    await api.post<unknown>(
      `/import-sessions/${enc(id)}/confirmation-challenge`,
      request,
      { headers: { ...UI_HEADERS } },
    ),
  );
}

export async function confirmImportSession(
  id: string,
  request: ImportSessionConfirmRequestV1,
) {
  return readImportConfirmation(
    await api.post<unknown>(`/import-sessions/${enc(id)}/confirm`, request, {
      headers: { ...UI_HEADERS },
    }),
  );
}

export async function executeImportSession(
  id: string,
  request: ImportSessionExecuteRequestV1,
  ownerProjectId: string,
) {
  return readImportWorkflowReceipt(
    await api.post<unknown>(`/import-sessions/${enc(id)}/execute`, request, {
      headers: { ...UI_HEADERS },
    }),
    ownerProjectId,
  );
}
