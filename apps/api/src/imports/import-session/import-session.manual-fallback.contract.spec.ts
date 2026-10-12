import { randomUUID } from "node:crypto";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  LaborCategory,
} from "@reformaflow/domain";
import { ImportSessionError } from "./import-session.errors";
import {
  focusedDraftAnswerScope,
  parseFocusedDraftAnswerRequest,
} from "./import-session.focused-draft-answer";

type Channel = "TEXT" | "VOICE";

const base = {
  version: 1,
  answerRequestId: "10000000-0000-4000-8000-000000000001",
  expectedRevision: 7,
  questionId: "question-current",
} as const;

function request(answer: Record<string, unknown>, channel: Channel = "TEXT") {
  return { ...base, channel, answer };
}

const accepted = [
  request({
    field: "amountMeaning",
    literal: "total da compra",
    value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
  }),
  request({ field: "amountCents", literal: "R$ 206,96", value: 20696 }),
  request({ field: "installmentCount", literal: "6 parcelas", value: 6 }),
  request({
    field: "dataCompra",
    literal: "29/02/2028",
    value: "2028-02-29",
  }),
  request({
    field: "firstDueDate",
    literal: "10/10/2026",
    value: "2026-10-10",
  }),
  request({ field: "tipoDespesa", value: ExpenseType.OUTROS }),
  request({
    field: "categoriaMaoDeObra",
    value: LaborCategory.PINTOR,
  }),
  request({
    field: "decision",
    value: { kind: "CREATE", acceptNaturalDuplicate: true },
  }),
  request({
    field: "decision",
    value: { kind: "KEEP_EXISTING", expenseId: "candidate-current" },
  }),
  request({ field: "targets", value: { kind: "NO_TARGETS" } }),
  request(
    {
      field: "targets",
      value: {
        kind: "TARGET",
        projectId: "project-reforma",
        roomId: "room-reforma",
        amountCents: 20696,
        literal: "206,96",
      },
    },
    "VOICE",
  ),
] as const;

describe("deterministic manual focused PATCH contract", () => {
  it.each(accepted)(
    "accepts the exact literal plus typed preview for $answer.field",
    (body) => {
      const parsed = parseFocusedDraftAnswerRequest(body);
      expect(parsed).toEqual(body);
      expect(Object.keys(parsed)).toEqual([
        "version",
        "answerRequestId",
        "expectedRevision",
        "questionId",
        "channel",
        "answer",
      ]);
      expect(focusedDraftAnswerScope("session-current", parsed)).toEqual({
        operation: "FOCUSED_DRAFT_ANSWER",
        sessionId: "session-current",
        expectedRevision: 7,
        questionId: "question-current",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    },
  );

  it.each([
    { ...accepted[1], extra: true },
    { ...accepted[1], input: { channel: "TEXT", text: "R$ 206,96" } },
    { ...accepted[1], answer: { ...accepted[1].answer, extra: true } },
    { ...accepted[1], channel: "voice" },
    request({ field: "amountCents", literal: "", value: 20696 }),
    request({
      field: "amountCents",
      literal: "R$ 206,96 ou R$ 20,00",
      value: 20696,
    }),
    request({
      field: "amountCents",
      literal: "R$ 206,96",
      value: 20695,
    }),
    request({
      field: "installmentCount",
      literal: "6 parcelas",
      value: 5,
    }),
    request({
      field: "firstDueDate",
      literal: "10/10/2026",
      value: "2026-10-11",
    }),
    request({ field: "tipoDespesa", value: "outros" }),
    request({
      field: "categoriaMaoDeObra",
      value: "pedreiro",
    }),
    request({
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: "yes" },
    }),
    request({
      field: "decision",
      value: { kind: "KEEP_EXISTING", expenseId: "" },
    }),
    request({
      field: "targets",
      value: {
        kind: "TARGET",
        projectId: "project-reforma",
        roomId: null,
        amountCents: 206.96,
        literal: "206,96",
      },
    }),
    request({
      field: "targets",
      value: {
        kind: "TARGET",
        projectId: "project-reforma",
        roomId: null,
        amountCents: 20696,
      },
    }),
    request({
      field: "targets",
      value: {
        kind: "TARGET",
        projectId: "project-reforma",
        roomId: null,
        amountCents: 20696,
        literal: "206,95",
      },
    }),
    request({
      field: "targets",
      value: {
        kind: "TARGET",
        projectId: "project-reforma",
        roomId: null,
        amountCents: 20696,
        literal: "206,96",
        extra: true,
      },
    }),
  ])("rejects malformed union member %# before issuing a grant", (body) => {
    expect(() => parseFocusedDraftAnswerRequest(body)).toThrow(
      ImportSessionError,
    );
  });

  it("binds the opaque UI grant hash to literal, channel and preview independently", () => {
    const parsed = parseFocusedDraftAnswerRequest(accepted[1]);
    const hashes = [
      parsed,
      { ...parsed, channel: "VOICE" as const },
      {
        ...parsed,
        answer: { ...parsed.answer, literal: "R$ 206,97" },
      },
      {
        ...parsed,
        answer: { ...parsed.answer, value: 20697 },
      },
      { ...parsed, answerRequestId: randomUUID() },
    ].map(
      (body) =>
        focusedDraftAnswerScope("session-current", body as typeof parsed)
          .requestHash,
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
