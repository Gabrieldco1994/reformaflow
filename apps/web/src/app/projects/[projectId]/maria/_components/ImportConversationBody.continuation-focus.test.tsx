import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MariaImportEntry } from "./MariaImportEntry";

const state = vi.hoisted(() => ({
  search: "importSessionId=source-session",
  documentsLoaded: true,
  receiptSessionId: "source-session",
  continuationSessionId: "continuation-session",
}));

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-1" }),
  usePathname: () => "/projects/project-1/maria",
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    hasModule: () => true,
  }),
}));
vi.mock("../_hooks/useImportSessions", () => ({
  useImportUserId: () => "user-1",
  useCancelImportSession: () => ({ cancel: vi.fn() }),
  useImportSessionList: () => ({
    entry: null,
    failure: null,
    status: "ready",
    items: [],
    hasMore: false,
    freshness: "fresh",
    failedNext: false,
    loadingMore: false,
    loadMore: vi.fn(),
    restart: vi.fn(),
  }),
}));
vi.mock("../_hooks/useImportDocumentFlow", () => ({
  useImportDocumentFlow: (sessionId: string | null) => ({
    sessionId,
    view: state.documentsLoaded ? {} : null,
    error: null,
    notice: null,
    busy: false,
    hasAttempt: false,
    canRetry: false,
    canResume: false,
    invalidate: mocks.invalidate,
    recover: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock("../_hooks/useImportConversation", () => ({
  useImportConversation: (sessionId: string | null) => ({
    userId: "user-1",
    view: null,
    question: null,
    error: null,
    busy: false,
    guided: null,
    result: sessionId === state.receiptSessionId ? { receipt: {} } : null,
    review: false,
    messages: [],
    literal: "",
    attachmentId: null,
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
    continuationSessionId: state.continuationSessionId,
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
      onClick={() => onOpenContinuation?.(state.continuationSessionId)}
    >
      Ver rascunho restante
    </button>
  ),
}));
vi.mock("./ImportRecoveryEntry", () => ({
  ImportRecoveryEntry: ({
    onContinue,
  }: {
    onContinue?: (sessionId: string) => void;
  }) => (
    <button type="button" onClick={() => onContinue?.("stored-session")}>
      Abrir importação guardada
    </button>
  ),
}));
vi.mock("./MariaDock", () => ({ MariaDock: () => null }));

function renderEntry() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const entry = () => (
    <QueryClientProvider client={client}>
      <MariaImportEntry projectId="project-1" />
    </QueryClientProvider>
  );
  const rendered = render(entry());
  return {
    ...rendered,
    rerenderEntry: () => rendered.rerender(entry()),
  };
}

function moveTo(
  rerenderEntry: () => void,
  sessionId: string,
  documentsLoaded: boolean,
) {
  state.search = `importSessionId=${sessionId}`;
  state.documentsLoaded = documentsLoaded;
  rerenderEntry();
}

beforeEach(() => {
  state.search = "importSessionId=source-session";
  state.documentsLoaded = true;
  state.receiptSessionId = "source-session";
  state.continuationSessionId = "continuation-session";
  mocks.replace.mockReset();
  mocks.invalidate.mockReset();
});

describe("MariaImportEntry continuation focus", () => {
  it("keeps the continuation intent across the loading unmount and consumes it after focus", async () => {
    const rendered = renderEntry();
    const sourceRegion = screen.getByRole("region", {
      name: "Conversa da importação",
    });
    expect(sourceRegion).not.toHaveFocus();

    fireEvent.click(
      screen.getByRole("button", { name: "Ver rascunho restante" }),
    );
    expect(mocks.replace).toHaveBeenCalledWith(
      "/projects/project-1/maria?importSessionId=continuation-session",
    );
    expect(sourceRegion).not.toHaveFocus();

    moveTo(rendered.rerenderEntry, "continuation-session", false);
    expect(
      screen.queryByRole("region", { name: "Conversa da importação" }),
    ).not.toBeInTheDocument();

    moveTo(rendered.rerenderEntry, "continuation-session", true);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Conversa da importação" }),
      ).toHaveFocus(),
    );

    moveTo(rendered.rerenderEntry, "continuation-session", false);
    const recoveryButton = screen.getByRole("button", {
      name: "Abrir importação guardada",
    });
    recoveryButton.focus();
    moveTo(rendered.rerenderEntry, "continuation-session", true);

    await waitFor(() => expect(recoveryButton).toHaveFocus());
    expect(
      screen.getByRole("region", { name: "Conversa da importação" }),
    ).not.toHaveFocus();
  });

  it("retains successor focus when the consumed intent rerenders the region", async () => {
    const rendered = renderEntry();
    fireEvent.click(
      screen.getByRole("button", { name: "Ver rascunho restante" }),
    );

    moveTo(rendered.rerenderEntry, "continuation-session", false);
    moveTo(rendered.rerenderEntry, "continuation-session", true);

    const successor = screen.getByRole("region", {
      name: "Conversa da importação",
    });
    // jsdom retains focus when React removes tabindex; Chromium blurs here.
    if (!successor.hasAttribute("tabindex"))
      screen.getByRole("button", { name: "Abrir importação guardada" }).focus();

    await waitFor(() => expect(successor).toHaveFocus());
  });

  it("does not focus a direct deep link", () => {
    state.search = "importSessionId=continuation-session";
    renderEntry();

    expect(
      screen.getByRole("region", { name: "Conversa da importação" }),
    ).not.toHaveFocus();
  });

  it("does not treat opening a stored session as a continuation request", () => {
    const rendered = renderEntry();
    fireEvent.click(
      screen.getByRole("button", { name: "Abrir importação guardada" }),
    );
    expect(mocks.replace).toHaveBeenCalledWith(
      "/projects/project-1/maria?importSessionId=stored-session",
    );

    moveTo(rendered.rerenderEntry, "stored-session", false);
    moveTo(rendered.rerenderEntry, "stored-session", true);

    expect(
      screen.getByRole("region", { name: "Conversa da importação" }),
    ).not.toHaveFocus();
  });

  it("keeps a newer continuation intent when an older focus completion races with it", async () => {
    state.search = "importSessionId=race-a";
    state.receiptSessionId = "race-a";
    state.continuationSessionId = "race-a";
    const rendered = renderEntry();
    const region = screen.getByRole("region", {
      name: "Conversa da importação",
    });
    const continuationButton = screen.getByRole("button", {
      name: "Ver rascunho restante",
    });

    region.addEventListener(
      "focus",
      () => {
        state.continuationSessionId = "race-b";
        continuationButton.click();
      },
      { once: true },
    );
    await act(async () => {
      fireEvent.click(continuationButton);
    });

    expect(mocks.replace).toHaveBeenNthCalledWith(
      1,
      "/projects/project-1/maria?importSessionId=race-a",
    );
    expect(mocks.replace).toHaveBeenNthCalledWith(
      2,
      "/projects/project-1/maria?importSessionId=race-b",
    );

    moveTo(rendered.rerenderEntry, "race-b", false);
    moveTo(rendered.rerenderEntry, "race-b", true);

    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Conversa da importação" }),
      ).toHaveFocus(),
    );
  });
});
