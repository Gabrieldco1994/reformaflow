import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  declarationQuestionFixture,
  declarationViewFixture,
} from "../_lib/import-workflow-fixtures";
import { ImportConversationBody } from "./ImportConversationBody";

const state = vi.hoisted(() => ({
  addToSelection: vi.fn(),
  error: null as {
    message: string;
    recovery: "READ_SESSION";
    privateContextLost: false;
  } | null,
  prepareCurrentLot: vi.fn(),
  reviewCurrentLot: vi.fn(),
  removeFromSelection: vi.fn(),
  retrySelection: vi.fn(),
  retryableSelection: null as {
    operation: "DEFER";
    lineId: string;
  } | null,
}));

vi.mock("../_hooks/useImportConversation", () => ({
  useImportConversation: () => {
    const base = declarationViewFixture();
    const view = {
      ...base,
      actions: ["RESOLVE", "PREPARE"],
      selectedLineIds: ["first"],
      lines: base.lines.map((line) =>
        line.id === "twin"
          ? { ...line, decision: { kind: "DEFER" as const } }
          : line,
      ),
    };
    return {
      userId: "actor-a",
      view,
      question: declarationQuestionFixture(),
      currentLot: null,
      busy: false,
      error: state.error,
      retryableSelection: state.retryableSelection,
      retrySelection: state.retrySelection,
      addToSelection: state.addToSelection,
      removeFromSelection: state.removeFromSelection,
      prepareCurrentLot: state.prepareCurrentLot,
      reviewCurrentLot: state.reviewCurrentLot,
      saveGuidedAnswer: vi.fn(),
      interpretAnswer: vi.fn(),
      recover: vi.fn(),
    };
  },
}));

vi.mock("../_hooks/useImportExecution", () => ({
  useImportExecution: () => ({
    lot: null,
    pending: false,
    error: null,
    notice: null,
    financialAction: null,
    act: vi.fn(),
    retry: vi.fn(),
  }),
}));

vi.mock("../_hooks/useImportSessions", () => ({
  useImportUserId: () => "actor-a",
}));

vi.mock("@/components/agent/useSpeechRecognition", () => ({
  useSpeechRecognition: () => ({ supported: false, start: vi.fn() }),
}));

vi.mock("./ImportFocusedQuestion", () => ({
  ImportFocusedQuestion: () => (
    <section aria-label="Compra 1 de 2">Pergunta da compra atual</section>
  ),
}));

vi.mock("./ImportSelectionRow", () => ({
  ImportSelectionRow: ({ onAdd }: { onAdd: (id: string) => void }) => (
    <button type="button" onClick={() => onAdd("twin")}>
      Continuar compra 2 de 2
    </button>
  ),
}));

describe("ImportConversationBody guided actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.error = null;
    state.retryableSelection = null;
  });

  it("shows one active purchase plus the server-permitted defer, reactivate, and ready-review actions", () => {
    render(
      <ImportConversationBody
        sessionId="session-a"
        documents={
          {
            busy: false,
            error: null,
            analyze: vi.fn(),
            recover: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getAllByRole("region", { name: "Compra 1 de 2" }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Responder depois" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Continuar compra 2 de 2" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revisar compras prontas" }),
    );

    expect(state.removeFromSelection).toHaveBeenCalledWith("first");
    expect(state.addToSelection).toHaveBeenCalledWith("twin");
    expect(state.reviewCurrentLot).toHaveBeenCalledTimes(1);
    expect(state.prepareCurrentLot).not.toHaveBeenCalled();
  });

  it("keeps the original action disabled and exposes the settled command retry", () => {
    state.error = {
      message: "Resultado não confirmado.",
      recovery: "READ_SESSION",
      privateContextLost: false,
    };
    state.retryableSelection = { operation: "DEFER", lineId: "first" };

    render(
      <ImportConversationBody
        sessionId="session-a"
        documents={
          {
            busy: false,
            error: null,
            analyze: vi.fn(),
            recover: vi.fn(),
          } as never
        }
      />,
    );

    expect(
      screen.getByRole("button", { name: "Responder depois" }),
    ).toBeDisabled();
    const retry = screen.getByRole("button", {
      name: "Repetir esta tentativa",
    });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(state.retrySelection).toHaveBeenCalledTimes(1);
  });
});
