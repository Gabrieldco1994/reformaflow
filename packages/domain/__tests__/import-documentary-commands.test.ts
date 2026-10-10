import {
  ImportSessionAmountMeaning,
  normalizeImportTypedDeclaration,
} from "../src";
import { describe, expect, it } from "vitest";

describe("normalizeImportTypedDeclaration", () => {
  const context = {
    field: "amountCents" as const,
    meaningContext: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    effectiveInstallmentCount: 10,
  };

  it("treats numeric money as integer centavos and rejects unsafe boundaries", () => {
    expect(
      normalizeImportTypedDeclaration(context, { kind: "KNOWN", value: 1 }),
    ).toEqual({
      kind: "VALID",
      answer: {
        field: "amountCents",
        value: 1,
        meaningContext: "TOTAL_PURCHASE",
      },
    });
    expect(
      normalizeImportTypedDeclaration(context, { kind: "KNOWN", value: 0 }),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
    expect(
      normalizeImportTypedDeclaration(context, { kind: "KNOWN", value: -1 }),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
  });

  it("keeps UNKNOWN distinct from REMOVE", () => {
    expect(
      normalizeImportTypedDeclaration(context, { kind: "UNKNOWN" }),
    ).toEqual({
      kind: "VALID",
      answer: {
        field: "amountCents",
        value: null,
        meaningContext: "TOTAL_PURCHASE",
      },
    });
    expect(
      normalizeImportTypedDeclaration(context, { kind: "REMOVE" }),
    ).toEqual({ kind: "REMOVE" });
  });

  it("validates dates, merchant text, meaning and installment bounds by field", () => {
    expect(
      normalizeImportTypedDeclaration(
        {
          field: "dataCompra",
          meaningContext: null,
          effectiveInstallmentCount: null,
        },
        { kind: "KNOWN", value: "2026-02-31" },
      ),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
    expect(
      normalizeImportTypedDeclaration(
        {
          field: "merchant",
          meaningContext: null,
          effectiveInstallmentCount: null,
        },
        { kind: "KNOWN", value: " São João " },
      ),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
    expect(
      normalizeImportTypedDeclaration(
        {
          field: "amountMeaning",
          meaningContext: null,
          effectiveInstallmentCount: null,
        },
        { kind: "KNOWN", value: "INSTALLMENT_CHARGE" },
      ),
    ).toMatchObject({
      kind: "VALID",
      answer: { value: "INSTALLMENT_CHARGE" },
    });
    expect(
      normalizeImportTypedDeclaration(
        {
          field: "installmentIndex",
          meaningContext: null,
          effectiveInstallmentCount: 10,
        },
        { kind: "KNOWN", value: 11 },
      ),
    ).toEqual({ kind: "CLARIFY", reason: "INVALID_VALUE" });
  });
});
