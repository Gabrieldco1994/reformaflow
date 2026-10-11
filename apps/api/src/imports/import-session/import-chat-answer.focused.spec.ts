import {
  ImportSessionAmountMeaning,
  type ImportChatTurnV1,
  type ImportFocusV1,
  type ImportSessionDraftLineV1,
} from "@reformaflow/domain";
import {
  ImportChatContractError,
  parseImportToolArguments,
} from "../../agent/import-chat.contract";
import { importAnswerToolDefinitions } from "../../agent/import-chat.prompt";
import {
  resolveImportAnswer,
  resolveImportDocumentaryAnswer,
} from "./import-chat-answer";

const line: ImportSessionDraftLineV1 = {
  id: "line-1",
  observationIds: ["observation-1"],
  titulo: "Compra",
  fornecedor: null,
  tipoDespesa: null,
  categoriaMaoDeObra: null,
  amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
  amountCents: 12500,
  installmentCount: null,
  dataCompra: "2028-01-10",
  firstDueDate: null,
  targets: null,
  decision: { kind: "UNRESOLVED" },
};

const turnFor = (field: ImportFocusV1["field"]): ImportChatTurnV1 => ({
  version: 1,
  turnId: "7eab1a79-3a18-40fa-a8ce-2c66d947cc31",
  sessionId: "session-1",
  expectedRevision: 7,
  channel: "TEXT",
  intent: "ANSWER",
  literalAnswer: "resposta",
  focus: { id: "question-1", field, lineIds: ["line-1"] },
  scope: { kind: "LINES", lineIds: ["line-1"] },
});

const parseFocused = (field: ImportFocusV1["field"], value: unknown) =>
  (
    parseImportToolArguments as unknown as (
      name: string,
      args: unknown,
      focus: ImportFocusV1["field"],
    ) => unknown
  )("import_edit_answer", value, field);

const resolve = (
  literal: string,
  field: Parameters<typeof resolveImportAnswer>[1],
  answer: unknown,
) => resolveImportAnswer(literal, field, answer, [line]);

