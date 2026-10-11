import {
  ImportSessionAmountMeaning,
  parseImportFocusedLiteral,
  type ImportFocusedLiteralField,
  type ImportSessionFocusedDraftAnswerRequestV1,
} from "@reformaflow/domain";
import type {
  FocusedDraftAnswerRequestContext,
  FocusedDraftAnswer,
} from "./import-focused-draft-types";

const LITERAL_FIELDS = new Set<FocusedDraftAnswer["field"]>([
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "dataCompra",
  "firstDueDate",
]);

function exactLiteral(
  answer: FocusedDraftAnswer,
  browserLiteral: string,
): string | null {
  if (!LITERAL_FIELDS.has(answer.field) || answer.value === null) return null;
  const field = answer.field as ImportFocusedLiteralField;
  if (parseImportFocusedLiteral(field, browserLiteral) === answer.value)
    return browserLiteral;
  if (answer.field !== "amountMeaning") return null;
  const visibleLiteral =
    answer.value === ImportSessionAmountMeaning.TOTAL_PURCHASE
      ? "total da compra"
      : "valor da parcela";
  return parseImportFocusedLiteral(field, visibleLiteral) === answer.value
    ? visibleLiteral
    : null;
}

function targetMoneyLiteral(amountCents: number): string | null {
  if (!Number.isSafeInteger(amountCents)) return null;
  const sign = amountCents < 0 ? "-" : "";
  const absoluteCents = Math.abs(amountCents);
  const reais = Math.floor(absoluteCents / 100);
  const cents = String(absoluteCents % 100).padStart(2, "0");
  const literal = `${sign}${reais},${cents}`;
  return parseImportFocusedLiteral("amountCents", literal) === amountCents
    ? literal
    : null;
}

/**
 * The controls keep browser-friendly preview values (including target arrays).
 * This is the only conversion point to the exact focused PATCH wire contract.
 */
export function serializeFocusedDraftAnswerRequest(
  context: FocusedDraftAnswerRequestContext,
): ImportSessionFocusedDraftAnswerRequestV1 | null {
  const base = {
    version: 1 as const,
    answerRequestId: context.answerRequestId,
    expectedRevision: context.expectedRevision,
    questionId: context.questionId,
    channel: context.channel,
  };
  const answer = context.answer;
  switch (answer.field) {
    case "amountMeaning":
    case "amountCents":
    case "installmentCount":
    case "dataCompra":
    case "firstDueDate": {
      const literal = exactLiteral(answer, context.literal);
      if (literal === null || answer.value === null) return null;
      return {
        ...base,
        answer: {
          field: answer.field,
          literal,
          value: answer.value,
        },
      } as ImportSessionFocusedDraftAnswerRequestV1;
    }
    case "tipoDespesa":
      return answer.value === null
        ? null
        : {
            ...base,
            answer: { field: answer.field, value: answer.value },
          };
    case "categoriaMaoDeObra":
      return answer.value === null
        ? null
        : {
            ...base,
            answer: { field: answer.field, value: answer.value },
          };
    case "decision":
      return {
        ...base,
        answer: { field: answer.field, value: { ...answer.value } },
      };
    case "targets": {
      if (answer.value.length === 0)
        return {
          ...base,
          answer: { field: answer.field, value: { kind: "NO_TARGETS" } },
        };
      if (answer.value.length !== 1) return null;
      const [target] = answer.value;
      const literal = targetMoneyLiteral(target.amountCents);
      if (literal === null) return null;
      const value = {
        kind: "TARGET" as const,
        projectId: target.projectId,
        roomId: target.roomId,
        amountCents: target.amountCents,
        literal,
      };
      return {
        ...base,
        answer: { field: answer.field, value },
      };
    }
  }
}
