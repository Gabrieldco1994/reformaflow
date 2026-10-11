import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeImportDeclaration,
  type ImportDeclarationAnswerV1,
  type ImportDeclarationUiInputV1,
  type ImportObservationQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { useImportConversation } from "./useImportConversation";
import { importRoot } from "../_lib/import-session-keys";
import { importDeclarationContext } from "../_lib/import-session-read";
import { ApiResponseError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  userId: "user-1",
  getFullImportSession: vi.fn(),
  answerImportDocumentaryQuestion: vi.fn(),
  editImportSession: vi.fn(),
  getImportResult: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../_lib/import-session-api", () => ({
  getFullImportSession: mocks.getFullImportSession,
  answerImportDocumentaryQuestion: mocks.answerImportDocumentaryQuestion,
  editImportSession: mocks.editImportSession,
  getImportResult: mocks.getImportResult,
}));
vi.mock("./useImportSessions", () => ({
  useImportUserId: () => mocks.userId,
}));
vi.mock("@/components/agent/useFinancialAgent", () => ({
  useFinancialAgent: () => ({ send: mocks.send }),
}));

const question: ImportObservationQuestionV1 = {
  id: "oq-merchant",
  lineIds: ["line-1"],
  field: "merchant",
  text: "Qual estabelecimento?",
  subject: {
    kind: "OBSERVATION",
    observationId: "observation-1",
    meaningContext: null,
  },
  answerState: "UNANSWERED",
};
const input: ImportDeclarationUiInputV1 = {
  kind: "VALUE",
  text: "  LOJA FICTICIA NORTE  ",
};
const answer: ImportDeclarationAnswerV1 = {
  field: "merchant",
  meaningContext: null,
  value: "LOJA FICTICIA NORTE",
};
const encoded = encodeImportDeclaration(
  { field: "merchant", meaningContext: null, effectiveInstallmentCount: null },
  input,
);
if (encoded.kind !== "ENCODED") throw new Error("Invalid fixture");
const accepted = {
  id: question.id,
  text: encoded.literalAnswer,
  input,
  answer,
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
  lines: [],
  selectedLineIds: [],
  questions: [question],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["RESOLVE", "CANCEL"],
};
const stored = (): ImportSessionViewV1 => ({
  ...base,
  revision: 5,
  questions: [{ ...question, answerState: "DECLARED" }],
  declaredFacts: [
    {
      questionId: question.id,
      lineId: "line-1",
      observationId: "observation-1",
      origin: "USER_ATTESTATION",
      ...answer,
      status: "CURRENT",
      value: "LOJA FICTICIA NORTE",
    },
  ],
});
function setup(view = base, initialChannel: "TEXT" | "VOICE" = "TEXT") {
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
    (props: { sessionId: string; initialChannel: "TEXT" | "VOICE" }) =>
      useImportConversation(props.sessionId, false, props.initialChannel),
    {
      wrapper,
      initialProps: { sessionId: view.id, initialChannel },
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

describe("native documentary preview contract", () => {
  const explicitCases: {
    question: ImportObservationQuestionV1;
    text: string;
    answer: ImportDeclarationAnswerV1;
  }[] = [
    {
      question: { ...question, field: "dataCompra" },
      text: "2025-09-01",
      answer: {
        field: "dataCompra",
        meaningContext: null,
        value: "2025-09-01",
      },
    },
    {
      question: {
        ...question,
        field: "amountCents",
        subject: { ...question.subject, meaningContext: "TOTAL_PURCHASE" },
      },
      text: "1.234,56",
      answer: {
        field: "amountCents",
        meaningContext: "TOTAL_PURCHASE",
        value: 123456,
      },
    },
    {
      question: {
        ...question,
        field: "amountCents",
        subject: { ...question.subject, meaningContext: "INSTALLMENT_CHARGE" },
      },
      text: "50,00",
      answer: {
        field: "amountCents",
        meaningContext: "INSTALLMENT_CHARGE",
        value: 5000,
      },
    },
    {
      question: { ...question, field: "amountMeaning" },
      text: "valor da parcela",
      answer: {
        field: "amountMeaning",
        meaningContext: null,
        value: "INSTALLMENT_CHARGE",
      },
    },
    {
      question: { ...question, field: "installmentCount" },
      text: "3",
      answer: { field: "installmentCount", meaningContext: null, value: 3 },
    },
    {
      question: { ...question, field: "installmentIndex" },
      text: "2",
      answer: { field: "installmentIndex", meaningContext: null, value: 2 },
    },
  ];
  it.each(explicitCases)(
    "uses native transport for explicit $question.field ($text)",
    async ({ question: focused, text, answer }) => {
      const view = { ...base, questions: [focused] };
      const { result } = setup(view);
      await waitFor(() => expect(result.current.busy).toBe(false));
      const input: ImportDeclarationUiInputV1 = { kind: "VALUE", text };
      const encoded = encodeImportDeclaration(
        importDeclarationContext(focused),
        input,
      );
      if (encoded.kind !== "ENCODED") throw new Error("Invalid case");
      mocks.answerImportDocumentaryQuestion.mockResolvedValue({
        ...view,
        revision: 5,
        declaredFacts: [
          {
            questionId: focused.id,
            lineId: focused.lineIds[0],
            observationId: focused.subject.observationId,
            origin: "USER_ATTESTATION",
            status: "CURRENT",
            ...answer,
          },
        ],
      });
      await act(async () => {
        await result.current.saveDeclaration({
          id: focused.id,
          text: encoded.literalAnswer,
          input,
          answer,
        });
      });
      expect(mocks.answerImportDocumentaryQuestion).toHaveBeenCalledWith(
        base.id,
        expect.objectContaining({
          questionId: focused.id,
          channel: "TEXT",
          input,
          answer,
        }),
        expect.any(AbortSignal),
      );
      expect(result.current.error).toBeNull();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each(["UNKNOWN", "REMOVE"] as const)(
    "preserves explicit %s preview semantics without inventing a value",
    async (kind) => {
      const { result } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));
      const nullAnswer: ImportDeclarationAnswerV1 = {
        field: "merchant",
        meaningContext: null,
        value: null,
      };
      mocks.answerImportDocumentaryQuestion.mockResolvedValue({
        ...base,
        revision: 5,
        declaredFacts: [
          {
            ...stored().declaredFacts[0],
            status: "UNKNOWN",
            value: null,
          },
        ],
      });
      await act(async () => {
        await result.current.saveDeclaration({
          id: question.id,
          text: "",
          input: { kind },
          answer: nullAnswer,
        });
      });
      expect(mocks.answerImportDocumentaryQuestion).toHaveBeenCalledWith(
        base.id,
        expect.objectContaining({
          channel: "TEXT",
          input: { kind },
          answer: nullAnswer,
        }),
        expect.any(AbortSignal),
      );
      expect(result.current.error).toBeNull();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("save_preview_uses_native_endpoint_not_agent_chat and sends_exact_input_and_accepted_preview_answer", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.answerImportDocumentaryQuestion.mockResolvedValue(stored());
    await act(async () => {
      await result.current.saveDeclaration(accepted);
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.answerImportDocumentaryQuestion).toHaveBeenCalledOnce();
    const [id, request, signal] =
      mocks.answerImportDocumentaryQuestion.mock.calls[0];
    expect(id).toBe(base.id);
    expect(request).toEqual({
      version: 1,
      answerRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedRevision: 4,
      questionId: question.id,
      channel: "TEXT",
      input,
      answer,
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(result.current.error).toBeNull();
    expect(result.current.view?.revision).toBe(5);
    expect(result.current.review).toBe(false);
    expect(mocks.editImportSession).not.toHaveBeenCalled();
  });

  it.each([
    "lineId",
    "observationId",
    "questionId",
    "value",
    "field",
    "meaningContext",
    "status",
  ] as const)(
    "rejects_response_with_wrong_fact_or_subject: %s",
    async (field) => {
      const { result, client, key } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));
      const wrong = stored();
      mocks.answerImportDocumentaryQuestion.mockResolvedValue({
        ...wrong,
        declaredFacts: [{ ...wrong.declaredFacts[0], [field]: "wrong" }],
      });
      mocks.getFullImportSession.mockResolvedValue(base);
      await act(async () => {
        await result.current.saveDeclaration(accepted);
      });
      expect(result.current.error).not.toBeNull();
      expect(
        result.current.messages.some((m) => m.content.includes("guardada")),
      ).toBe(false);
      expect(client.getQueryData(key)).toEqual(base);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("rejects an answer differing from the accepted input before sending", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      await result.current.saveDeclaration({
        ...accepted,
        answer: { ...answer, value: "OTHER" },
      });
    });
    expect(mocks.answerImportDocumentaryQuestion).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(result.current.error).not.toBeNull();
  });

  it("accepts no-op only with an already matching fact and unchanged expiry", async () => {
    const current = { ...stored(), revision: 4 };
    const { result } = setup(current);
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => {
      result.current.editQuestion(question.id);
    });
    mocks.answerImportDocumentaryQuestion.mockResolvedValue(current);
    await act(async () => {
      await result.current.saveDeclaration(accepted);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.view?.revision).toBe(4);
    expect(result.current.messages.at(-1)?.content).toContain(
      "Nenhuma alteração",
    );
  });

  it.each(["missingPrevious", "renewedExpiry", "skippedRevision"] as const)(
    "rejects unproven acknowledgment: %s",
    async (kind) => {
      const view =
        kind === "missingPrevious" ? base : { ...stored(), revision: 4 };
      const { result } = setup(view);
      await waitFor(() => expect(result.current.busy).toBe(false));
      act(() => {
        result.current.editQuestion(question.id);
      });
      mocks.answerImportDocumentaryQuestion.mockResolvedValue({
        ...stored(),
        revision: kind === "skippedRevision" ? 6 : 4,
        expiresAt:
          kind === "renewedExpiry"
            ? "2026-10-17T21:00:00.000Z"
            : base.expiresAt,
      });
      mocks.getFullImportSession.mockResolvedValue(view);
      await act(async () => {
        await result.current.saveDeclaration(accepted);
      });
      expect(result.current.error).not.toBeNull();
      expect(
        result.current.messages.some((m) => m.content.includes("guardada")),
      ).toBe(false);
    },
  );

  it("discards a late response when question subject changes at the same revision", async () => {
    const { result, client, key } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    let resolve!: (view: ImportSessionViewV1) => void;
    mocks.answerImportDocumentaryQuestion.mockReturnValue(
      new Promise<ImportSessionViewV1>((done) => {
        resolve = done;
      }),
    );
    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.saveDeclaration(accepted);
    });
    const changed = {
      ...base,
      questions: [
        {
          ...question,
          subject: { ...question.subject, observationId: "another" },
        },
      ],
    };
    act(() => {
      client.setQueryData(key, changed);
    });
    await act(async () => {
      resolve(stored());
      await pending;
    });
    expect(client.getQueryData(key)).toEqual(changed);
    expect(result.current.error).not.toBeNull();
    expect(
      result.current.messages.some((m) => m.content.includes("guardada")),
    ).toBe(false);
  });

  it.each([401, 403, 404])(
    "revokes private context on %s without recovery GET",
    async (status) => {
      const { result } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));
      mocks.getFullImportSession.mockClear();
      mocks.answerImportDocumentaryQuestion.mockRejectedValue(
        new ApiResponseError("Unavailable", status),
      );
      await act(async () => {
        await result.current.saveDeclaration(accepted);
      });
      expect(mocks.getFullImportSession).not.toHaveBeenCalled();
      expect(result.current.error?.privateContextLost).toBe(true);
      expect(result.current.view).toBeNull();
    },
  );
  it.each(["user", "session", "revision"] as const)(
    "user_switch_or_new_revision_discards_late_response: %s",
    async (change) => {
      const { result, client, key, rerender } = setup();
      await waitFor(() => expect(result.current.busy).toBe(false));
      let resolve!: (view: ImportSessionViewV1) => void;
      mocks.answerImportDocumentaryQuestion.mockReturnValue(
        new Promise<ImportSessionViewV1>((done) => {
          resolve = done;
        }),
      );
      let pending: Promise<unknown>;
      act(() => {
        pending = result.current.saveDeclaration(accepted);
      });
      if (change === "user") {
        mocks.userId = "user-2";
        rerender({ sessionId: base.id, initialChannel: "TEXT" });
      } else if (change === "session") {
        rerender({ sessionId: "session-2", initialChannel: "TEXT" });
      } else {
        act(() => {
          client.setQueryData(key, { ...base, revision: 6 });
        });
      }
      if (change !== "revision")
        expect(
          mocks.answerImportDocumentaryQuestion.mock.calls[0][2].aborted,
        ).toBe(true);
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

  it("uncertain_response_reads_state_without_false_success or blind retry", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.getFullImportSession.mockClear();
    mocks.getFullImportSession.mockResolvedValue(stored());
    mocks.answerImportDocumentaryQuestion.mockRejectedValue(
      new TypeError("Lost response"),
    );
    await act(async () => {
      await result.current.saveDeclaration(accepted);
    });
    expect(mocks.getFullImportSession).toHaveBeenCalledOnce();
    expect(mocks.answerImportDocumentaryQuestion).toHaveBeenCalledOnce();
    expect(result.current.error).not.toBeNull();
    expect(
      result.current.messages.some((m) => m.content.includes("guardada")),
    ).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("free text in an active import never uses the LLM path", async () => {
    const view: ImportSessionViewV1 = { ...base, questions: [] };
    const { result } = setup(view);
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      await result.current.send("Como funciona esta importação?");
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.answerImportDocumentaryQuestion).not.toHaveBeenCalled();
  });

  it("sends voice provenance to the direct endpoint and manual editing resets it to TEXT", async () => {
    const { result } = setup(base, "VOICE");
    await waitFor(() => expect(result.current.busy).toBe(false));
    mocks.answerImportDocumentaryQuestion.mockResolvedValue(stored());
    await act(async () => {
      await result.current.saveDeclaration(accepted);
    });
    expect(
      mocks.answerImportDocumentaryQuestion.mock.calls.at(-1)?.[1].channel,
    ).toBe("VOICE");

    const second = setup(base, "VOICE");
    await waitFor(() => expect(second.result.current.busy).toBe(false));
    mocks.answerImportDocumentaryQuestion.mockResolvedValue(stored());
    await act(async () => {
      second.result.current.setLiteral("LOJA FICTICIA NORTE");
    });
    await act(async () => {
      await second.result.current.saveDeclaration(accepted);
    });
    expect(
      mocks.answerImportDocumentaryQuestion.mock.calls.at(-1)?.[1].channel,
    ).toBe("TEXT");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
