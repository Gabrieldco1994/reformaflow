import {
  IMPORT_SESSION_LIMITS,
  ImportSessionAmountMeaning,
  normalizeImportDeclaration,
  type ImportHumanFactFieldV1,
  type ImportTypedGuidedAnswerV1,
} from "@reformaflow/domain";
import type { ToolCall, ToolDef } from "../../agent/llm/llm.types";

export const IMPORT_INTERPRETATION_TOOL =
  "submit_import_interpretation" as const;

export type InterpretationSemantic =
  | "AMOUNT_MEANING"
  | "AMOUNT_CENTS"
  | "INSTALLMENT_COUNT"
  | "INSTALLMENT_INDEX"
  | "DATE"
  | "MERCHANT";

export interface ProviderFocusedInterpretationV1 {
  version: 1;
  focusAlias: string;
  semantic: InterpretationSemantic;
  literal: string;
  constraints: {
    valueType: "ENUM" | "CENTS" | "INTEGER" | "DATE" | "TEXT";
    minimum?: number;
    maximum?: number;
    allowedOptions?: Array<{ alias: string; label: string }>;
  };
}

const FIELD_SEMANTICS: Record<ImportHumanFactFieldV1, InterpretationSemantic> =
  {
    amountMeaning: "AMOUNT_MEANING",
    amountCents: "AMOUNT_CENTS",
    installmentCount: "INSTALLMENT_COUNT",
    installmentIndex: "INSTALLMENT_INDEX",
    dataCompra: "DATE",
    merchant: "MERCHANT",
  };

export function buildFocusedInterpretation(
  field: ImportHumanFactFieldV1,
  literal: string,
  focusAlias: string,
): ProviderFocusedInterpretationV1 {
  let constraints: ProviderFocusedInterpretationV1["constraints"];
  switch (field) {
    case "amountMeaning":
      constraints = {
        valueType: "ENUM",
        allowedOptions: [
          { alias: `${focusAlias}_total`, label: "total da compra" },
          { alias: `${focusAlias}_parcela`, label: "valor da parcela" },
        ],
      };
      break;
    case "amountCents":
      constraints = { valueType: "CENTS", minimum: 1 };
      break;
    case "installmentCount":
    case "installmentIndex":
      constraints = {
        valueType: "INTEGER",
        minimum: 1,
        maximum: IMPORT_SESSION_LIMITS.installmentsPerPurchase,
      };
      break;
    case "dataCompra":
      constraints = { valueType: "DATE" };
      break;
    case "merchant":
      constraints = { valueType: "TEXT" };
      break;
  }
  return {
    version: 1,
    focusAlias,
    semantic: FIELD_SEMANTICS[field],
    literal,
    constraints,
  };
}

export const IMPORT_INTERPRETATION_TOOL_DEF: ToolDef = {
  name: IMPORT_INTERPRETATION_TOOL,
  description:
    "Return one read-only candidate for the focused literal. This tool cannot read or write application data.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["version", "focusAlias", "evidence", "outcome", "candidate"],
    properties: {
      version: { const: 1 },
      focusAlias: { type: "string" },
      evidence: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "text"],
        properties: {
          start: { type: "integer", minimum: 0 },
          end: { type: "integer", minimum: 0 },
          text: { type: "string" },
        },
      },
      outcome: { enum: ["CANDIDATE", "CLARIFY"] },
      candidate: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "literal"],
            properties: {
              kind: { const: "KNOWN" },
              literal: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "optionAlias"],
            properties: {
              kind: { const: "OPTION" },
              optionAlias: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: { kind: { const: "UNKNOWN" } },
          },
          { type: "null" },
        ],
      },
    },
  },
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const invalid = (): never => {
  throw new TypeError("Invalid import interpretation result");
};

function fieldFor(semantic: InterpretationSemantic): ImportHumanFactFieldV1 {
  const entry = Object.entries(FIELD_SEMANTICS).find(
    ([, candidate]) => candidate === semantic,
  );
  if (!entry) return invalid();
  return entry[0] as ImportHumanFactFieldV1;
}

export function parseInterpretationToolResult(
  focused: ProviderFocusedInterpretationV1,
  calls: readonly ToolCall[],
  effectiveInstallmentCount: number | null = null,
  meaningContext:
    | typeof ImportSessionAmountMeaning.TOTAL_PURCHASE
    | typeof ImportSessionAmountMeaning.INSTALLMENT_CHARGE = ImportSessionAmountMeaning.TOTAL_PURCHASE,
): ImportTypedGuidedAnswerV1 | null {
  if (calls.length !== 1 || calls[0]?.name !== IMPORT_INTERPRETATION_TOOL)
    return invalid();
  const value = calls[0].arguments;
  if (
    !exact(value, [
      "version",
      "focusAlias",
      "evidence",
      "outcome",
      "candidate",
    ]) ||
    value.version !== 1 ||
    value.focusAlias !== focused.focusAlias ||
    !record(value.evidence) ||
    !exact(value.evidence, ["start", "end", "text"]) ||
    typeof value.evidence.start !== "number" ||
    !Number.isInteger(value.evidence.start) ||
    typeof value.evidence.end !== "number" ||
    !Number.isInteger(value.evidence.end) ||
    value.evidence.start < 0 ||
    value.evidence.end < value.evidence.start ||
    value.evidence.end > focused.literal.length ||
    typeof value.evidence.text !== "string" ||
    focused.literal.slice(value.evidence.start, value.evidence.end) !==
      value.evidence.text
  )
    return invalid();
  if (value.outcome === "CLARIFY" && value.candidate === null) return null;
  if (value.outcome !== "CANDIDATE" || !record(value.candidate))
    return invalid();
  if (value.candidate.kind === "UNKNOWN" && exact(value.candidate, ["kind"]))
    return { kind: "UNKNOWN" };

  let literal: string;
  if (
    value.candidate.kind === "KNOWN" &&
    exact(value.candidate, ["kind", "literal"]) &&
    typeof value.candidate.literal === "string" &&
    value.candidate.literal === value.evidence.text
  ) {
    literal = value.candidate.literal;
  } else if (
    value.candidate.kind === "OPTION" &&
    exact(value.candidate, ["kind", "optionAlias"]) &&
    typeof value.candidate.optionAlias === "string"
  ) {
    const optionAlias = value.candidate.optionAlias;
    const option = focused.constraints.allowedOptions?.find(
      (candidate) => candidate.alias === optionAlias,
    );
    if (!option) return invalid();
    literal = option.label;
  } else {
    return invalid();
  }

  const field = fieldFor(focused.semantic);
  const normalized = normalizeImportDeclaration(
    {
      field,
      meaningContext: field === "amountCents" ? meaningContext : null,
      effectiveInstallmentCount,
    } as never,
    { kind: "VALUE", text: literal },
  );
  if (normalized.kind !== "VALID") return invalid();
  return normalized.answer.value === null
    ? { kind: "UNKNOWN" }
    : { kind: "KNOWN", value: normalized.answer.value };
}
