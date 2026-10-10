import { fireEvent, render, screen } from "@testing-library/react";
import type { ImportSessionGuidedReviewV1 } from "@reformaflow/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { declarationViewFixture } from "../_lib/import-workflow-fixtures";
import { ImportConversationBody } from "./ImportConversationBody";

const state = vi.hoisted(() => ({
  guidedReview: null as ImportSessionGuidedReviewV1 | null,
  continueGuidedReview: vi.fn(),
  reviewCurrentLot: vi.fn(),
  prepareCurrentLot: vi.fn(),
}));

vi.mock("../_hooks/useImportConversation", () => ({
  useImportConversation: () => ({
    userId: "actor-a",
    view: {
      ...declarationViewFixture(),
      questions: [],
      guidedReview: state.guidedReview,
    },
    question: null,
    guidedReview: state.guidedReview,
    guidedFocus: state.guidedReview?.focus ?? null,
    continuingGuidedReview: false,
    currentLot: null,
    busy: false,
    error: null,
    retryableSelection: null,
    selectionRecoveryFocus: null,
    retrySelection: vi.fn(),
    addToSelection: vi.fn(),
    removeFromSelection: vi.fn(),
    prepareCurrentLot: state.prepareCurrentLot,
    reviewCurrentLot: state.reviewCurrentLot,
    continueGuidedReview: state.continueGuidedReview,
    saveGuidedAnswer: vi.fn(),
    interpretAnswer: vi.fn(),
    recover: vi.fn(),
  }),
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

const documents = {
  busy: false,
  error: null,
  analyze: vi.fn(),
  recover: vi.fn(),
} as never;

describe("ImportConversationBody continuation actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps pending continue and review as separate server intents", () => {
    state.guidedReview = {
      progress: "READY_WITH_PENDING",
      focus: null,
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
    };
    render(
      <ImportConversationBody sessionId="session-a" documents={documents} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continuar respondendo" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Revisar as prontas agora" }),
    );

    expect(state.continueGuidedReview).toHaveBeenCalledTimes(1);
    expect(state.reviewCurrentLot).toHaveBeenCalledTimes(1);
    expect(state.prepareCurrentLot).not.toHaveBeenCalled();
  });

  it("keeps the ready-only review surface and never offers continue", () => {
    state.guidedReview = {
      progress: "READY",
      focus: null,
      actions: ["REVIEW_READY"],
    };
    render(
      <ImportConversationBody sessionId="session-a" documents={documents} />,
    );

    const review = screen.getByRole("button", {
      name: "Revisar as prontas agora",
    });
    expect(
      screen.queryByRole("button", { name: "Continuar respondendo" }),
    ).not.toBeInTheDocument();
    fireEvent.click(review);

    expect(state.reviewCurrentLot).toHaveBeenCalledTimes(1);
    expect(state.prepareCurrentLot).not.toHaveBeenCalled();
  });
});
