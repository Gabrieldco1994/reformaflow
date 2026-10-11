import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionAmountMeaning,
  parseInstallmentDateOnlyUtc,
  parseSpokenMoney,
  type ImportSessionQuestionV1,
} from "@reformaflow/domain";
import type { FocusedDraftAnswer } from "./import-focused-draft-types";

type Field = ImportSessionQuestionV1["field"] | "merchant" | "installmentIndex";

export interface StrictDraftContext {
  amountCents?: number | null;
  projectId?: string | null;
  roomId?: string | null;
  candidateExpenseIds?: readonly string[];
}

export type DeterministicVoiceAnswer =
  | FocusedDraftAnswer
  | { field: "merchant"; value: string }
  | { field: "installmentIndex"; value: number };

const dateOnly = (value: string) => {
  if (!/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)) return null;
  const date = parseInstallmentDateOnlyUtc(value);
  return date &&
    date.getUTCFullYear() >= IMPORT_SESSION_PRIMITIVES.minYear &&
    date.getUTCFullYear() <= IMPORT_SESSION_PRIMITIVES.maxYear
    ? value
    : null;
};

const cents = (value: string) => {
  if (
    !/^(?:R\$\s*)?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2}|\.\d{1,2})?$/.test(
      value.trim(),
    )
  )
    return null;
  const reais = parseSpokenMoney(value);
  const parsed = reais === null ? null : Math.round(reais * 100);
  return parsed !== null &&
    Number.isSafeInteger(parsed) &&
    parsed >= IMPORT_SESSION_PRIMITIVES.minPurchaseCents &&
    parsed <= IMPORT_SESSION_PRIMITIVES.maxCents
    ? parsed
    : null;
};

const positiveInteger = (value: string) => {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= IMPORT_SESSION_LIMITS.installmentsPerPurchase
    ? parsed
    : null;
};

export function strictDraftAnswer(
  field: ImportSessionQuestionV1["field"],
  raw: string,
  context: StrictDraftContext,
): FocusedDraftAnswer | null {
  const value = raw.trim();
  switch (field) {
    case "amountCents": {
      const parsed = cents(value);
      return parsed === null ? null : { field, value: parsed };
    }
    case "installmentCount": {
      const parsed = positiveInteger(value);
      return parsed === null ? null : { field, value: parsed };
    }
    case "dataCompra":
    case "firstDueDate": {
      const parsed = dateOnly(value);
      return parsed === null ? null : { field, value: parsed };
    }
    case "amountMeaning":
      return value === ImportSessionAmountMeaning.TOTAL_PURCHASE ||
        value === ImportSessionAmountMeaning.INSTALLMENT_CHARGE
        ? { field, value }
        : null;
    case "decision":
      if (value === "CREATE")
        return {
          field,
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        };
      if (value === "CREATE_ACCEPT_NATURAL_DUPLICATE")
        return {
          field,
          value: { kind: "CREATE", acceptNaturalDuplicate: true },
        };
      return context.candidateExpenseIds?.includes(value)
        ? { field, value: { kind: "KEEP_EXISTING", expenseId: value } }
        : null;
    case "targets":
      if (value === "NO_TARGETS") return { field, value: [] };
      return value === "target" &&
        context.projectId &&
        context.amountCents !== null &&
        context.amountCents !== undefined &&
        Number.isSafeInteger(context.amountCents) &&
        context.amountCents > 0
        ? {
            field,
            value: [
              {
                projectId: context.projectId,
                roomId: context.roomId ?? null,
                amountCents: context.amountCents,
              },
            ],
          }
        : null;
    default:
      return null;
  }
}

export function deterministicVoiceAnswer(
  field: Field,
  transcript: string,
): DeterministicVoiceAnswer | null {
  const text = transcript.trim();
  if (!text) return null;
  if (field === "merchant") {
    const normalized = text.toLocaleLowerCase("pt-BR");
    const uncertain =
      /[\n\r,;/\\|]/.test(text) ||
      /\s+(?:ou|e)\s+/i.test(text) ||
      /(?:^|\s)(?:acho|talvez|provavelmente|possivelmente|incert[oa])(?:\s|$)/i.test(
        normalized,
      ) ||
      /\bn[aã]o\s+(?:sei|lembro|tenho\s+certeza)\b/i.test(normalized);
    return text.length <= IMPORT_SESSION_PRIMITIVES.maxSupplierLength &&
      !uncertain
      ? { field, value: text }
      : null;
  }
  if (field === "installmentIndex") {
    const value = positiveInteger(text);
    return value === null ? null : { field, value };
  }
  if (field === "amountMeaning") {
    const normalized = text.toLocaleLowerCase("pt-BR");
    if (normalized === "total da compra")
      return { field, value: ImportSessionAmountMeaning.TOTAL_PURCHASE };
    if (normalized === "valor da parcela")
      return { field, value: ImportSessionAmountMeaning.INSTALLMENT_CHARGE };
    return null;
  }
  if (field === "dataCompra" || field === "firstDueDate") {
    const normalized = text.replace(
      /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/,
      "$3-$2-$1",
    );
    const value = dateOnly(normalized);
    return value === null ? null : { field, value };
  }
  if (field !== "amountCents" && field !== "installmentCount") return null;
  return strictDraftAnswer(field, text, {});
}
