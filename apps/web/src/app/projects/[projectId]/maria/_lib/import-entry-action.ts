import { IMPORT_SESSION_PRIMITIVES } from "@reformaflow/domain";

/** Ordinary /agent/chat capability response; never authority for financial writes. */
export type ImportEntryAction =
  | {
      version: 1;
      kind: "START_CARD_INVOICE_IMPORT";
      formats: ["CSV"];
      suggestedCardId: string | null;
    }
  | { version: 1; kind: "IMPORT_UNAVAILABLE" };

export function readImportEntryAction(
  value: unknown,
): ImportEntryAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (action.version !== 1) return null;
  if (action.kind === "IMPORT_UNAVAILABLE")
    return { version: 1, kind: "IMPORT_UNAVAILABLE" };
  if (
    action.kind !== "START_CARD_INVOICE_IMPORT" ||
    !Array.isArray(action.formats) ||
    action.formats.length !== 1 ||
    action.formats[0] !== "CSV" ||
    (action.suggestedCardId !== null &&
      (typeof action.suggestedCardId !== "string" ||
        !new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test(
          action.suggestedCardId,
        )))
  )
    return null;
  return {
    version: 1,
    kind: "START_CARD_INVOICE_IMPORT",
    formats: ["CSV"],
    suggestedCardId: action.suggestedCardId as string | null,
  };
}
