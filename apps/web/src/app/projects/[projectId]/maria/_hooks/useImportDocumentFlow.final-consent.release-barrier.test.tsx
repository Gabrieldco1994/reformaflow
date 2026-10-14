import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { ApiResponseError } from "@/lib/api";
import { useImportDocumentFlow } from "./useImportDocumentFlow";

const api = vi.hoisted(() => ({
  answerImportDocumentaryQuestion: vi.fn(),
  getFullImportSession: vi.fn(),
  reserveImportSessionAttachments: vi.fn(),
  uploadImportSessionAttachment: vi.fn(),
  analyzeImportAttachment: vi.fn(),
  createImportSession: vi.fn(),
}));
vi.mock("../_lib/import-session-api", () => api);
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "user-final-719" } }),
}));

const capability = (
  consentedRequestId: string | null = null,
  consentedRevision: number | null = null,
) => ({
  status: "AVAILABLE",
  consentPolicyVersion: 1,
  provider: "GOOGLE_VERTEX_AI",
  purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW",
  region: "southamerica-east1",
  retentionDays: 7,
  sendsFullOriginal: true,
  includesMetadataAndEmbeddedContent: true,
  includesPotentiallyNonVisibleContent: true,
  attachments: [
    {
      attachmentId: "attachment-final-719",
      questionId: `ocrq_${"a".repeat(64)}`,
      consentedRequestId,
      consentedRevision,
    },
  ],
  terminalOutcomes: [],
});

const view = (
  revision: number,
  ocrCapability: ReturnType<typeof capability>,
  materializedInSession = false,
): ImportSessionViewV1 =>
  ({
    version: 1,
    analysisOutcome: null,
    id: "session-final-719",
    ownerProjectId: "project-final-719",
    cardId: "card-final-719",
    state: "DRAFT",
    revision,
    expiresAt: "2026-10-20T20:00:00.000Z",
    attachments: [
      {
        id: "attachment-final-719",
        fileName: "fatura-digitalizada.pdf",
        declaredBytes: 1_024,
        state: "ATTACHED",
        canAnalyze: !materializedInSession,
        materializedInSession,
      },
    ],
    lines: [],
    selectedLineIds: [],
    questions: [],
    declaredFacts: [],
    reviewBlockers: [],
    ocrCapability,
    searchComplete: false,
    proposal: null,
    confirmation: null,
    receipt: null,
    actions: materializedInSession
      ? ["RESOLVE", "CANCEL"]
      : ["ANALYZE", "CANCEL"],
  }) as ImportSessionViewV1;

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useImportDocumentFlow("session-final-719", {
        key: "private-context-final-719",
        adoptionKey: (id) => id,
        publishSession: vi.fn(),
        recoverList: vi.fn(),
        supportedFormats: ["CSV", "PDF"],
      }),
    { wrapper },
  );
}

describe("final #719 browser consent dispatch", () => {
  beforeEach(() => {
    Object.values(api).forEach((mock) => mock.mockReset());
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends the complete exact declaration before the one-shot analyze request", async () => {
    const requestId = "10000000-0000-4000-8000-000000000001";
    const answerRequestId = "20000000-0000-4000-8000-000000000002";
    const attached = view(1, capability());
    const consented = view(2, capability(requestId, 2));
    const materialized = view(3, { ...capability(), attachments: [] }, true);
    api.getFullImportSession.mockResolvedValue(attached);
    api.answerImportDocumentaryQuestion.mockResolvedValue(consented);
    api.analyzeImportAttachment
      .mockRejectedValueOnce(
        new ApiResponseError("OCR", 422, {
          code: "OCR_REQUIRED",
          retryable: false,
          sessionId: attached.id,
          currentRevision: 1,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(materialized);
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(requestId)
      .mockReturnValueOnce(answerRequestId);
    const { result } = setup();
    await waitFor(() => expect(result.current.view).not.toBeNull());

    await act(async () => {
      await result.current.analyze("attachment-final-719");
    });
    expect(result.current.ocrUiState).toEqual({
      attachmentId: "attachment-final-719",
      kind: "CONSENT_REQUIRED",
    });

    await act(async () => {
      await result.current.consentExternalProcessing("attachment-final-719");
    });

    expect(api.answerImportDocumentaryQuestion).toHaveBeenCalledTimes(1);
    const [, consentBody] = api.answerImportDocumentaryQuestion.mock.calls[0]!;
    expect(consentBody.answer).toEqual({
      field: "externalOcrConsent",
      value: "ALLOW_EXTERNAL_PROCESSING",
      attachmentId: "attachment-final-719",
      requestId,
      consentPolicyVersion: 1,
      provider: "GOOGLE_VERTEX_AI",
      purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW",
      region: "southamerica-east1",
      retentionDays: 7,
      sendsFullOriginal: true,
      includesMetadataAndEmbeddedContent: true,
      includesPotentiallyNonVisibleContent: true,
    });
    expect(Object.keys(consentBody.answer).sort()).toEqual([
      "attachmentId",
      "consentPolicyVersion",
      "field",
      "includesMetadataAndEmbeddedContent",
      "includesPotentiallyNonVisibleContent",
      "provider",
      "purpose",
      "region",
      "requestId",
      "retentionDays",
      "sendsFullOriginal",
      "value",
    ]);
    expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(2);
    expect(api.analyzeImportAttachment.mock.calls[1]!.slice(0, 3)).toEqual([
      "session-final-719",
      "attachment-final-719",
      {
        version: 2,
        expectedRevision: 2,
        requestId,
        consentExternalProcessing: true,
      },
    ]);
  });
});
