import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  type ImportSessionDraftLineV1,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { useImportConversation } from "./useImportConversation";
import { importRoot } from "../_lib/import-session-keys";
import type { FocusedDraftAnswer } from "../_lib/import-focused-draft-types";

const mocks = vi.hoisted(() => ({
  userId: "user-1",
  getFullImportSession: vi.fn(),
  answerImportFocusedDraftQuestion: vi.fn(),
  answerImportDocumentaryQuestion: vi.fn(),
  editImportSession: vi.fn(),
  getImportResult: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../_lib/import-session-api", () => ({
  getFullImportSession: mocks.getFullImportSession,
  answerImportFocusedDraftQuestion: mocks.answerImportFocusedDraftQuestion,
  answerImportDocumentaryQuestion: mocks.answerImportDocumentaryQuestion,
  editImportSession: mocks.editImportSession,
  getImportResult: mocks.getImportResult,
}));
vi.mock("./useImportSessions", () => ({ useImportUserId: () => mocks.userId }));
vi.mock("@/components/agent/useFinancialAgent", () => ({
  useFinancialAgent: () => ({ send: mocks.send }),
}));
const line: ImportSessionDraftLineV1 = {
  id: "line-1",
  observationIds: ["observation-1"],
  titulo: "Compra documental",
  fornecedor: null,
  tipoDespesa: null,
  categoriaMaoDeObra: null,
  amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
  amountCents: 123456,
  installmentCount: 3,
  dataCompra: "2025-09-01",
  firstDueDate: null,
  targets: null,
  decision: { kind: "UNRESOLVED" },
};
const base: ImportSessionViewV1 = {
  version: 1,
  id: "session-1",
  ownerProjectId: "project-1",
  cardId: "card-1",
  state: "DRAFT",
  revision: 4,
  expiresAt: "2026-10-16T21:00:00.000Z",
  attachments: [],
  lines: [line],
  selectedLineIds: [line.id],
  questions: [
    {
      id: "q-due",
      field: "firstDueDate",
      lineIds: [line.id],
      text: "Qual o primeiro vencimento?",
    },
  ],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["RESOLVE", "CANCEL"],
};
const accepted = {
  id: "q-due",
  text: "2025-10-10",
  draftAnswer: { field: "firstDueDate" as const, value: "2025-10-10" },
};
const stored = (): ImportSessionViewV1 => ({
  ...base,
  revision: 5,
  lines: [{ ...line, firstDueDate: "2025-10-10" }],
  questions: [],
});
function setup(view = base) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const key = [...importRoot(mocks.userId), "workflow", view.id];
  client.setQueryData(key, view);
  mocks.getFullImportSession.mockResolvedValue(view);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    (sessionId: string) => useImportConversation(sessionId),
    {
      wrapper,
      initialProps: view.id,
    },
  );
  return { ...hook, client, key };
}
beforeEach(() => {
  mocks.userId = "user-1";
  Object.values(mocks).forEach((mock) => {
    if (vi.isMockFunction(mock)) mock.mockReset();
  });
});
afterEach(cleanup);

