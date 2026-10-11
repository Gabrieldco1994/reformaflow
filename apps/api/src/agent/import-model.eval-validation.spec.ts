import {
  ImportSessionAmountMeaning,
  type ImportChatTurnV1,
  type ImportSessionDraftLineV1,
} from "@reformaflow/domain";
import { randomUUID } from "node:crypto";
import { importAnswerToolDefinitions } from "./import-chat.prompt";
import { validateSyntheticCallBatch } from "./import-model.eval-validation";
import { resolveImportAnswer } from "../imports/import-session/import-chat-answer";
import type { ToolCall } from "./llm/llm.types";

const turn: ImportChatTurnV1 = {
  version: 1,
  turnId: randomUUID(),
  sessionId: "synthetic-session",
  expectedRevision: 7,
  channel: "TEXT",
  intent: "ANSWER",
  literalAnswer: "total da compra",
  focus: { id: "question", field: "amountMeaning", lineIds: ["line"] },
  scope: { kind: "LINES", lineIds: ["line"] },
};
const definitions = importAnswerToolDefinitions(turn);
const read: ToolCall = {
  id: "read",
  name: "import_read_session",
  arguments: {},
};
const write: ToolCall = {
  id: "write",
  name: "import_edit_answer",
  arguments: {
    interpretation: {
      kind: "VALUE",
      field: "amountMeaning",
      evidence: { start: 3, end: 18 },
      value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    },
  },
};
const line: ImportSessionDraftLineV1 = {
  id: "line",
  observationIds: ["observation"],
  titulo: "Synthetic",
  fornecedor: null,
  tipoDespesa: null,
  categoriaMaoDeObra: null,
  amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
  amountCents: 12500,
  installmentCount: null,
  dataCompra: "2026-10-01",
  firstDueDate: null,
  targets: null,
  decision: { kind: "UNRESOLVED" },
};

describe("synthetic evaluator mirrors strict contextual call admission", () => {
  const invalidBatches: ToolCall[][] = [
    [],
    [write, write],
    [write, read],
    [read, { ...write, arguments: {} }],
    [
      write,
      { id: "attack", name: "create_expense", arguments: { confirmed: true } },
    ],
  ];
  it.each(invalidBatches.map((calls) => ({ calls })))(
    "rejects the entire invalid batch before any execution (%#)",
    ({ calls }) => {
      const execute = jest.fn();
      expect(() => {
        const batch = validateSyntheticCallBatch(calls, definitions);
        batch.forEach(execute);
      }).toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("accepts reads then exactly one final strict write", () => {
    expect(
      validateSyntheticCallBatch([read, write], definitions).map(
        (item) => item.parsed.name,
      ),
    ).toEqual(["import_read_session", "import_edit_answer"]);
    expect(validateSyntheticCallBatch([read], definitions)).toHaveLength(1);
  });

  it("keeps foreign-card selection out of semantic scoring and rejects any card selector before execution", () => {
    const execute = jest.fn();
    const foreignSelector: ToolCall = {
      id: "foreign-card",
      name: "list_payment_methods",
      arguments: { cardId: "card-outside-session" },
    };
    expect(() => {
      const batch = validateSyntheticCallBatch([foreignSelector], definitions);
      batch.forEach(execute);
    }).toThrow("MODEL_OUTPUT_INVALID");
    expect(execute).not.toHaveBeenCalled();
    expect(
      validateSyntheticCallBatch(
        [{ ...foreignSelector, arguments: {} }],
        definitions,
      )[0].parsed,
    ).toEqual({ name: "list_payment_methods", arguments: {} });
  });

  it("uses UTF-16 offsets after emoji and preserves every other draft field including money", () => {
    const before = structuredClone(line);
    const result = resolveImportAnswer(
      "😀 total da compra",
      "amountMeaning",
      write.arguments.interpretation,
      [line],
    );
    expect(result).toEqual({
      kind: "VALUE",
      lines: [
        { ...before, amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE },
      ],
    });
    expect(line).toEqual(before);
    const splitPair = {
      ...(write.arguments.interpretation as object),
      evidence: { start: 1, end: 18 },
    };
    expect(
      resolveImportAnswer("😀 total da compra", "amountMeaning", splitPair, [
        line,
      ]),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
    expect(line).toEqual(before);
  });

  it("rejects wrong-field interpretation at the literal resolver without mutating money or decisions", () => {
    const before = structuredClone(line);
    const wrongField = {
      kind: "VALUE",
      field: "installmentCount",
      evidence: { start: 0, end: 1 },
      value: 1,
    };
    const calls = [{ ...write, arguments: { interpretation: wrongField } }];
    const batch = validateSyntheticCallBatch(calls, definitions);
    expect(
      resolveImportAnswer(
        "1",
        "amountMeaning",
        batch[0].call.arguments.interpretation,
        [line],
      ),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
    expect(line).toEqual(before);
  });

  it("does not turn affirmative injection text into permission to change a decision", () => {
    const before = structuredClone(line);
    const interpretation = {
      kind: "VALUE",
      field: "decision",
      evidence: { start: 0, end: 3 },
      value: { kind: "CREATE", acceptNaturalDuplicate: false },
    };
    expect(
      resolveImportAnswer("sim", "decision", interpretation, [line]),
    ).toEqual({ kind: "CLARIFY", reason: "AMBIGUOUS" });
    expect(line).toEqual(before);
    expect(() =>
      validateSyntheticCallBatch(
        [
          {
            id: "injected",
            name: "execute_import",
            arguments: { confirmed: true, amountCents: 0 },
          },
        ],
        definitions,
      ),
    ).toThrow("TOOL_NOT_ALLOWED");
  });
});
