import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
} from "./import-session";
import {
  ImportSessionAmountMeaning,
  type ImportSessionDateOnly,
  type ImportSessionDraftQuestionV1,
  type ImportObservationQuestionV1,
} from "./import-session";
import { parseInstallmentDateOnlyUtc } from "./calculations/local-date-utc";
import { parseSpokenMoney } from "./money-parse";

export type ImportFocusedLiteralField =
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "dataCompra"
  | "firstDueDate";

export type ImportFocusedLiteralValue<F extends ImportFocusedLiteralField> =
  F extends "amountMeaning"
    ?
        | typeof ImportSessionAmountMeaning.TOTAL_PURCHASE
        | typeof ImportSessionAmountMeaning.INSTALLMENT_CHARGE
    : F extends "amountCents" | "installmentCount"
      ? number
      : ImportSessionDateOnly;

export function isPendingImportQuestion(
  question: ImportSessionDraftQuestionV1 | ImportObservationQuestionV1,
): boolean {
  return !("subject" in question) || question.answerState === "UNANSWERED";
}

const MONEY_TOKEN =
  /(?<![\p{L}\p{N}_-])(?:R\$\s*)?(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)(?![\p{L}\p{N}_])/giu;
const DATE_TOKEN =
  /(?<![\p{L}\p{N}_])(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})(?![\p{L}\p{N}_])/gu;
const COUNT_TOKEN = /(?<![\p{L}\p{N}_-])\d+(?![\p{L}\p{N}_])/gu;
const NEGATIVE_NUMERIC_TOKEN = /[\p{Dash_Punctuation}\u2212]\s*(?:R\$\s*)?\d/u;

function only<T>(values: readonly T[]): T | null {
  return values.length === 1 ? values[0]! : null;
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function parseMoney(literal: string): number | null {
  if (NEGATIVE_NUMERIC_TOKEN.test(literal)) return null;
  const token = only(
    [...literal.matchAll(MONEY_TOKEN)].map((match) => match[0]),
  );
  if (token === null) return null;
  const reais = parseSpokenMoney(token);
  const cents = reais === null ? null : Math.round(reais * 100);
  return cents !== null &&
    Number.isSafeInteger(cents) &&
    cents >= IMPORT_SESSION_PRIMITIVES.minPurchaseCents &&
    cents <= IMPORT_SESSION_PRIMITIVES.maxCents
    ? cents
    : null;
}

function parseCount(literal: string): number | null {
  if (NEGATIVE_NUMERIC_TOKEN.test(literal)) return null;
  const token = only(
    [...literal.matchAll(COUNT_TOKEN)].map((match) => match[0]),
  );
  if (token === null) return null;
  const count = Number(token);
  return Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= IMPORT_SESSION_LIMITS.installmentsPerPurchase
    ? count
    : null;
}

function parseDate(literal: string): ImportSessionDateOnly | null {
  const token = only(
    [...literal.matchAll(DATE_TOKEN)].map((match) => match[0]),
  );
  if (token === null) return null;
  const value = token.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1");
  const date = parseInstallmentDateOnlyUtc(value);
  return date !== null &&
    date.getUTCFullYear() >= IMPORT_SESSION_PRIMITIVES.minYear &&
    date.getUTCFullYear() <= IMPORT_SESSION_PRIMITIVES.maxYear
    ? value
    : null;
}

function parseMeaning(
  literal: string,
):
  | typeof ImportSessionAmountMeaning.TOTAL_PURCHASE
  | typeof ImportSessionAmountMeaning.INSTALLMENT_CHARGE
  | null {
  const text = normalized(literal);
  const candidates: Array<
    | typeof ImportSessionAmountMeaning.TOTAL_PURCHASE
    | typeof ImportSessionAmountMeaning.INSTALLMENT_CHARGE
  > = [...text.matchAll(/\b(?:valor\s+)?total(?:\s+da\s+compra)?\b/gu)].map(
    () => ImportSessionAmountMeaning.TOTAL_PURCHASE,
  );
  candidates.push(
    ...[
      ...text.matchAll(/\b(?:valor\s+)?(?:da\s+|de\s+cada\s+)?parcela\b/gu),
    ].map(() => ImportSessionAmountMeaning.INSTALLMENT_CHARGE),
  );
  return only(candidates);
}

/**
 * Parses the complete human literal without model-provided normalization.
 * More than one candidate fails closed, even when both candidates have the same value.
 */
export function parseImportFocusedLiteral<F extends ImportFocusedLiteralField>(
  field: F,
  literal: string,
): ImportFocusedLiteralValue<F> | null {
  if (
    typeof literal !== "string" ||
    literal.length === 0 ||
    literal.length > IMPORT_SESSION_PRIMITIVES.maxAnswerLiteralLength ||
    literal.normalize("NFC") !== literal
  )
    return null;
  const value =
    field === "amountCents"
      ? parseMoney(literal)
      : field === "installmentCount"
        ? parseCount(literal)
        : field === "dataCompra" || field === "firstDueDate"
          ? parseDate(literal)
          : parseMeaning(literal);
  return value as ImportFocusedLiteralValue<F> | null;
}
