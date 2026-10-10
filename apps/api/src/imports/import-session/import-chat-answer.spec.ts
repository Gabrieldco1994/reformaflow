require("../../../../../scripts/test-db-env.cjs");

import { resolveImportAnswer } from "./import-chat-answer";
import { ExpenseType, LaborCategory } from "@reformaflow/domain";
import type {
  ImportSessionDraftLineV1,
  ImportSessionCandidateV1,
} from "@reformaflow/domain";

const line: ImportSessionDraftLineV1 = {
  id: "line",
  observationIds: ["observation"],
  titulo: "Compra",
  fornecedor: null,
  amountMeaning: "TOTAL_PURCHASE",
  amountCents: null,
  installmentCount: 1,
  dataCompra: "2026-10-01",
  firstDueDate: "2026-11-01",
  targets: null,
  decision: { kind: "UNRESOLVED" },
  tipoDespesa: null,
  categoriaMaoDeObra: null,
};
const question = { id: "q", field: "amountCents", lineIds: ["line"] } as const;
const money = (literal: string, text = literal, end = literal.length) => ({
  kind: "VALUE",
  field: "amountCents",
  evidence: { start: 0, end: literal.length },
  value: { span: { start: 0, end }, text },
});

describe("P08 literal interpretation, not documentary identity", () => {
  describe.each([
    {
      field: "tipoDespesa",
      value: ExpenseType.MAO_DE_OBRA,
      literal: "mão de obra",
      existing: { ...line, tipoDespesa: ExpenseType.MAO_DE_OBRA },
    },
    {
      field: "categoriaMaoDeObra",
      value: LaborCategory.PINTOR,
      literal: "pintor",
      existing: { ...line, categoriaMaoDeObra: LaborCategory.PINTOR },
    },
  ] as const)(
    "focused yes on $field",
    ({ field, value, literal, existing }) => {
      it.each(["sim", "Sim!"])(
        "does not invent a category from %s",
        (answer) => {
          expect(
            resolveImportAnswer(
              answer,
              field,
              {
                kind: "VALUE",
                field,
                evidence: { start: 0, end: answer.length },
                value,
              },
              [line],
            ),
          ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
        },
      );
      it("preserves an already-supported identical-value no-op without resolving a question", () => {
        expect(
          resolveImportAnswer(
            "sim",
            field,
            {
              kind: "VALUE",
              field,
              evidence: { start: 0, end: 3 },
              value,
            },
            [existing],
          ),
        ).toEqual({ kind: "VALUE", lines: [existing] });
      });
      it("still accepts an explicit category value", () => {
        expect(
          resolveImportAnswer(
            literal,
            field,
            {
              kind: "VALUE",
              field,
              evidence: { start: 0, end: literal.length },
              value,
            },
            [line],
          ),
        ).toEqual({ kind: "VALUE", lines: [existing] });
      });
    },
  );

  it.each([
    ["206,96", 20696],
    ["20.696,00", 2069600],
    ["1.500", 150000],
    ["206.96", 20696],
  ])("uses the original money token %s exactly", (literal, cents) => {
    expect(
      resolveImportAnswer(literal, question.field, money(literal), [line]),
    ).toEqual({
      kind: "VALUE",
      lines: [{ ...line, amountCents: cents }],
    });
    expect(line.amountCents).toBeNull();
  });
  it.each([
    ["206,96", money("206,96", "206", 3)],
    ["206,96", money("206,96", "20696")],
    ["200 ou 300", money("200 ou 300", "200", 3)],
    ["0", money("0")],
    ["-2", money("-2")],
    ["1e3", money("1e3")],
    ["0xFF", money("0xFF")],
  ])(
    "does not coerce or select a partial/ambiguous money token: %s",
    (literal, interpretation) => {
      expect(
        resolveImportAnswer(literal, question.field, interpretation, [line]),
      ).toMatchObject({
        kind: "CLARIFY",
      });
    },
  );
  it("does not interpret sim as an explicit duplicate opt-in", () => {
    expect(
      resolveImportAnswer(
        "sim",
        "decision",
        {
          kind: "VALUE",
          field: "decision",
          evidence: { start: 0, end: 3 },
          value: { kind: "CREATE", acceptNaturalDuplicate: true },
        },
        [line],
      ),
    ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
  });
  it.each(["sim", "Sim!"])(
    "focused yes does not become CREATE from %s without an unambiguous decision",
    (literal) => {
      expect(
        resolveImportAnswer(
          literal,
          "decision",
          {
            kind: "VALUE",
            field: "decision",
            evidence: { start: 0, end: literal.length },
            value: { kind: "CREATE", acceptNaturalDuplicate: false },
          },
          [line],
        ),
      ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
    },
  );
  it("does not mutate any field after a multi-field interpretation", () => {
    expect(
      resolveImportAnswer(
        "200 e muda a data",
        "amountCents",
        {
          kind: "MULTI_FIELD",
          fields: ["amountCents", "dataCompra"],
        },
        [line],
      ),
    ).toEqual({ kind: "CLARIFY", reason: "MULTI_FIELD" });
  });
  it.each(["sim", "total da parcela"])(
    "does not turn ambiguous meaning %s into a value",
    (literal) => {
      expect(
        resolveImportAnswer(
          literal,
          "amountMeaning",
          {
            kind: "VALUE",
            field: "amountMeaning",
            evidence: { start: 0, end: literal.length },
            value: "TOTAL_PURCHASE",
          },
          [line],
        ),
      ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
    },
  );
  it.each(["1e3", "x20", "- 20", "20 + 3"])(
    "rejects a numeric substring from %s",
    (literal) => {
      const start = literal.indexOf("20") >= 0 ? literal.indexOf("20") : 0;
      const text = literal.slice(start, start + (literal === "1e3" ? 1 : 2));
      expect(
        resolveImportAnswer(
          literal,
          "amountCents",
          {
            kind: "VALUE",
            field: "amountCents",
            evidence: { start: 0, end: literal.length },
            value: { text, span: { start, end: start + text.length } },
          },
          [line],
        ),
      ).toMatchObject({ kind: "CLARIFY" });
    },
  );
  it("does not accept KEEP_EXISTING without an authorized current-line EXPENSE candidate", () => {
    expect(
      resolveImportAnswer(
        "manter compra",
        "decision",
        {
          kind: "VALUE",
          field: "decision",
          evidence: { start: 0, end: 13 },
          value: { kind: "KEEP_EXISTING", expenseId: "expense" },
        },
        [line],
      ),
    ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
  });
  it("does not accept a target ID without a resolved authorized catalog reference", () => {
    expect(
      resolveImportAnswer(
        "Reforma",
        "targets",
        {
          kind: "VALUE",
          field: "targets",
          evidence: { start: 0, end: 7 },
          value: {
            kind: "TARGETS",
            items: [
              {
                projectId: "p1",
                roomId: null,
                amount: { kind: "SOURCE_TOTAL" },
              },
            ],
          },
        },
        [{ ...line, amountCents: 20000 }],
      ),
    ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
  });
  it("accepts KEEP_EXISTING only for every affected line's current eligible expense", () => {
    const candidate: ImportSessionCandidateV1 = {
      lineId: "line",
      kind: "EXPENSE",
      id: "expense",
      projectId: "project",
      description: "Compra",
      amountCents: 20000,
      date: "2026-10-01",
      reason: "STRONG_IDENTITY",
      canKeepExisting: true,
    };
    const interpretation = {
      kind: "VALUE",
      field: "decision",
      evidence: { start: 0, end: 13 },
      value: { kind: "KEEP_EXISTING", expenseId: "expense" },
    };
    expect(
      resolveImportAnswer("manter compra", "decision", interpretation, [line], {
        projects: [],
        candidates: [candidate],
      }),
    ).toMatchObject({
      kind: "VALUE",
      lines: [{ decision: interpretation.value }],
    });
    for (const changed of [
      { ...candidate, lineId: "other" },
      { ...candidate, canKeepExisting: false },
      { ...candidate, kind: "RECEIPT" as const },
    ])
      expect(
        resolveImportAnswer(
          "manter compra",
          "decision",
          interpretation,
          [line],
          {
            projects: [],
            candidates: [changed],
          },
        ),
      ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
  });
  it("resolves unique named targets and rooms but never homonyms or an ID used as a name", () => {
    const interpretation = {
      kind: "VALUE",
      field: "targets",
      evidence: { start: 0, end: 16 },
      value: {
        kind: "TARGETS",
        items: [
          { projectId: "p1", roomId: "r1", amount: { kind: "SOURCE_TOTAL" } },
        ],
      },
    };
    const project = {
      id: "p1",
      name: "Casa",
      rooms: [{ id: "r1", name: "Cozinha" }],
    };
    const projects = [project];
    expect(
      resolveImportAnswer(
        "Casa na Cozinha!",
        "targets",
        interpretation,
        [{ ...line, amountCents: 20000 }],
        { projects, candidates: [] },
      ),
    ).toMatchObject({
      kind: "VALUE",
      lines: [
        { targets: [{ projectId: "p1", roomId: "r1", amountCents: 20000 }] },
      ],
    });
    for (const projects of [
      [project, { ...project, id: "p2" }],
      [project, { ...project, id: "Casa", name: "Outro" }],
      [{ ...project, rooms: [] }],
    ])
      expect(
        resolveImportAnswer(
          "Casa na Cozinha!",
          "targets",
          interpretation,
          [{ ...line, amountCents: 20000 }],
          { projects, candidates: [] },
        ),
      ).toEqual({
        kind: "CLARIFY",
        reason: "AMBIGUOUS",
      });
    expect(
      resolveImportAnswer(
        "Casa na Cozinha!",
        "targets",
        interpretation,
        [
          { ...line, amountCents: 20000 },
          {
            ...line,
            id: "second",
            amountCents: 10000,
            amountMeaning: "INSTALLMENT_CHARGE",
          },
        ],
        { projects, candidates: [] },
      ),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
  });
});
