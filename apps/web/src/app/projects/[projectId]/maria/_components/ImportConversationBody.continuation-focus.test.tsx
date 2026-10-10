import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ImportConversationBody } from "./ImportConversationBody";
import type { ImportDocumentFlow } from "../_hooks/useImportDocumentFlow";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-1" }),
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("../_hooks/useImportSessions", () => ({
  useImportUserId: () => "user-1",
  useCancelImportSession: () => ({ cancel: vi.fn() }),
}));
vi.mock("../_hooks/useImportConversation", () => ({
  useImportConversation: (sessionId: string | null) => ({
    userId: "user-1",
    view: null,
    question: null,
    error: null,
    busy: false,
    guided: null,
    result: sessionId === "source-session" ? { receipt: {} } : null,
    review: false,
    scopeReview: null,
    messages: [],
    literal: "",
    attachmentId: null,
    send: vi.fn(),
    recover: vi.fn(),
    setLiteral: vi.fn(),
    setAttachmentId: vi.fn(),
  }),
}));
vi.mock("../_hooks/useImportCatalog", () => ({
  useImportCatalog: () => ({
    names: {
      project: () => "Projeto",
      card: () => "Cartão",
    },
  }),
}));
vi.mock("@/components/agent/useSpeechRecognition", () => ({
  useSpeechRecognition: () => ({
    stop: vi.fn(),
    start: vi.fn(),
    listening: false,
    supported: false,
  }),
}));
vi.mock("../_lib/import-receipt-view", () => ({
  buildReceiptView: () => ({
    continuationSessionId: "continuation-session",
  }),
}));
vi.mock("./ImportReceipt", () => ({
  ImportReceipt: ({
    onOpenContinuation,
  }: {
    onOpenContinuation?: (sessionId: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => onOpenContinuation?.("continuation-session")}
    >
      Ver rascunho restante
    </button>
  ),
}));
vi.mock("./MariaDock", () => ({ MariaDock: () => null }));

const documents = {
  busy: false,
  error: null,
} as unknown as ImportDocumentFlow;

beforeEach(() => {
  mocks.replace.mockReset();
});

it("focuses the new conversation only after the user opens the continuation", async () => {
  const { rerender } = render(
    <ImportConversationBody sessionId="source-session" documents={documents} />,
  );

  expect(
    screen.getByRole("region", { name: "Conversa da importação" }),
  ).not.toHaveFocus();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Ver rascunho restante",
    }),
  );
  expect(mocks.replace).toHaveBeenCalledWith(
    "/projects/project-1/maria?importSessionId=continuation-session",
  );

  rerender(
    <ImportConversationBody
      sessionId="continuation-session"
      documents={documents}
    />,
  );

  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Conversa da importação" }),
    ).toHaveFocus(),
  );
});
