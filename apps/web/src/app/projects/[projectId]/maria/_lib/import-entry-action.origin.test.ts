import { describe, expect, it } from "vitest";
import { readImportEntryAction } from "./import-entry-action";

const start = {
  version: 1,
  kind: "START_CARD_INVOICE_IMPORT",
  formats: ["CSV", "PDF"],
  suggestedCardId: null,
};

describe("import entry action origin parser", () => {
  it.each(["TEXT", "VOICE"] as const)(
    "retains the exact server-owned %s origin",
    (origin) => {
      expect(readImportEntryAction({ ...start, origin })).toEqual({
        ...start,
        origin,
      });
    },
  );

  it.each([
    start,
    { ...start, origin: "voice" },
    { ...start, origin: "VOICE " },
    { ...start, origin: null },
    { ...start, origin: 1 },
    { ...start, origin: "VOICE", extra: true },
  ])("rejects missing, malformed, or non-exact origin %#", (value) => {
    expect(readImportEntryAction(value)).toBeNull();
  });
});
