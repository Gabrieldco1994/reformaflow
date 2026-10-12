import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useImportDocumentFlow } from "./useImportDocumentFlow";

// Retomada de UPLOAD após reload: sem anexo ATTACHED local, só quando o SERVIDOR
// publica a ação UPLOAD, reusando reserva/upload autorizados e o consentimento
// local por arquivo. Sem ação UPLOAD, nada é oferecido nem enviado.

const api = vi.hoisted(() => ({
  getFullImportSession: vi.fn(),
  reserveImportSessionAttachments: vi.fn(),
  uploadImportSessionAttachment: vi.fn(),
  analyzeImportAttachment: vi.fn(),
  createImportSession: vi.fn(),
}));
vi.mock("../_lib/import-session-api", () => api);
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

const baseView = (over: Record<string, unknown> = {}) => ({
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

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const context = {
    key: "k",
    adoptionKey: (id: string) => id,
    publishSession: vi.fn(),
    recoverList: vi.fn(),
  };
  return renderHook(() => useImportDocumentFlow("s1", context), { wrapper });
}
const csv = () => new File(["a;b"], "fatura.csv", { type: "text/csv" });

describe("useImportDocumentFlow.resume", () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
  });

  it("offers resume only when the server view allows UPLOAD", async () => {
    api.getFullImportSession.mockResolvedValue(baseView());
    const withUpload = setup();
    await waitFor(() => expect(withUpload.result.current.view).not.toBeNull());
    expect(withUpload.result.current.canResume).toBe(true);

    api.getFullImportSession.mockResolvedValue(
      baseView({ actions: ["ANALYZE", "CANCEL"] }),
    );
    const without = setup();
    await waitFor(() => expect(without.result.current.view).not.toBeNull());
    expect(without.result.current.canResume).toBe(false);
  });

  it("does not upload when UPLOAD is not allowed", async () => {
    api.getFullImportSession.mockResolvedValue(
      baseView({ actions: ["CANCEL"] }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.view).not.toBeNull());
    await act(async () => {
      await result.current.resume([csv()], ["CSV"]);
    });
    expect(api.reserveImportSessionAttachments).not.toHaveBeenCalled();
    expect(api.uploadImportSessionAttachment).not.toHaveBeenCalled();
  });

  it("reserves and uploads the re-selected file through the authorized actions", async () => {
    api.getFullImportSession.mockResolvedValue(baseView());
    api.reserveImportSessionAttachments.mockImplementation(
      async (
        _id: string,
        req: { files: Array<{ id: string; fileName: string }> },
      ) =>
        baseView({
          revision: 2,
          attachments: req.files.map((f) => ({
            id: f.id,
            fileName: f.fileName,
            declaredBytes: 3,
            state: "RESERVED",
            materializedInSession: false,
            canAnalyze: false,
          })),
        }),
    );
    api.uploadImportSessionAttachment.mockImplementation(
      async (_id: string, attachmentId: string) =>
        baseView({
          revision: 3,
          actions: ["CANCEL"],
          attachments: [
            {
              id: attachmentId,
              fileName: "fatura.csv",
              declaredBytes: 3,
              state: "ATTACHED",
              materializedInSession: false,
              canAnalyze: false,
            },
          ],
        }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.canResume).toBe(true));
    await act(async () => {
      await result.current.resume([csv()], ["CSV"]);
    });
    expect(api.createImportSession).not.toHaveBeenCalled();
    expect(api.reserveImportSessionAttachments).toHaveBeenCalledTimes(1);
    expect(api.uploadImportSessionAttachment).toHaveBeenCalledTimes(1);
    expect(api.uploadImportSessionAttachment.mock.calls[0][0]).toBe("s1");
    await waitFor(() => expect(result.current.canResume).toBe(false));
  });

  it("skips analysis for a deduplicated file and continues unique files", async () => {
    api.getFullImportSession.mockResolvedValue(baseView());
    let reservedIds: string[] = [];
    api.reserveImportSessionAttachments.mockImplementation(
      async (
        _id: string,
        req: { files: Array<{ id: string; fileName: string }> },
      ) => {
        reservedIds = req.files.map((file) => file.id);
        return baseView({
          revision: 2,
          attachments: req.files.map((file) => ({
            id: file.id,
            fileName: file.fileName,
            declaredBytes: 3,
            state: "RESERVED",
            materializedInSession: false,
            canAnalyze: false,
          })),
        });
      },
    );
    api.uploadImportSessionAttachment.mockImplementation(
      async (_id: string, attachmentId: string) =>
        attachmentId === reservedIds[0]
          ? {
              kind: "DEDUPLICATED",
              attachmentId,
              view: baseView({
                revision: 3,
                actions: ["UPLOAD", "ANALYZE", "CANCEL"],
                attachments: [
                  {
                    id: "source",
                    fileName: "original.csv",
                    declaredBytes: 3,
                    state: "ATTACHED",
                    materializedInSession: true,
                    canAnalyze: false,
                  },
                  {
                    id: reservedIds[1],
                    fileName: "unique.csv",
                    declaredBytes: 3,
                    state: "RESERVED",
                    materializedInSession: false,
                    canAnalyze: false,
                  },
                ],
              }),
            }
          : baseView({
              revision: 4,
              actions: ["ANALYZE", "CANCEL"],
              attachments: [
                {
                  id: "source",
                  fileName: "original.csv",
                  declaredBytes: 3,
                  state: "ATTACHED",
                  materializedInSession: true,
                  canAnalyze: false,
                },
                {
                  id: attachmentId,
                  fileName: "unique.csv",
                  declaredBytes: 3,
                  state: "ATTACHED",
                  materializedInSession: false,
                  canAnalyze: true,
                },
              ],
            }),
    );
    api.analyzeImportAttachment.mockImplementation(
      async (_id: string, attachmentId: string) =>
        baseView({
          revision: 5,
          actions: ["CANCEL"],
          attachments: [
            {
              id: "source",
              fileName: "original.csv",
              declaredBytes: 3,
              state: "ATTACHED",
              materializedInSession: true,
              canAnalyze: false,
            },
            {
              id: attachmentId,
              fileName: "unique.csv",
              declaredBytes: 3,
              state: "ATTACHED",
              materializedInSession: true,
              canAnalyze: false,
            },
          ],
        }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.canResume).toBe(true));
    await act(async () => {
      await result.current.resume(
        [
          new File(["a;b"], "duplicate.csv", { type: "text/csv" }),
          new File(["c;d"], "unique.csv", { type: "text/csv" }),
        ],
        ["CSV"],
      );
    });

    expect(api.uploadImportSessionAttachment).toHaveBeenCalledTimes(2);
    expect(api.analyzeImportAttachment).toHaveBeenCalledTimes(1);
    expect(api.analyzeImportAttachment.mock.calls[0][1]).toBe(reservedIds[1]);
    expect(result.current.error).toBeNull();
    expect(result.current.notice).toBeTruthy();
    expect(result.current.view?.revision).toBe(5);
  });
});