describe("one-shot focused import answer contract", () => {
  it.each<ImportFocusV1["field"]>([
    "amountMeaning",
    "amountCents",
    "installmentCount",
    "merchant",
    "installmentIndex",
    "dataCompra",
    "firstDueDate",
    "targets",
    "decision",
    "tipoDespesa",
    "categoriaMaoDeObra",
  ])("generates a flat schema from the authenticated %s focus", (field) => {
    const definition = importAnswerToolDefinitions(turnFor(field)).find(
      (tool) => tool.name === "import_edit_answer",
    );
    expect(definition).toBeDefined();
    const encoded = JSON.stringify(definition!.parameters);
    for (const forbidden of [
      '"interpretation"',
      '"field"',
      '"evidence"',
      '"span"',
      '"start"',
      '"end"',
      '"value"',
    ])
      expect(encoded).not.toContain(forbidden);
    expect(encoded).toContain('"kind"');
    expect(encoded).toContain('"answer"');
    expect(encoded).toContain("NO_DECISION");
    expect(encoded).toContain("VALUE");
  });

  it.each<ImportFocusV1["field"]>([
    "amountMeaning",
    "amountCents",
    "installmentCount",
    "installmentIndex",
    "dataCompra",
    "firstDueDate",
  ])(
    "accepts only null model answers for deterministic %s parsing",
    (field) => {
      expect(() =>
        parseFocused(field, { kind: "VALUE", answer: null }),
      ).not.toThrow();
      expect(() => parseFocused(field, { kind: "VALUE", answer: 123 })).toThrow(
        ImportChatContractError,
      );
    },
  );

  it("rejects both legacy nested and legacy flat payloads", () => {
    expect(() =>
      parseFocused("amountCents", {
        interpretation: {
          kind: "VALUE",
          field: "amountCents",
          evidence: { start: 0, end: 7 },
          value: {
            span: { start: 0, end: 7 },
            text: "R$ 1,00",
          },
        },
      }),
    ).toThrow("MODEL_OUTPUT_INVALID");
    expect(() =>
      parseFocused("amountCents", {
        kind: "VALUE",
        field: "amountCents",
        answer: null,
      }),
    ).toThrow("MODEL_OUTPUT_INVALID");
  });

  it("returns a strict payload that remains valid at the execution boundary", () => {
    const parsed = parseImportToolArguments(
      "import_edit_answer",
      { kind: "VALUE", answer: null },
      "firstDueDate",
    );
    expect(parsed.name).toBe("import_edit_answer");
    if (parsed.name !== "import_edit_answer") throw new Error("test contract");
    expect(parsed.arguments).toEqual({ kind: "VALUE", answer: null });
    expect(Object.keys(parsed.arguments)).toEqual(["kind", "answer"]);
    expect(() =>
      parseImportToolArguments(
        "import_edit_answer",
        parsed.arguments,
        "firstDueDate",
      ),
    ).not.toThrow();
  });

  it("keeps merchant, enum, decision and target answer schemas strict", () => {
    expect(() =>
      parseFocused("merchant", { kind: "VALUE", answer: "Loja Azul" }),
    ).not.toThrow();
    expect(() =>
      parseFocused("tipoDespesa", { kind: "VALUE", answer: "OUTROS" }),
    ).not.toThrow();
    expect(() =>
      parseFocused("tipoDespesa", { kind: "VALUE", answer: "outros" }),
    ).toThrow("MODEL_OUTPUT_INVALID");
    expect(() =>
      parseFocused("decision", { kind: "VALUE", answer: "CREATE" }),
    ).not.toThrow();
    expect(() =>
      parseFocused("targets", { kind: "VALUE", answer: "NO_TARGETS" }),
    ).not.toThrow();
    expect(() =>
      parseFocused("targets", {
        kind: "VALUE",
        answer: [
          { projectId: "project-1", roomId: null, amountText: "R$ 125,00" },
          { projectId: "project-1", roomId: null, amountText: null },
        ],
      }),
    ).toThrow("MODEL_OUTPUT_INVALID");
    expect(() =>
      parseFocused("targets", { kind: "VALUE", answer: [] }),
    ).toThrow("MODEL_OUTPUT_INVALID");
  });
});

