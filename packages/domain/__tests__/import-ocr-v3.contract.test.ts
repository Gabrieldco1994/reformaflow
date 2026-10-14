import { describe, expect, it } from "vitest";
import * as ocrContract from "../src/import-ocr";

describe("public OCR document contract", () => {
  it("preserves request and consent version 2", () => {
    expect(ocrContract.PDF_OCR_VERSION).toBe(2);
  });

  it("publishes provider document version 3 independently", () => {
    expect(
      (ocrContract as unknown as Record<string, unknown>)
        .PDF_OCR_DOCUMENT_VERSION,
    ).toBe(3);
  });

  it("publishes only the strict V3 provider candidate keys", () => {
    expect(
      (ocrContract as unknown as Record<string, unknown>)
        .PDF_OCR_PROVIDER_CANDIDATE_KEYS,
    ).toEqual([
      "pageNumber",
      "pageOccurrenceIndex",
      "description",
      "amountCents",
      "sign",
      "amountMeaning",
      "dateText",
      "normalizedDate",
      "dateExplicitness",
      "installment",
      "evidenceText",
    ]);
  });
});
