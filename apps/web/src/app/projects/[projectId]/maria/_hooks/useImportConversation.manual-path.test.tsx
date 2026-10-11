import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { useImportConversation } from "./useImportConversation";
import { importRoot } from "../_lib/import-session-keys";

const mocks = vi.hoisted(() => ({
  userId: "user-1",
  getFullImportSession: vi.fn(),
  prepareImportSession: vi.fn(),
  getImportResult: vi.fn(),
  answerImportFocusedDraftQuestion: vi.fn(),
  answerImportDocumentaryQuestion: vi.fn(),
  editImportSession: vi.fn(),
  agentSend: vi.fn(),
}));

vi.mock("../_lib/import-session-api", () => ({
  getFullImportSession: mocks.getFullImportSession,
  prepareImportSession: mocks.prepareImportSession,
  getImportResult: mocks.getImportResult,
  answerImportFocusedDraftQuestion: mocks.answerImportFocusedDraftQuestion,
  answerImportDocumentaryQuestion: mocks.answerImportDocumentaryQuestion,
  editImportSession: mocks.editImportSession,
}));
vi.mock("./useImportSessions", () => ({
  useImportUserId: () => mocks.userId,
}));
vi.mock("@/components/agent/useFinancialAgent", () => ({
  useFinancialAgent: () => ({ send: mocks.agentSend }),
}));

const base: ImportSessionViewV1 = {
  version: 1,
  id: "session-1",
  ownerProjectId: "project-1",
  cardId: "card-1",
  state: "DRAFT",
  revision: 4,
  expiresAt: "2026-10-16T21:00:00.000Z",
  attachments: [],
  lines: [],
  selectedLineIds: [],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: true,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["PREPARE", "CANCEL"],
};

function setup(view = base) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData([...importRoot(mocks.userId), "workflow", view.id], view);
  mocks.getFullImportSession.mockResolvedValue(view);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useImportConversation(view.id, false, "VOICE"), {
    wrapper,
  });
}

beforeEach(() => {
  Object.values(mocks).forEach((value) => {
    if (vi.isMockFunction(value)) value.mockReset();
  });
});
afterEach(cleanup);

describe("active import deterministic controls", () => {
  it("opens review through prepare and reads the receipt through result, never agent chat", async () => {
    const ready: ImportSessionViewV1 = {
      ...base,
      state: "READY",
      revision: 5,
      proposal: {} as ImportSessionViewV1["proposal"],
      actions: ["CONFIRM", "CANCEL"],
    };
    mocks.prepareImportSession.mockResolvedValue(ready);
    mocks.getImportResult.mockResolvedValue({
      state: "READY",
      receipt: null,
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));

    await act(async () => {
      await result.current.openReview();
    });
    expect(mocks.prepareImportSession).toHaveBeenCalledWith(
      "session-1",
      {
        expectedRevision: 4,
      },
      expect.any(AbortSignal),
    );
    expect(result.current.review).toBe(true);

    await act(async () => {
      await result.current.readResult();
    });
    expect(mocks.getImportResult).toHaveBeenCalledWith(
      "session-1",
      expect.any(AbortSignal),
    );
    expect(mocks.agentSend).not.toHaveBeenCalled();
  });

  it("after a lost prepare response performs an authorized read and never retries the mutation", async () => {
    mocks.prepareImportSession.mockRejectedValue(new TypeError("network"));
    mocks.getFullImportSession.mockResolvedValue({
      ...base,
      state: "READY",
      revision: 5,
      proposal: {} as ImportSessionViewV1["proposal"],
      actions: ["CONFIRM", "CANCEL"],
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));

    await act(async () => {
      await result.current.openReview();
    });

    expect(mocks.prepareImportSession).toHaveBeenCalledOnce();
    expect(mocks.getFullImportSession).toHaveBeenCalled();
    expect(mocks.agentSend).not.toHaveBeenCalled();
  });
});