describe("deterministic focused import answer resolution", () => {
  const value = { kind: "VALUE", answer: null };

  it.each([
    ["Anote exatamente R$ 0,07", 7],
    ["O lançamento correto é R$ 8.765,43", 876543],
    ["🧾 Informe R$ 7,09", 709],
  ])("extracts one smallest monetary token from %s", (literal, cents) => {
    const result = resolve(literal, "amountCents", value);
    expect(result).toEqual({
      kind: "VALUE",
      lines: [{ ...line, amountCents: cents }],
    });
    expect(line.amountCents).toBe(12500);
  });

  it.each([
    "Pode ser R$ 41,20 ou R$ 42,10",
    "Custou R$ 0,00",
    "Custou R$ 99.999.999,99",
    "Sem valor monetário",
  ])(
    "clarifies zero, multiple, absent or out-of-range money: %s",
    (literal) => {
      expect(resolve(literal, "amountCents", value)).toEqual({
        kind: "CLARIFY",
        reason: "INVALID_VALUE",
      });
    },
  );

  it("finds only the focused installment token despite unrelated money", () => {
    expect(
      resolve(
        "São 6 parcelas; altere também o total para R$ 900,00",
        "installmentCount",
        value,
      ),
    ).toEqual({
      kind: "VALUE",
      lines: [{ ...line, installmentCount: 6 }],
    });
    expect(resolve("Divida em 0 parcelas", "installmentCount", value)).toEqual({
      kind: "CLARIFY",
      reason: "INVALID_VALUE",
    });
  });

  it.each([
    ["A primeira vence em 29/02/2028", "firstDueDate", "2028-02-29"],
    ["Data da compra: 2028-02-29", "dataCompra", "2028-02-29"],
  ] as const)(
    "normalizes one calendar token from %s",
    (literal, field, date) => {
      expect(resolve(literal, field, value)).toEqual({
        kind: "VALUE",
        lines: [{ ...line, [field]: date }],
      });
    },
  );

  it.each([
    ["Vencimento em 31/02/2028", "firstDueDate"],
    ["Foi em 03/04/2028, talvez 04/03/2028", "dataCompra"],
    ["Foi em 01/01/2200", "dataCompra"],
  ] as const)(
    "clarifies invalid, multiple or out-of-range date %s",
    (literal, field) => {
      expect(resolve(literal, field, value)).toEqual({
        kind: "CLARIFY",
        reason: "INVALID_VALUE",
      });
    },
  );

  it("derives amount meaning from exactly one smallest phrase", () => {
    expect(
      resolve("Representa o total integral da compra", "amountMeaning", value),
    ).toEqual({
      kind: "VALUE",
      lines: [
        { ...line, amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE },
      ],
    });
    expect(
      resolve("Pode ser o total ou uma parcela", "amountMeaning", value),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
  });

  it("requires an exact unique merchant substring and emits a canonical documentary literal", () => {
    const answer = { kind: "VALUE", answer: "Loja Azul" };
    expect(
      resolveImportDocumentaryAnswer(
        "Foi na Loja Azul ontem",
        "merchant",
        answer,
      ),
    ).toEqual({ kind: "VALUE", literal: '"Loja Azul"' });
    expect(
      resolveImportDocumentaryAnswer(
        "Loja Azul e depois Loja Azul",
        "merchant",
        answer,
      ),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
  });

  it("extracts documentary installment index without exposing a model offset", () => {
    expect(
      resolveImportDocumentaryAnswer(
        "🧾 corresponde à 3ª parcela",
        "installmentIndex",
        value,
      ),
    ).toEqual({ kind: "VALUE", literal: "3" });
  });

  it("accepts a live authorized decision ID and rejects the same unlisted ID", () => {
    const answer = { kind: "VALUE", answer: "expense-1" };
    expect(
      resolveImportAnswer("manter a compra encontrada", "decision", answer, [
        line,
      ]),
    ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
    expect(
      resolveImportAnswer(
        "manter a compra encontrada",
        "decision",
        answer,
        [line],
        {
          projects: [],
          candidates: [
            {
              id: "expense-1",
              lineId: line.id,
              kind: "EXPENSE",
              projectId: "project-1",
              description: "Compra existente",
              amountCents: 12500,
              date: "2028-01-10",
              reason: "NATURAL_MATCH",
              canKeepExisting: true,
            },
          ],
        },
      ),
    ).toEqual({
      kind: "VALUE",
      lines: [
        {
          ...line,
          decision: { kind: "KEEP_EXISTING", expenseId: "expense-1" },
        },
      ],
    });
  });

  it("reauthorizes target IDs and derives each documentary allocation amount", () => {
    const answer = {
      kind: "VALUE",
      answer: [
        {
          projectId: "project-1",
          roomId: "room-1",
          amountText: "R$ 125,00",
        },
      ],
    };
    expect(
      resolveImportAnswer(
        "Projeto Aurora, Cozinha: R$ 125,00",
        "targets",
        answer,
        [line],
        {
          projects: [
            {
              id: "project-1",
              name: "Projeto Aurora",
              rooms: [{ id: "room-1", name: "Cozinha" }],
            },
          ],
          candidates: [],
        },
      ),
    ).toEqual({
      kind: "VALUE",
      lines: [
        {
          ...line,
          targets: [
            {
              projectId: "project-1",
              roomId: "room-1",
              amountCents: 12500,
            },
          ],
        },
      ],
    });
    expect(
      resolveImportAnswer(
        "Projeto Aurora, Cozinha: R$ 125,00",
        "targets",
        answer,
        [line],
        { projects: [], candidates: [] },
      ),
    ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
  });

  it("treats NO_DECISION as clarification and never mutates another field", () => {
    const before = structuredClone(line);
    expect(
      resolve("R$ 12,00", "amountCents", {
        kind: "NO_DECISION",
        answer: null,
      }),
    ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
    expect(line).toEqual(before);
  });
});
