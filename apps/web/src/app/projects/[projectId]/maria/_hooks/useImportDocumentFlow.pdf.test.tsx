import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { ApiResponseError, ApiTimeoutError } from "@/lib/api";
import { useImportDocumentFlow } from "./useImportDocumentFlow";
import { importRoot } from "../_lib/import-session-keys";

const api = vi.hoisted(() => ({
  getFullImportSession: vi.fn(),
  reserveImportSessionAttachments: vi.fn(),
  uploadImportSessionAttachment: vi.fn(),
  analyzeImportAttachment: vi.fn(),
  createImportSession: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
}));
vi.mock("../_lib/import-session-api", () => api);
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: auth.user }),
}));

const view = (
  over: Partial<ImportSessionViewV1> = {},
): ImportSessionViewV1 => ({
  id: "s1",
  ownerProjectId: "p1",
  cardId: "c1",
  state: "DRAFT",
  revision: 1,
  expiresAt: null,
  attachments: [],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  version: 1,
  lines: [],
  selectedLineIds: [],
  actions: ["UPLOAD", "CANCEL"],
  ...over,
});
const pdf = () => new File(["%PDF-text"], "fatura.pdf", { type: "" });
function setup(sessionId: string | null = "s1") {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const context = {
    key: "k",
    adoptionKey: (id: string) => id,
    publishSession: vi.fn(),
    recoverList: vi.fn(),
    supportedFormats: ["CSV", "PDF"] as const,
  };
  return {
    client,
    ...renderHook(() => useImportDocumentFlow(sessionId, context), { wrapper }),
  };
}

