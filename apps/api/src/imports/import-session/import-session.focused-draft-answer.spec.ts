import { randomUUID } from "node:crypto";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  LaborCategory,
} from "@reformaflow/domain";
import { parseFocusedDraftAnswerRequest } from "./import-session.focused-draft-answer";

describe("focused draft answer request contract", () => {
  const base = {
    version: 1,
    answerRequestId: randomUUID(),
    expectedRevision: 7,
    questionId: "question-1",
    channel: "TEXT",
  } as const;

  it.each([
    {
      field: "amountMeaning",
      literal: "total da compra",
      value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    },
    { field: "amountCents", literal: "R$ 206,96", value: 20696 },
    { field: "installmentCount", literal: "3 parcelas", value: 3 },
    { field: "dataCompra", literal: "10/10/2026", value: "2026-10-10" },
    { field: "firstDueDate", literal: "05/11/2026", value: "2026-11-05" },
    { field: "tipoDespesa", value: ExpenseType.OUTROS },
    { field: "categoriaMaoDeObra", value: LaborCategory.PINTOR },
    {
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
    {
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: true },
    },
    {
      field: "decision",
      value: { kind: "KEEP_EXISTING", expenseId: "expense-1" },
    },
    { field: "targets", value: { kind: "NO_TARGETS" } },
    {
      field: "targets",
      value: {
        kind: "TARGET",
        projectId: "project-1",
        roomId: "room-1",
        amountCents: 20696,
        literal: "R$ 206,96",
      },
    },
  ])("accepts the strict $field union", (answer) => {
    expect(parseFocusedDraftAnswerRequest({ ...base, answer })).toMatchObject({
      ...base,
      answer,
    });
  });

  it.each([
    { channel: "MODEL" },
    { extra: true },
    {
      answer: {
        field: "amountCents",
        literal: "R$ 206,96",
        value: 20696,
        extra: true,
      },
    },
    {
      answer: {
        field: "amountCents",
        literal: "R$ 206,96 ou R$ 20,00",
        value: 20696,
      },
    },
    {
      answer: {
        field: "amountCents",
        literal: "R$ 206,96",
        value: 20695,
      },
    },
    {
      answer: {
        field: "targets",
        value: {
          kind: "TARGET",
          projectId: "project-1",
          roomId: null,
          amountCents: 20696,
          literal: "R$ 206,96",
          extra: true,
        },
      },
    },
    {
      answer: {
        field: "targets",
        value: {
          kind: "TARGET",
          projectId: "project-1",
          roomId: null,
          amountCents: 20696,
        },
      },
    },
    {
      answer: {
        field: "targets",
        value: {
          kind: "TARGET",
          projectId: "project-1",
          roomId: null,
          amountCents: 20696,
          literal: "R$ 206,95",
        },
      },
    },
    {
      answer: {
        field: "targets",
        value: {
          kind: "TARGET",
          projectId: "project-1",
          roomId: null,
          amountCents: 20696,
          literal: "R$ 206,96 ou R$ 206,96",
        },
      },
    },
    {
      answer: {
        field: "decision",
        value: {
          kind: "KEEP_EXISTING",
          expenseId: "expense-1",
          acceptNaturalDuplicate: true,
        },
      },
    },
  ])("rejects mismatched previews and unknown keys %#", (patch) => {
    expect(() =>
      parseFocusedDraftAnswerRequest({
        ...base,
        answer: { field: "tipoDespesa", value: ExpenseType.OUTROS },
        ...patch,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
