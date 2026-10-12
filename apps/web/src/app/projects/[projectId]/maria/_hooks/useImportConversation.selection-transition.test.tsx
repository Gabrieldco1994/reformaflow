import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImportSessionAmountMeaning,
  type ImportObservationQuestionV1,
  type ImportSessionDraftLineV1,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { importRoot } from "../_lib/import-session-keys";
import { useImportConversation } from "./useImportConversation";

const mocks = vi.hoisted(() => ({
  userId: "user-selection",
  getFullImportSession: vi.fn(),
  answerImportFocusedDraftQuestion: vi.fn(),
  answerImportDocumentaryQuestion: vi.fn(),
  editImportSession: vi.fn(),
  getImportResult: vi.fn(),
}));

vi.mock("../_lib/import-session-api", () => ({
  getFullImportSession: mocks.getFullImportSession,
  answerImportFocusedDraftQuestion: mocks.answerImportFocusedDraftQuestion,
  answerImportDocumentaryQuestion: mocks.answerImportDocumentaryQuestion,
  editImportSession: mocks.editImportSession,
  getImportResult: mocks.getImportResult,
}));
vi.mock("./useImportSessions", () => ({
  useImportUserId: () => mocks.userId,
}));

const line = (id: string): ImportSessionDraftLineV1 => ({
  id,
  observationIds: [`observation-${id}`],
  titulo: `Compra ${id}`,
  fornecedor: null,
  tipoDespesa: null,
  categoriaMaoDeObra: null,
  amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
  amountCents: id === "line-a" ? 12_345 : 6_789,
  installmentCount: 1,
  dataCompra: "2026-10-10",
  firstDueDate: null,
  targets: null,
  decision: { kind: "UNRESOLVED" },
});

const pendingQuestion = (lineId: string): ImportSessionQuestionV1 => ({
  id: `question-${lineId}`,
  lineIds: [lineId],
  field: "firstDueDate",
  text: `Vencimento de ${lineId}`,
});

const answeredQuestion = (lineId: string): ImportObservationQuestionV1 => ({
  id: `answered-${lineId}`,
  lineIds: [lineId],
  field: "merchant",
  text: `Fornecedor de ${lineId}`,
  subject: {
    kind: "OBSERVATION",
    observationId: `observation-${lineId}`,
    meaningContext: null,
  },
  answerState: "DECLARED",
});

const baseView = (
  selectedLineIds: string[],
  questions: ImportSessionQuestionV1[],
): ImportSessionViewV1 => ({
  version: 1,
  id: "session-selection",
  ownerProjectId: "project-owner",
  cardId: "card-1",
  state: "DRAFT",
  revision: 4,
  expiresAt: "2026-10-18T00:00:00.000Z",
  attachments: [],
  lines: [line("line-a"), line("line-b")],
  selectedLineIds,
  questions,
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["RESOLVE", "CANCEL"],
});

function setup(view: ImportSessionViewV1) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const key = [...importRoot(mocks.userId), "workflow", view.id];
  client.setQueryData(key, view);
  mocks.getFullImportSession.mockResolvedValue(view);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(() => useImportConversation(view.id), { wrapper }),
    client,
    key,
  };
}

beforeEach(() => {
  mocks.userId = "user-selection";
  Object.values(mocks).forEach((mock) => {
    if (vi.isMockFunction(mock)) mock.mockReset();
  });
});
afterEach(cleanup);

describe("selection transitions arbitrate current question and edit state", () => {
  it("moves focus from deselected A to still-selected B", async () => {
    const questionA = pendingQuestion("line-a");
    const questionB = pendingQuestion("line-b");
    const initial = baseView(["line-a", "line-b"], [questionA, questionB]);
    const { result } = setup(initial);
    await waitFor(() => expect(result.current.busy).toBe(false));

    act(() => result.current.setLiteral("rascunho exclusivo de A"));
    expect(result.current.question?.id).toBe(questionA.id);
    mocks.editImportSession.mockResolvedValue({
      ...initial,
      revision: 5,
      selectedLineIds: ["line-b"],
    });

    await act(async () => result.current.removeFromSelection("line-a"));

    expect(result.current.question?.id).toBe(questionB.id);
    expect(result.current.literal).toBe("");
    expect(result.current.focus ?? null).toBeNull();
  });

  it("has no current question after deselecting every line", async () => {
    const questionA = pendingQuestion("line-a");
    const initial = baseView(["line-a"], [questionA]);
    const { result } = setup(initial);
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.editImportSession.mockResolvedValue({
      ...initial,
      revision: 5,
      selectedLineIds: [],
    });

    await act(async () => result.current.removeFromSelection("line-a"));

    expect(result.current.question).toBeNull();
    expect(result.current.literal).toBe("");
    expect(result.current.focus ?? null).toBeNull();
  });

  it("clears edit and focus when the edited A line is deselected", async () => {
    const answeredA = answeredQuestion("line-a");
    const questionB = pendingQuestion("line-b");
    const initial = baseView(["line-a", "line-b"], [answeredA, questionB]);
    const { result } = setup(initial);
    await waitFor(() => expect(result.current.busy).toBe(false));

    act(() => result.current.editQuestion(answeredA.id));
    act(() => result.current.setLiteral("nova resposta de A"));
    expect(result.current.question?.id).toBe(answeredA.id);
    expect(result.current.editingQuestionId).toBe(answeredA.id);
    mocks.editImportSession.mockResolvedValue({
      ...initial,
      revision: 5,
      selectedLineIds: ["line-b"],
    });

    await act(async () => result.current.removeFromSelection("line-a"));

    expect(result.current.question?.id).toBe(questionB.id);
    expect(result.current.editingQuestionId).toBeNull();
    expect(result.current.focus ?? null).toBeNull();
    expect(result.current.literal).toBe("");
  });

  it("does not open the edit path for an answered unselected line", async () => {
    const answeredA = answeredQuestion("line-a");
    const questionB = pendingQuestion("line-b");
    const initial = baseView(["line-b"], [answeredA, questionB]);
    const { result } = setup(initial);
    await waitFor(() => expect(result.current.busy).toBe(false));

    act(() => result.current.editQuestion(answeredA.id));

    expect(result.current.question?.id).toBe(questionB.id);
    expect(result.current.editingQuestionId).toBeNull();
    expect(result.current.focus ?? null).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