describe("native create and no-allocation choices", () => {
  const cases: Extract<
    FocusedDraftAnswer,
    { field: "decision" | "targets" }
  >[] = [
    {
      field: "decision" as const,
      value: {
        kind: "CREATE" as const,
        acceptNaturalDuplicate: false as const,
      },
    },
    { field: "targets" as const, value: [] as [] },
  ];
  it.each(cases)(
    "PATCHes exact $field answer without agent or financial confirmation",
    async (draftAnswer) => {
      const { field, value } = draftAnswer;
      const question = {
        id: "q-choice",
        field,
        lineIds: [line.id],
        text: "Escolha",
      };
      const view = { ...base, questions: [question] };
      const { result } = setup(view);
      await waitFor(() => expect(result.current.busy).toBe(false));
      const fresh = {
        ...view,
        revision: 5,
        questions: [],
        lines: [{ ...line, [field]: structuredClone(value) }],
      };
      mocks.answerImportFocusedDraftQuestion.mockResolvedValue(fresh);
      await act(async () => {
        await result.current.saveFocusedDraft({
          id: question.id,
          text: "Escolha explícita",
          draftAnswer,
        });
      });
      expect(mocks.answerImportFocusedDraftQuestion).toHaveBeenCalledWith(
        base.id,
        {
          version: 1,
          answerRequestId: expect.any(String),
          expectedRevision: 4,
          questionId: question.id,
          channel: "TEXT",
          answer:
            field === "targets"
              ? { field, value: { kind: "NO_TARGETS" } }
              : { field, value },
        },
        expect.any(AbortSignal),
      );
      expect(mocks.send).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();
      expect(result.current.review).toBe(false);
      expect(result.current.view?.confirmation).toBeNull();
      expect(result.current.view?.receipt).toBeNull();
    },
  );

  it.each(cases)(
    "accepts independently allocated no-op $field values structurally",
    async (draftAnswer) => {
      const { field, value } = draftAnswer;
      const question = {
        id: "q-choice",
        field,
        lineIds: [line.id],
        text: "Escolha",
      };
      const view = {
        ...base,
        questions: [question],
        lines: [{ ...line, [field]: value }],
      };
      const { result } = setup(view);
      await waitFor(() => expect(result.current.busy).toBe(false));
      mocks.answerImportFocusedDraftQuestion.mockResolvedValue(
        structuredClone(view),
      );
      await act(async () => {
        await result.current.saveFocusedDraft({
          id: question.id,
          text: "Escolha explícita",
          draftAnswer: structuredClone(draftAnswer),
        });
      });
      expect(result.current.error).toBeNull();
      expect(result.current.view?.revision).toBe(4);
    },
  );

  it.each(["decision", "targets"] as const)(
    "rejects wrong stored %s without success",
    async (field) => {
      const question = {
        id: "q-choice",
        field,
        lineIds: [line.id],
        text: "Escolha",
      };
      const { result, client, key } = setup({ ...base, questions: [question] });
      await waitFor(() => expect(result.current.busy).toBe(false));
      const draftAnswer =
        field === "decision"
          ? {
              field,
              value: {
                kind: "CREATE" as const,
                acceptNaturalDuplicate: false as const,
              },
            }
          : { field, value: [] as [] };
      mocks.answerImportFocusedDraftQuestion.mockResolvedValue({
        ...base,
        revision: 5,
        lines: [
          {
            ...line,
            decision: { kind: "CREATE", acceptNaturalDuplicate: true },
            targets: [{ projectId: "target", roomId: null, amountCents: 100 }],
          },
        ],
      });
      await act(async () => {
        await result.current.saveFocusedDraft({
          id: question.id,
          text: "",
          draftAnswer,
        });
      });
      expect(result.current.error).not.toBeNull();
      expect(client.getQueryData<ImportSessionViewV1>(key)?.revision).toBe(4);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "reads uncertain $field results without retry or success",
    async (draftAnswer) => {
      const question = {
        id: "q-choice",
        field: draftAnswer.field,
        lineIds: [line.id],
        text: "Escolha",
      };
      const view = { ...base, questions: [question] };
      const { result } = setup(view);
      await waitFor(() => expect(result.current.busy).toBe(false));
      mocks.getFullImportSession.mockClear();
      mocks.getFullImportSession.mockResolvedValue({
        ...view,
        revision: 5,
        questions: [],
        lines: [{ ...line, [draftAnswer.field]: draftAnswer.value }],
      });
      mocks.answerImportFocusedDraftQuestion.mockRejectedValue(
        new TypeError("Lost response"),
      );
      await act(async () => {
        await result.current.saveFocusedDraft({
          id: question.id,
          text: "",
          draftAnswer,
        });
      });
      expect(mocks.getFullImportSession).toHaveBeenCalledOnce();
      expect(mocks.answerImportFocusedDraftQuestion).toHaveBeenCalledOnce();
      expect(result.current.error).not.toBeNull();
      expect(
        result.current.messages.some((m) => m.content.includes("guardada")),
      ).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "discards late $field responses when subject/revision changes",
    async (draftAnswer) => {
      const question = {
        id: "q-choice",
        field: draftAnswer.field,
        lineIds: [line.id],
        text: "Escolha",
      };
      const view = { ...base, questions: [question] };
      const { result, client, key } = setup(view);
      await waitFor(() => expect(result.current.busy).toBe(false));
      let resolve!: (view: ImportSessionViewV1) => void;
      mocks.answerImportFocusedDraftQuestion.mockReturnValue(
        new Promise<ImportSessionViewV1>((done) => {
          resolve = done;
        }),
      );
      let pending: Promise<unknown>;
      act(() => {
        pending = result.current.saveFocusedDraft({
          id: question.id,
          text: "",
          draftAnswer,
        });
      });
      act(() => {
        client.setQueryData(key, {
          ...view,
          revision: 6,
          questions: [{ ...question, lineIds: ["another"] }],
        });
      });
      await act(async () => {
        resolve({
          ...view,
          revision: 5,
          lines: [{ ...line, [draftAnswer.field]: draftAnswer.value }],
        });
        await pending;
      });
      expect(client.getQueryData<ImportSessionViewV1>(key)?.revision).toBe(6);
      expect(
        result.current.messages.some((m) => m.content.includes("guardada")),
      ).toBe(false);
    },
  );
});

describe("focused draft native answers", () => {
  it("saves the exact date-only value by typed PATCH, without agent or finance", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.answerImportFocusedDraftQuestion.mockResolvedValue(stored());
    await act(async () => {
      await result.current.saveFocusedDraft(accepted);
    });
    expect(mocks.answerImportFocusedDraftQuestion).toHaveBeenCalledWith(
      base.id,
      {
        version: 1,
        answerRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expectedRevision: 4,
        questionId: "q-due",
        channel: "TEXT",
        answer: {
          field: "firstDueDate",
          literal: "2025-10-10",
          value: "2025-10-10",
        },
      },
      expect.any(AbortSignal),
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.answerImportDocumentaryQuestion).not.toHaveBeenCalled();
    expect(mocks.editImportSession).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.view?.lines[0].dataCompra).toBe("2025-09-01");
    expect(result.current.view?.proposal).toBeNull();
    expect(result.current.review).toBe(false);
  });

  it("saves the explicit expense enum and leaves MAO_DE_OBRA category unresolved", async () => {
    const view: ImportSessionViewV1 = {
      ...base,
      questions: [
        {
          id: "q-type",
          field: "tipoDespesa",
          lineIds: [line.id],
          text: "Qual tipo?",
        },
      ],
    };
    const { result } = setup(view);
    await waitFor(() => expect(result.current.busy).toBe(false));
    const draftAnswer = {
      field: "tipoDespesa" as const,
      value: ExpenseType.MAO_DE_OBRA,
    };
    mocks.answerImportFocusedDraftQuestion.mockResolvedValue({
      ...view,
      revision: 5,
      lines: [{ ...line, tipoDespesa: ExpenseType.MAO_DE_OBRA }],
      questions: [
        {
          id: "q-category",
          field: "categoriaMaoDeObra",
          lineIds: [line.id],
          text: "Qual categoria?",
        },
      ],
    });
    await act(async () => {
      await result.current.saveFocusedDraft({
        id: "q-type",
        text: "Mão de obra",
        draftAnswer,
      });
    });
    expect(mocks.answerImportFocusedDraftQuestion).toHaveBeenCalledWith(
      base.id,
      expect.objectContaining({ questionId: "q-type", answer: draftAnswer }),
      expect.any(AbortSignal),
    );
    expect(result.current.view?.lines[0].categoriaMaoDeObra).toBeNull();
    expect(result.current.question?.field).toBe("categoriaMaoDeObra");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it.each([
    "value",
    "subject",
    "revision",
    "selection",
    "unrelatedField",
    "finance",
  ] as const)(
    "rejects mismatched response %s without announcing success",
    async (kind) => {
      const { result, client, key } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));
      const wrong = stored();
      if (kind === "value") wrong.lines[0].firstDueDate = "2026-10-10";
      if (kind === "subject") wrong.lines[0].id = "other-line";
      if (kind === "revision") wrong.revision = 6;
      if (kind === "selection") wrong.selectedLineIds = [];
      if (kind === "unrelatedField") wrong.lines[0].amountCents = 999;
      if (kind === "finance") wrong.state = "CONFIRMED";
      mocks.answerImportFocusedDraftQuestion.mockResolvedValue(wrong);
      mocks.getFullImportSession.mockResolvedValue(base);
      await act(async () => {
        await result.current.saveFocusedDraft(accepted);
      });
      expect(result.current.error).not.toBeNull();
      expect(client.getQueryData(key)).toEqual(base);
      expect(
        result.current.messages.some((m) => m.content.includes("guardada")),
      ).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("rejects a wrong question or field before PATCH", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      await result.current.saveFocusedDraft({
        id: "q-due",
        text: "Outros",
        draftAnswer: { field: "tipoDespesa", value: ExpenseType.OUTROS },
      });
    });
    expect(mocks.answerImportFocusedDraftQuestion).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
  });

  it.each(["2025-02-29", "2025-13-01", "10/10/2025", "2025-10-10T00:00:00Z"])(
    "rejects invalid date-only input %s before PATCH",
    async (value) => {
      const { result } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));
      await act(async () => {
        await result.current.saveFocusedDraft({
          ...accepted,
          draftAnswer: { field: "firstDueDate", value },
        });
      });
      expect(mocks.answerImportFocusedDraftQuestion).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(result.current.error).not.toBeNull();
    },
  );

  it("keeps an explicit null local and makes zero focused request", async () => {
    const view = { ...base, lines: [{ ...line, firstDueDate: "2025-10-10" }] };
    const { result } = setup(view);
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      await result.current.saveFocusedDraft({
        ...accepted,
        draftAnswer: { field: "firstDueDate", value: null },
      });
    });
    expect(mocks.answerImportFocusedDraftQuestion).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.current.view?.lines[0].firstDueDate).toBe("2025-10-10");
    expect(result.current.question?.field).toBe("firstDueDate");
    expect(result.current.error).not.toBeNull();
  });

  it("serializes money and an integral target with deterministic literals", async () => {
    const cases = [
      {
        question: {
          id: "q-amount",
          field: "amountCents" as const,
          lineIds: [line.id],
          text: "Qual valor?",
        },
        accepted: {
          id: "q-amount",
          text: "R$ 206,96",
          draftAnswer: { field: "amountCents" as const, value: 20_696 },
        },
        storedLine: { ...line, amountCents: 20_696 },
        answer: {
          field: "amountCents",
          literal: "R$ 206,96",
          value: 20_696,
        },
      },
      {
        question: {
          id: "q-target",
          field: "targets" as const,
          lineIds: [line.id],
          text: "Qual destino?",
        },
        accepted: {
          id: "q-target",
          text: "target",
          draftAnswer: {
            field: "targets" as const,
            value: [
              {
                projectId: "project-reforma",
                roomId: "room-cozinha",
                amountCents: 123_456,
              },
            ],
          },
        },
        storedLine: {
          ...line,
          targets: [
            {
              projectId: "project-reforma",
              roomId: "room-cozinha",
              amountCents: 123_456,
            },
          ],
        },
        answer: {
          field: "targets",
          value: {
            kind: "TARGET",
            projectId: "project-reforma",
            roomId: "room-cozinha",
            amountCents: 123_456,
            literal: "1234,56",
          },
        },
      },
    ] as const;

    for (const item of cases) {
      const view: ImportSessionViewV1 = {
        ...base,
        questions: [item.question as ImportSessionQuestionV1],
      };
      const { result, unmount } = setup(view);
      await waitFor(() => expect(result.current.busy).toBe(false));
      mocks.answerImportFocusedDraftQuestion.mockResolvedValue({
        ...view,
        revision: 5,
        questions: [],
        lines: [item.storedLine as ImportSessionDraftLineV1],
      });
      await act(async () => {
        await result.current.saveFocusedDraft(item.accepted as never);
      });
      expect(mocks.answerImportFocusedDraftQuestion).toHaveBeenLastCalledWith(
        base.id,
        {
          version: 1,
          answerRequestId: expect.any(String),
          expectedRevision: 4,
          questionId: item.question.id,
          channel: "TEXT",
          answer: item.answer,
        },
        expect.any(AbortSignal),
      );
      expect(mocks.send).not.toHaveBeenCalled();
      unmount();
      mocks.answerImportFocusedDraftQuestion.mockClear();
    }
  });

  it("accepts a proven no-op without revision or expiry renewal", async () => {
    const view = { ...stored(), revision: 4, questions: base.questions };
    const { result } = setup(view);
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.answerImportFocusedDraftQuestion.mockResolvedValue(view);
    await act(async () => {
      await result.current.saveFocusedDraft(accepted);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.view?.revision).toBe(4);
    expect(result.current.view?.expiresAt).toBe(base.expiresAt);
  });

  it("does not send a same-tick duplicate save", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.answerImportFocusedDraftQuestion.mockResolvedValue(stored());
    await act(async () => {
      await Promise.all([
        result.current.saveFocusedDraft(accepted),
        result.current.saveFocusedDraft(accepted),
      ]);
    });
    expect(mocks.answerImportFocusedDraftQuestion).toHaveBeenCalledOnce();
  });
  it.each(["user", "session", "revision", "question"] as const)(
    "discards late answers after %s changes",
    async (kind) => {
      const { result, client, key, rerender } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));
      let resolve!: (view: ImportSessionViewV1) => void;
      mocks.answerImportFocusedDraftQuestion.mockReturnValue(
        new Promise<ImportSessionViewV1>((done) => {
          resolve = done;
        }),
      );
      let pending: Promise<unknown>;
      act(() => {
        pending = result.current.saveFocusedDraft(accepted);
      });
      if (kind === "user") {
        mocks.userId = "other";
        rerender(base.id);
      }
      if (kind === "session") rerender("other-session");
      if (kind === "revision")
        act(() => {
          client.setQueryData(key, { ...base, revision: 6 });
        });
      if (kind === "question")
        act(() => {
          client.setQueryData(key, {
            ...base,
            questions: [{ ...base.questions[0], lineIds: ["other"] }],
          });
        });
      await act(async () => {
        resolve(stored());
        await pending;
      });
      expect(client.getQueryData<ImportSessionViewV1>(key)?.revision).not.toBe(
        5,
      );
      expect(
        result.current.messages.some((m) => m.content.includes("guardada")),
      ).toBe(false);
    },
  );

  it("reads uncertain results once without false success or blind retry", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.getFullImportSession.mockClear();
    mocks.getFullImportSession.mockResolvedValue(stored());
    mocks.answerImportFocusedDraftQuestion.mockRejectedValue(
      new TypeError("Lost response"),
    );
    await act(async () => {
      await result.current.saveFocusedDraft(accepted);
    });
    expect(mocks.getFullImportSession).toHaveBeenCalledOnce();
    expect(mocks.answerImportFocusedDraftQuestion).toHaveBeenCalledOnce();
    expect(result.current.error).not.toBeNull();
    expect(
      result.current.messages.some((m) => m.content.includes("guardada")),
    ).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not route free text from an active import to the financial agent", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      await result.current.send("Minha resposta livre");
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.answerImportFocusedDraftQuestion).not.toHaveBeenCalled();
  });
});
