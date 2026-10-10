import { parsePdfStatement } from "../pdf";
import {
  generateMixedInvoicePdf,
  generateScannedOnlyPdf,
  generateTextInvoicePdf,
  PDF_QA_CARD_ID,
  PDF_QA_PURCHASES,
  PDF_QA_PURCHASE_TOTAL_CENTS,
} from "./pdf-qa-fixtures";

/**
 * Active RED acceptance contracts, not skips or mocked implementations.
 * b8136a9 has a CSV-only document API; use the existing PDF parser until the
 * implementer provides a PDF document adapter. Route these failures to that
 * adapter: they are NOT a claim that the legacy parser is purchase-only.
 */
describe("PDF QA: pending safe purchase-document acceptance", () => {
  it.each([
    ["scanned-only", generateScannedOnlyPdf],
    ["mixed text/image pages", generateMixedInvoicePdf],
  ])(
    "rejects %s explicitly as OCR_REQUIRED, never empty/partial success",
    async (_label, generate) => {
      await expect(
        parsePdfStatement(generate(), PDF_QA_CARD_ID),
      ).rejects.toMatchObject({ code: "OCR_REQUIRED" });
    },
  );

  it("keeps five purchases, never turns an invoice payment into a purchase", async () => {
    const result = await parsePdfStatement(
      generateTextInvoicePdf(),
      PDF_QA_CARD_ID,
    );
    expect(
      result.transactions.map((tx) => ({
        date: tx.date.toISOString(),
        merchant: tx.merchant,
        amountCents: tx.amountCents,
      })),
    ).toEqual(PDF_QA_PURCHASES);
    expect(result.totalAmountCents).toBe(PDF_QA_PURCHASE_TOTAL_CENTS);
    expect(result.futureInstallments).toEqual([]);
  });
});
