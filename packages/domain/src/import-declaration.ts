import { parseInstallmentDateOnlyUtc } from "./calculations/local-date-utc";
import {
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as P,
  ImportSessionAmountMeaning,
  type ImportDeclarationAnswerV1,
  type ImportHumanFactFieldV1,
  type ImportHumanMeaningV1,
} from "./import-session";
import { parseSpokenMoney } from "./money-parse";

export type ImportDeclarationContextV1 = {
  [F in ImportHumanFactFieldV1]: {
    field: F;
    meaningContext: F extends "amountCents" ? ImportHumanMeaningV1 : null;
    effectiveInstallmentCount: number | null;
  };
}[ImportHumanFactFieldV1];

/** Local UI intent is not an authenticated ANSWER or a stored declaration. */
export type ImportDeclarationUiInputV1 =
  | { kind: "VALUE"; text: string }
  | { kind: "UNKNOWN" }
  | { kind: "REMOVE" };

type Clarification = { kind: "CLARIFY"; reason: "INVALID_VALUE" };
export type ImportDeclarationNormalizationV1 =
  | { kind: "VALID"; answer: ImportDeclarationAnswerV1 }
  | Clarification;
export type ImportDeclarationEncodingV1 =
  | {
      kind: "ENCODED";
      answer: ImportDeclarationAnswerV1;
      literalAnswer: string;
    }
  | Clarification;

const MAX_LITERAL_LENGTH = 4000;
const FIELDS: readonly ImportHumanFactFieldV1[] = [
  "dataCompra",
  "merchant",
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "installmentIndex",
];
const MONEY =
  /^(?:R\$ ?)?(?:[0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:[,.][0-9]{1,2})?)$/i;
const MEANING_TEXT = {
  TOTAL_PURCHASE: "total da compra",
  INSTALLMENT_CHARGE: "valor da parcela",
} as const;
const ABSENCE = new Set([
  "não sei",
  "nao sei",
  "não sei informar",
  "nao sei informar",
  "remover",
  "limpar",
]);
const invalid = (): Clarification => ({
  kind: "CLARIFY",
  reason: "INVALID_VALUE",
});
const valid = (
  answer: ImportDeclarationAnswerV1,
): ImportDeclarationNormalizationV1 => ({ kind: "VALID", answer });

function validContext(context: ImportDeclarationContextV1): boolean {
  return (
    FIELDS.includes(context.field) &&
    (context.field === "amountCents"
      ? context.meaningContext === ImportSessionAmountMeaning.TOTAL_PURCHASE ||
        context.meaningContext === ImportSessionAmountMeaning.INSTALLMENT_CHARGE
      : context.meaningContext === null) &&
    (context.effectiveInstallmentCount === null ||
      (Number.isSafeInteger(context.effectiveInstallmentCount) &&
        context.effectiveInstallmentCount >= 1))
  );
}

/** Preview only: plain merchant stays plain, with no JSON serialization or authority. */
export function normalizeImportDeclaration(
  context: ImportDeclarationContextV1,
  input: ImportDeclarationUiInputV1,
): ImportDeclarationNormalizationV1 {
  if (!validContext(context)) return invalid();
  if (input.kind === "UNKNOWN" || input.kind === "REMOVE") {
    return valid(
      context.field === "amountCents"
        ? {
            field: context.field,
            value: null,
            meaningContext: context.meaningContext,
          }
        : { field: context.field, value: null, meaningContext: null },
    );
  }
  if (
    input.kind !== "VALUE" ||
    typeof input.text !== "string" ||
    input.text.length > MAX_LITERAL_LENGTH
  )
    return invalid();
  const text = input.text.trim();
  switch (context.field) {
    case "dataCompra": {
      const value = text.replace(
        /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/,
        "$3-$2-$1",
      );
      const date = parseInstallmentDateOnlyUtc(value);
      return date &&
        date.getUTCFullYear() >= P.minYear &&
        date.getUTCFullYear() <= P.maxYear
        ? valid({ field: context.field, value, meaningContext: null })
        : invalid();
    }
    case "amountCents": {
      if (!MONEY.test(text)) return invalid();
      const reais = parseSpokenMoney(text);
      if (reais === null) return invalid();
      const value = Math.round(reais * 100);
      return Number.isSafeInteger(value) &&
        value >= P.minPurchaseCents &&
        value <= P.maxCents
        ? valid({
            field: context.field,
            value,
            meaningContext: context.meaningContext,
          })
        : invalid();
    }
    case "amountMeaning": {
      const label = text.toLowerCase();
      if (label === MEANING_TEXT.TOTAL_PURCHASE)
        return valid({
          field: context.field,
          value: ImportSessionAmountMeaning.TOTAL_PURCHASE,
          meaningContext: null,
        });
      if (label === MEANING_TEXT.INSTALLMENT_CHARGE)
        return valid({
          field: context.field,
          value: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
          meaningContext: null,
        });
      return invalid();
    }
    case "installmentCount":
    case "installmentIndex": {
      if (!/^[1-9][0-9]*$/.test(text)) return invalid();
      const value = Number(text);
      if (
        !Number.isSafeInteger(value) ||
        value > LIMITS.installmentsPerPurchase ||
        (context.field === "installmentIndex" &&
          context.effectiveInstallmentCount !== null &&
          value > context.effectiveInstallmentCount)
      )
        return invalid();
      return valid({ field: context.field, value, meaningContext: null });
    }
    case "merchant":
      return text.length >= 1 &&
        text.length <= P.maxSupplierLength &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)
        ? valid({ field: context.field, value: text, meaningContext: null })
        : invalid();
  }
  return invalid();
}

/** Call only from Guardar after the local preview; no caller-supplied normalized value is trusted. */
export function encodeImportDeclaration(
  context: ImportDeclarationContextV1,
  input: ImportDeclarationUiInputV1,
): ImportDeclarationEncodingV1 {
  const result = normalizeImportDeclaration(context, input);
  if (result.kind === "CLARIFY") return result;
  const answer = result.answer;
  let literalAnswer: string;
  if (answer.value === null) {
    literalAnswer = input.kind === "REMOVE" ? "remover" : "não sei informar";
  } else {
    switch (answer.field) {
      case "merchant":
        literalAnswer = JSON.stringify(answer.value);
        break;
      case "amountCents":
        literalAnswer = `${Math.floor(answer.value / 100)},${String(answer.value % 100).padStart(2, "0")}`;
        break;
      case "amountMeaning":
        literalAnswer = MEANING_TEXT[answer.value];
        break;
      default:
        literalAnswer = String(answer.value);
    }
  }
  return { kind: "ENCODED", answer, literalAnswer };
}

/** Whole authenticated literal only; the writer still owns live scope, original facts and revision. */
export function parseImportDeclarationLiteral(
  context: ImportDeclarationContextV1,
  literalAnswer: unknown,
): ImportDeclarationNormalizationV1 {
  if (
    typeof literalAnswer !== "string" ||
    literalAnswer.length > MAX_LITERAL_LENGTH
  )
    return invalid();
  const text = literalAnswer.trim();
  if (ABSENCE.has(text.toLowerCase()))
    return normalizeImportDeclaration(context, { kind: "UNKNOWN" });
  if (context.field !== "merchant")
    return normalizeImportDeclaration(context, { kind: "VALUE", text });
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return invalid();
    throw error;
  }
  return typeof decoded === "string"
    ? normalizeImportDeclaration(context, { kind: "VALUE", text: decoded })
    : invalid();
}