describe("textual PDF documentary coordinator", () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    auth.user = { id: "user-1" };
  });
  afterEach(() => vi.restoreAllMocks());

  it("reserves PDF MIME independently of the browser-declared MIME", async () => {
    api.getFullImportSession.mockResolvedValue(view());
    api.reserveImportSessionAttachments.mockImplementation(
      async (
        _id,
        request: {
          files: Array<{ id: string; fileName: string; declaredBytes: number }>;
        },
      ) =>
        view({
          revision: 2,
          attachments: request.files.map((file) => ({
            id: file.id,
            fileName: file.fileName,
            declaredBytes: file.declaredBytes,
            state: "RESERVED",
            canAnalyze: false,
            materializedInSession: false,
          })),
        }),
    );
    api.uploadImportSessionAttachment.mockImplementation(
      async (_id, id: string) =>
        view({
          revision: 3,
          actions: ["CANCEL"],
          attachments: [
            {
              id,
              fileName: "fatura.pdf",
              declaredBytes: 9,
              state: "ATTACHED",
              canAnalyze: false,
              materializedInSession: false,
            },
          ],
        }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.canResume).toBe(true));
    expect(api.reserveImportSessionAttachments).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.resume([pdf()], ["CSV", "PDF"]);
    });
    expect(
      api.reserveImportSessionAttachments.mock.calls[0][1].files[0].mime,
    ).toBe("application/pdf");
    expect(api.createImportSession).not.toHaveBeenCalled();
  });

  it.each(["APPLIED", "CANCELLED", "EXPIRED"] as const)(
    "never offers upload after terminal reload %s, even with a contradictory action",
    async (state) => {
      api.getFullImportSession.mockResolvedValue(view({ state }));
      const { result } = setup();
      await waitFor(() => expect(result.current.view).not.toBeNull());
      expect(result.current.canResume).toBe(false);
      await act(async () => {
        await result.current.resume([pdf()], ["PDF"]);
      });
      expect(api.reserveImportSessionAttachments).not.toHaveBeenCalled();
    },
  );

  it("retains OCR blocker after a state read and clears it on account change", async () => {
    api.getFullImportSession.mockResolvedValue(
      view({
        actions: ["ANALYZE", "CANCEL"],
        attachments: [
          {
            id: "a1",
            fileName: "scan.pdf",
            declaredBytes: 9,
            state: "ATTACHED",
            canAnalyze: true,
            materializedInSession: false,
          },
        ],
      }),
    );
    api.analyzeImportAttachment.mockRejectedValue(
      new ApiResponseError("OCR", 422, {
        code: "OCR_REQUIRED",
        retryable: false,
        sessionId: "s1",
        currentRevision: 1,
        reason: null,
      }),
    );
    const { result, rerender, client } = setup();
    await waitFor(() => expect(result.current.view).not.toBeNull());
    await act(async () => {
      await result.current.analyze("a1");
    });
    expect(result.current.error?.code).toBe("OCR_REQUIRED");
    expect(result.current.error?.attachmentId).toBe("a1");
    expect(result.current.ocrUiState).toEqual({
      attachmentId: "a1",
      kind: "CONSENT_REQUIRED",
    });
    await act(async () => {
      await result.current.recover();
    });
    expect(result.current.error?.code).toBe("OCR_REQUIRED");
    expect(result.current.canRetry).toBe(false);
    await act(async () => {
      await result.current.analyze("a1");
    });
    expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(1);
    auth.user = null;
    rerender();
    expect(result.current.error).toBeNull();
    expect(result.current.view).toBeNull();
    expect(result.current.hasAttempt).toBe(false);
    expect(
      client.getQueryCache().findAll({ queryKey: importRoot("user-1") }),
    ).toHaveLength(0);
  });

  it("calls the same analyze endpoint once with the exact v2 consent body and adopts unselected pending review", async () => {
    const attached = view({
      actions: ["ANALYZE", "CANCEL"],
      attachments: [
        {
          id: "a1",
          fileName: "scan.pdf",
          declaredBytes: 9,
          state: "ATTACHED",
          canAnalyze: true,
          materializedInSession: false,
        },
      ],
    });
    const materialized = view({
      revision: 2,
      actions: ["RESOLVE", "CANCEL"],
      attachments: [
        {
          ...attached.attachments[0],
          canAnalyze: false,
          materializedInSession: true,
        },
      ],
      selectedLineIds: [],
      lines: [
        {
          id: "ocr-line",
          observationIds: ["ocr-observation"],
          titulo: "MERCADO OCR",
          fornecedor: null,
          tipoDespesa: null,
          categoriaMaoDeObra: null,
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 12_345,
          installmentCount: 1,
          dataCompra: "2026-10-10",
          firstDueDate: null,
          targets: [],
          decision: { kind: "UNRESOLVED" },
        },
      ],
      reviewBlockers: [
        {
          lineId: "ocr-line",
          code: "ORIGINAL_IDENTITY_INCOMPLETE",
          resolution: "NEEDS_DECLARATION",
        },
      ],
    });
    api.getFullImportSession.mockResolvedValue(attached);
    api.analyzeImportAttachment
      .mockRejectedValueOnce(
        new ApiResponseError("OCR", 422, {
          code: "OCR_REQUIRED",
          retryable: false,
          sessionId: "s1",
          currentRevision: 1,
          reason: null,
        }),
      )
      .mockResolvedValueOnce(materialized);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "12345678-1234-4123-8123-123456789abc",
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.view).not.toBeNull());

    await act(async () => {
      await result.current.analyze("a1");
    });
    expect(result.current.error?.code).toBe("OCR_REQUIRED");

    await act(async () => {
      await result.current.consentExternalProcessing("a1");
    });

    expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(2);
    expect(api.analyzeImportAttachment.mock.calls[1].slice(0, 3)).toEqual([
      "s1",
      "a1",
      {
        version: 2,
        expectedRevision: 1,
        requestId: "12345678-1234-4123-8123-123456789abc",
        consentExternalProcessing: true,
      },
    ]);
    expect(
      Object.keys(api.analyzeImportAttachment.mock.calls[1][2]).sort(),
    ).toEqual([
      "consentExternalProcessing",
      "expectedRevision",
      "requestId",
      "version",
    ]);
    expect(result.current.view?.selectedLineIds).toEqual([]);
    expect(result.current.view?.reviewBlockers).toEqual([
      expect.objectContaining({ resolution: "NEEDS_DECLARATION" }),
    ]);
    expect(result.current.view?.actions).not.toContain("PREPARE");
    expect(result.current.ocrCandidateEvidence).toEqual({
      "ocr-line": "MERCADO OCR",
    });
    expect(result.current.error).toBeNull();
  });

  it.each([
    [new ApiTimeoutError(), "ATTEMPT_UNKNOWN"],
    [
      Object.assign(new Error("bad response"), {
        name: "ImportMalformedResponseError",
      }),
      "SAFETY_OR_MALFORMED",
    ],
    [
      new ApiResponseError("Unexpected repeated OCR gate", 422, {
        code: "OCR_REQUIRED",
        retryable: false,
        sessionId: "s1",
        currentRevision: 1,
        reason: null,
      }),
      "ATTEMPT_UNKNOWN",
    ],
  ] as const)(
    "locks a terminal v2 %s outcome as %s, including after a state read",
    async (terminalFailure, expectedKind) => {
      const attached = view({
        actions: ["ANALYZE", "CANCEL"],
        attachments: [
          {
            id: "a1",
            fileName: "scan.pdf",
            declaredBytes: 9,
            state: "ATTACHED",
            canAnalyze: true,
            materializedInSession: false,
          },
        ],
      });
      api.getFullImportSession.mockResolvedValue(attached);
      api.analyzeImportAttachment
        .mockRejectedValueOnce(
          new ApiResponseError("OCR", 422, {
            code: "OCR_REQUIRED",
            retryable: false,
            sessionId: "s1",
            currentRevision: 1,
            reason: null,
          }),
        )
        .mockRejectedValueOnce(terminalFailure);
      const { result } = setup();
      await waitFor(() => expect(result.current.view).not.toBeNull());
      await act(async () => {
        await result.current.analyze("a1");
        await result.current.consentExternalProcessing("a1");
        await result.current.consentExternalProcessing("a1");
      });
      expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(2);
      expect(result.current.ocrConsentAttempted).toBe(true);
      expect(result.current.ocrUiState).toEqual({
        attachmentId: "a1",
        kind: expectedKind,
      });

      await act(async () => {
        await result.current.recover();
        await result.current.consentExternalProcessing("a1");
      });
      expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps textual analysis local and never admits external consent without OCR_REQUIRED", async () => {
    const attached = view({
      actions: ["ANALYZE", "CANCEL"],
      attachments: [
        {
          id: "a1",
          fileName: "textual.pdf",
          declaredBytes: 9,
          state: "ATTACHED",
          canAnalyze: true,
          materializedInSession: false,
        },
      ],
    });
    api.getFullImportSession.mockResolvedValue(attached);
    api.analyzeImportAttachment.mockResolvedValue(
      view({
        revision: 2,
        actions: ["CANCEL"],
        attachments: [
          {
            ...attached.attachments[0],
            canAnalyze: false,
            materializedInSession: true,
          },
        ],
      }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.view).not.toBeNull());
    await act(async () => {
      await result.current.analyze("a1");
      await result.current.consentExternalProcessing("a1");
    });

    expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(1);
    expect(api.analyzeImportAttachment.mock.calls[0][2]).toEqual({
      expectedRevision: 1,
    });
    expect(result.current.ocrConsentAttempted).toBe(false);
    expect(result.current.ocrUiState).toBeNull();
  });

  it.each([
    [
      new ApiResponseError("Unavailable", 503, {
        code: "CAPABILITY_DISABLED",
        retryable: true,
        sessionId: "s1",
        currentRevision: 1,
        reason: null,
      }),
      "PRE_CALL_UNAVAILABLE",
    ],
    [
      new ApiResponseError("Unsafe", 422, {
        code: "DOCUMENT_UNREADABLE",
        retryable: false,
        sessionId: "s1",
        currentRevision: 1,
        reason: null,
      }),
      "DOCUMENT_UNSAFE",
    ],
    [
      new ApiResponseError("Budget", 422, {
        code: "LIMIT_EXCEEDED",
        retryable: false,
        sessionId: "s1",
        currentRevision: 1,
        reason: null,
      }),
      "BUDGET_OR_RATE_LIMIT",
    ],
  ] as const)(
    "maps pre-call documentary failure to %s",
    async (failure, kind) => {
      api.getFullImportSession.mockResolvedValue(
        view({
          actions: ["ANALYZE", "CANCEL"],
          attachments: [
            {
              id: "a1",
              fileName: "scan.pdf",
              declaredBytes: 9,
              state: "ATTACHED",
              canAnalyze: true,
              materializedInSession: false,
            },
          ],
        }),
      );
      api.analyzeImportAttachment.mockRejectedValue(failure);
      const { result } = setup();
      await waitFor(() => expect(result.current.view).not.toBeNull());
      await act(async () => {
        await result.current.analyze("a1");
      });
      expect(result.current.ocrUiState).toEqual({
        attachmentId: "a1",
        kind,
      });
      expect(result.current.ocrConsentAttempted).toBe(false);
      expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(1);
    },
  );

  it("drops a consented local PDF attempt on account change and ignores its late create", async () => {
    let release: ((value: ImportSessionViewV1) => void) | undefined;
    api.createImportSession.mockReturnValue(
      new Promise<ImportSessionViewV1>((resolve) => {
        release = resolve;
      }),
    );
    const { result, rerender } = setup(null);
    let attempt: Promise<void> | undefined;
    act(() => {
      attempt = result.current.consent(
        {
          id: "c1",
          nickname: null,
          last4: "1234",
          closingDay: 5,
          dueDay: 12,
          project: { id: "p1", name: "Pessoal" },
        },
        [pdf()],
        ["CSV", "PDF"],
      );
    });
    expect(result.current.hasAttempt).toBe(true);
    expect(result.current.busy).toBe(true);
    auth.user = { id: "user-2" };
    rerender();
    expect(result.current.hasAttempt).toBe(false);
    expect(result.current.sessionId).toBeNull();
    expect(result.current.error).toBeNull();
    await act(async () => {
      release?.(view());
      await attempt;
    });
    expect(api.reserveImportSessionAttachments).not.toHaveBeenCalled();
    expect(api.uploadImportSessionAttachment).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBeNull();
  });
});
