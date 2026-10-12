import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ExpenseType,
  ImportSessionAmountMeaning,
  LaborCategory,
  parseInstallmentDateOnlyUtc,
  type ImportSessionQuestionV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import type { FocusedDraftAnswer } from "./import-focused-draft-types";

export const FOCUSED_DRAFT_LABEL = {
  amountMeaning: "Significado do valor",
  amountCents: "Valor da compra",
  installmentCount: "Quantidade de parcelas",
  dataCompra: "Data da compra",
  firstDueDate: "Primeiro vencimento",
  tipoDespesa: "Tipo de despesa",
  categoriaMaoDeObra: "Categoria de mão de obra",
  decision: "Destino da compra",
  targets: "Finalidade da compra",
} as const;

export function isFocusedDraftQuestion(
  question: ImportSessionQuestionV1,
): boolean {
  return (
    !("subject" in question) &&
    Object.hasOwn(FOCUSED_DRAFT_LABEL, question.field)
  );
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function validFocusedDraftAnswer(
  answer: unknown,
): answer is FocusedDraftAnswer {
  if (!record(answer) || !exact(answer, ["field", "value"])) return false;
  switch (answer.field) {
    case "amountMeaning":
      return Object.values(ImportSessionAmountMeaning).some(
        (value) => value === answer.value,
      );
    case "amountCents":
      return (
        answer.value === null ||
        (typeof answer.value === "number" &&
          Number.isSafeInteger(answer.value) &&
          answer.value >= IMPORT_SESSION_PRIMITIVES.minPurchaseCents &&
          answer.value <= IMPORT_SESSION_PRIMITIVES.maxCents)
      );
    case "installmentCount":
      return (
        answer.value === null ||
        (typeof answer.value === "number" &&
          Number.isSafeInteger(answer.value) &&
          answer.value >= 1 &&
          answer.value <= IMPORT_SESSION_LIMITS.installmentsPerPurchase)
      );
    case "dataCompra":
    case "firstDueDate":
      return (
        answer.value === null ||
        (typeof answer.value === "string" &&
          /^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(answer.value) &&
          parseInstallmentDateOnlyUtc(answer.value) !== null)
      );
    case "tipoDespesa":
      return (
        answer.value === null ||
        Object.values(ExpenseType).some((type) => type === answer.value)
      );
    case "categoriaMaoDeObra":
      return (
        answer.value === null ||
        Object.values(LaborCategory).some(
          (category) => category === answer.value,
        )
      );
    case "decision":
      if (!record(answer.value)) return false;
      if (answer.value.kind === "CREATE")
        return (
          exact(answer.value, ["kind", "acceptNaturalDuplicate"]) &&
          typeof answer.value.acceptNaturalDuplicate === "boolean"
        );
      return (
        answer.value.kind === "KEEP_EXISTING" &&
        exact(answer.value, ["kind", "expenseId"]) &&
        typeof answer.value.expenseId === "string" &&
        new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test(
          answer.value.expenseId,
        )
      );
    case "targets":
      return (
        Array.isArray(answer.value) &&
        answer.value.length <= 1 &&
        answer.value.every(
          (target) =>
            record(target) &&
            exact(target, ["projectId", "roomId", "amountCents"]) &&
            typeof target.projectId === "string" &&
            new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test(
              target.projectId,
            ) &&
            (target.roomId === null ||
              (typeof target.roomId === "string" &&
                new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test(
                  target.roomId,
                ))) &&
            typeof target.amountCents === "number" &&
            Number.isSafeInteger(target.amountCents) &&
            target.amountCents >= IMPORT_SESSION_PRIMITIVES.minPurchaseCents &&
            target.amountCents <= IMPORT_SESSION_PRIMITIVES.maxCents,
        )
      );
    default:
      return false;
  }
}

/** Compare typed view structures, not object identity or JSON key order. */
export function sameFocusedValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => sameFocusedValue(value, right[index]))
    );
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) && sameFocusedValue(left[key], right[key]),
    )
  );
}

/** Only the focused field may change; this read never authorizes preparation or finance. */
export function verifiedFocusedDraftAnswer(
  previous: ImportSessionViewV1,
  fresh: ImportSessionViewV1,
  question: ImportSessionQuestionV1,
  answer: FocusedDraftAnswer,
): boolean {
  if (
    fresh.id !== previous.id ||
    fresh.ownerProjectId !== previous.ownerProjectId ||
    fresh.cardId !== previous.cardId ||
    !isFocusedDraftQuestion(question) ||
    !validFocusedDraftAnswer(answer) ||
    question.field !== answer.field ||
    !question.lineIds.length ||
    fresh.lines.length !== previous.lines.length ||
    fresh.confirmation !== null ||
    fresh.receipt !== null ||
    (fresh.state !== "DRAFT" && fresh.state !== previous.state) ||
    !sameFocusedValue(fresh.selectedLineIds, previous.selectedLineIds) ||
    !sameFocusedValue(fresh.declaredFacts, previous.declaredFacts)
  )
    return false;
  const focused = new Set(question.lineIds);
  if (
    !question.lineIds.every((id) =>
      previous.lines.some((line) => line.id === id),
    )
  )
    return false;
  for (const before of previous.lines) {
    const after = fresh.lines.find((line) => line.id === before.id);
    if (!after) return false;
    if (focused.has(before.id)) {
      if (
        !sameFocusedValue(after[answer.field], answer.value) ||
        !sameFocusedValue({ ...before, [answer.field]: answer.value }, after)
      )
        return false;
    } else if (!sameFocusedValue(before, after)) return false;
  }
  const changed = previous.lines.some(
    (line) =>
      focused.has(line.id) &&
      !sameFocusedValue(line[answer.field], answer.value),
  );
  return changed
    ? fresh.revision === previous.revision + 1 && fresh.proposal === null
    : fresh.revision === previous.revision &&
        fresh.expiresAt === previous.expiresAt &&
        sameFocusedValue(fresh.proposal, previous.proposal);
}
