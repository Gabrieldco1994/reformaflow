import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MariaImportEntry } from "./MariaImportEntry";

const state = vi.hoisted(() => ({
  sessionId: null as string | null,
  publishSession: null as ((sessionId: string) => void) | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/project-1/maria",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ hasModule: () => true }),
}));

vi.mock("../_hooks/useImportSessions", () => ({
  useImportUserId: () => "user-1",
  useImportSessionList: () => ({
    entry: null,
    failure: null,
    freshness: "fresh",
    restart: vi.fn(),
  }),
}));

vi.mock("../_hooks/useImportDocumentFlow", () => ({
  useImportDocumentFlow: (
    _sessionId: string | null,
    context: { publishSession: (sessionId: string) => void },
  ) => {
    state.publishSession = context.publishSession;
    return {
      sessionId: state.sessionId,
      view: state.sessionId ? {} : null,
      error: null,
      notice: null,
      busy: false,
      hasAttempt: false,
      canRetry: false,
      canResume: false,
      invalidate: vi.fn(),
    };
  },
}));

vi.mock("../_lib/import-session-api", () => ({
  listImportEntryCards: vi.fn().mockResolvedValue([]),
}));

vi.mock("./ImportRecoveryEntry", () => ({
  ImportRecoveryEntry: () => null,
}));

vi.mock("./MariaChatBody", () => ({
  MariaChatBody: (props: {
    importSessionId?: string | null;
    originChannel?: "TEXT" | "VOICE";
    onImportEntryAction?: (action: {
      version: 1;
      kind: "START_CARD_INVOICE_IMPORT";
      originChannel: "VOICE";
      formats: ["CSV"];
      suggestedCardId: null;
    }) => void;
  }) =>
    props.importSessionId ? (
      <p>
        Canal ativo: <span>{props.originChannel}</span>
      </p>
    ) : (
      <button
        type="button"
        onClick={() =>
          props.onImportEntryAction?.({
            version: 1,
            kind: "START_CARD_INVOICE_IMPORT",
            originChannel: "VOICE",
            formats: ["CSV"],
            suggestedCardId: null,
          })
        }
      >
        Resposta de voz pronta
      </button>
    ),
}));

function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MariaImportEntry projectId="project-1" />
    </QueryClientProvider>
  );
}

describe("MariaImportEntry channel bridge", () => {
  beforeEach(() => {
    state.sessionId = null;
    state.publishSession = null;
  });

  it("carries the response action origin into the newly active import conversation", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rendered = render(tree(client));

    fireEvent.click(
      screen.getByRole("button", { name: "Resposta de voz pronta" }),
    );
    act(() => state.publishSession?.("session-1"));
    state.sessionId = "session-1";
    rendered.rerender(tree(client));

    expect(screen.getByText("VOICE")).toBeInTheDocument();
  });
});
