import { ExpenseType, type ImportSessionViewV1 } from "@reformaflow/domain";
import { describe, expect, it } from "vitest";
import { declarationViewFixture } from "./import-workflow-fixtures";
import { readImportWorkflowView } from "./import-session-workflow-read";

function guidedView(control: "EXPENSE_TYPE" | "TARGETS" = "EXPENSE_TYPE") {
  const view: ImportSessionViewV1 = declarationViewFixture();
  view.questions = [
    {
      id: "question-type",
      lineIds: ["first"],
      field: control === "TARGETS" ? "targets" : "tipoDespesa",
      text: "internal",
    },
  ];
  const amountCents = 20_696;
  return {
    ...view,
    guidedReview: {
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: {
        questionId: "question-type",
        lineId: "first",
        control,
        prompt: "Qual é o tipo de despesa?",
        context: {
          title: "Tinta para a sala",
          merchant: "Loja das Cores",
          amountCents,
          purchaseDate: "2026-10-08",
        },
        options:
          control === "TARGETS"
            ? [
                {
                  label: "Usar na reforma",
                  answer: {
                    kind: "TARGETS",
                    value: [
                      {
                        projectId: "reforma-project-internal",
                        roomId: "room-internal",
                        amountCents,
                      },
                    ],
                  },
                },
                {
                  label: "Manter somente na origem",
                  answer: { kind: "TARGETS", value: [] },
                },
              ]
            : [
                {
                  label: "Material de construção",
                  answer: {
                    kind: "EXPENSE_TYPE",
                    value: ExpenseType.MATERIAL_CONSTRUCAO,
                  },
                },
              ],
        purchaseOrdinal: 8,
        purchaseTotal: 13,
        questionOrdinal: 2,
        questionTotal: 4,
      },
    },
  };
}

describe("strict guided review session reader", () => {
  it("accepts the canonical flat domain-owned guided review", () => {
    const value = guidedView();
    expect(readImportWorkflowView(value).guidedReview).toEqual(
      value.guidedReview,
    );
  });

  it("accepts source-only and one integral target answers", () => {
    const value = guidedView("TARGETS");
    expect(readImportWorkflowView(value).guidedReview).toEqual(
      value.guidedReview,
    );
  });

  it.each(["ANSWERING", "READY", "READY_WITH_PENDING"] as const)(
    "accepts %s with no current focus",
    (progress) => {
      const value = guidedView();
      value.guidedReview.progress = progress;
      Object.assign(value.guidedReview, { focus: null });
      expect(readImportWorkflowView(value).guidedReview).toEqual(
        value.guidedReview,
      );
    },
  );

  it.each([
    (value: ReturnType<typeof guidedView>) => {
      Object.assign(value.guidedReview, { version: 1 });
    },
    (value: ReturnType<typeof guidedView>) => {
      value.guidedReview.focus = {
        question: { id: "question-type", label: "Old", ordinal: 1, total: 1 },
        line: { id: "first", ordinal: 1, total: 1, provenance: "Old" },
        control: {
          kind: "EXPENSE_TYPE",
          options: value.guidedReview.focus?.options ?? [],
        },
      } as never;
    },
    (value: ReturnType<typeof guidedView>) => {
      Object.assign(value.guidedReview.focus!, { provenance: "arquivo.csv" });
    },
    (value: ReturnType<typeof guidedView>) => {
      Object.assign(value.guidedReview.focus!.options[0], {
        projectLabel: "Projeto",
      });
    },
  ])("rejects old, nested or provenance-bearing shapes", (mutate) => {
    const value = guidedView();
    mutate(value);
    expect(() => readImportWorkflowView(value)).toThrow(
      "Unexpected import workflow response",
    );
  });

  it("accepts duplicate server option labels without exposing their IDs", () => {
    const value = guidedView("TARGETS");
    value.guidedReview.focus!.options[1].label =
      value.guidedReview.focus!.options[0].label;
    expect(readImportWorkflowView(value).guidedReview).toEqual(
      value.guidedReview,
    );
  });

  it("accepts an uppercase human project label", () => {
    const value = guidedView("TARGETS");
    value.guidedReview.focus!.options[0].label = "CASA";
    expect(readImportWorkflowView(value).guidedReview).toEqual(
      value.guidedReview,
    );
  });

  it("still rejects a request-id-looking option label", () => {
    const value = guidedView("TARGETS");
    value.guidedReview.focus!.options[0].label =
      "123e4567-e89b-42d3-a456-426614174000";
    expect(() => readImportWorkflowView(value)).toThrow(
      "Unexpected import workflow response",
    );
  });

  it("still rejects a target ID used as its visible label", () => {
    const value = guidedView("TARGETS");
    value.guidedReview.focus!.options[0].label = "reforma-project-internal";
    expect(() => readImportWorkflowView(value)).toThrow(
      "Unexpected import workflow response",
    );
  });

  it.each([
    ["purchaseOrdinal", 0],
    ["purchaseOrdinal", -1],
    ["purchaseOrdinal", 1.5],
    ["purchaseOrdinal", 14],
    ["purchaseTotal", 0],
    ["questionOrdinal", 0],
    ["questionOrdinal", 5],
    ["questionTotal", 0],
  ] as const)("rejects invalid %s bounds", (field, invalid) => {
    const value = guidedView();
    Object.assign(value.guidedReview.focus!, { [field]: invalid });
    expect(() => readImportWorkflowView(value)).toThrow(
      "Unexpected import workflow response",
    );
  });

  it.each([
    {
      name: "mismatched amount",
      value: [
        {
          projectId: "reforma-project-internal",
          roomId: null,
          amountCents: 20_695,
        },
      ],
    },
    {
      name: "two targets",
      value: [
        {
          projectId: "reforma-project-internal",
          roomId: null,
          amountCents: 20_696,
        },
        {
          projectId: "other-project-internal",
          roomId: null,
          amountCents: 20_696,
        },
      ],
    },
    {
      name: "partial target",
      value: [{ projectId: "reforma-project-internal" }],
    },
    {
      name: "zero amount",
      value: [
        {
          projectId: "reforma-project-internal",
          roomId: null,
          amountCents: 0,
        },
      ],
    },
    {
      name: "negative amount",
      value: [
        {
          projectId: "reforma-project-internal",
          roomId: null,
          amountCents: -1,
        },
      ],
    },
    {
      name: "fractional amount",
      value: [
        {
          projectId: "reforma-project-internal",
          roomId: null,
          amountCents: 20_696.5,
        },
      ],
    },
  ])("rejects $name TARGETS", ({ value: answerValue }) => {
    const value = guidedView("TARGETS");
    value.guidedReview.focus!.options[0].answer.value = answerValue as never;
    expect(() => readImportWorkflowView(value)).toThrow(
      "Unexpected import workflow response",
    );
  });

  it("keeps an absent guided review explicitly unavailable", () => {
    const value = declarationViewFixture();
    expect(readImportWorkflowView(value).guidedReview).toBeUndefined();
  });
});
