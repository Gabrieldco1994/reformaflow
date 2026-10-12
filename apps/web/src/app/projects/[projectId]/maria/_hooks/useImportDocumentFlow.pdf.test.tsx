import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { ApiResponseError } from "@/lib/api";
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
