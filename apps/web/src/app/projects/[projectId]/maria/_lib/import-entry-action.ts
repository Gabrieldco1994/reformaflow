import { IMPORT_SESSION_PRIMITIVES } from "@reformaflow/domain";

export type SupportedImportFormat = "CSV" | "PDF";

/** Only formats qualified for this complete documentary flow, not parser capabilities. */
export function isSupportedImportFormats(
  value: unknown,
): value is SupportedImportFormat[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((format: unknown) => format === "CSV" || format === "PDF")
  );
}

/** Ordinary /agent/chat capability response; never authority for financial writes. */
export type ImportEntryAction =
  | {
      version: 1;
      kind: "START_CARD_INVOICE_IMPORT";
      formats: SupportedImportFormat[];
      suggestedCardId: string | null;
    }
  | { version: 1; kind: "IMPORT_UNAVAILABLE" };

export function readImportEntryAction(
  value: unknown,
): ImportEntryAction | null {
  if (!isRecord(value)) return null;
  const action = value;
  if (action.version !== 1) return null;
  if (action.kind === "IMPORT_UNAVAILABLE")
    return { version: 1, kind: "IMPORT_UNAVAILABLE" };
  if (
    action.kind !== "START_CARD_INVOICE_IMPORT" ||
    !isSupportedImportFormats(action.formats) ||
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
    formats: action.formats,
    suggestedCardId: action.suggestedCardId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
