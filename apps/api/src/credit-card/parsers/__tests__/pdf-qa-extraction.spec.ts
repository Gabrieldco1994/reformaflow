import { invoicePaymentIgnoredReason } from "../../invoice-payment-classification";
import { extractPdfText, parsePdfStatement } from "../pdf";
import {
  generateInvalidPdf,
  generateMixedInvoicePdf,
  generateScannedOnlyPdf,
  generateTextInvoicePdf,
  PDF_QA_CARD_ID,
  PDF_QA_INVOICE_LINES,
  PDF_QA_PAYMENT,
  PDF_QA_PURCHASES,
  PDF_QA_PURCHASE_TOTAL_CENTS,
} from "./pdf-qa-fixtures";

// Characterization of the REAL local extractor, not a mocked PDF library.
// Payment filtering and OCR rejection are intentionally separate RED contracts.
describe("PDF QA: real textual extraction at b8136a9", () => {
  it("generates identical bytes on each call and independent caller buffers", () => {
    const first = generateTextInvoicePdf();
    const second = generateTextInvoicePdf();
    expect(first).toEqual(second);
    first.fill(0);
    expect(second.subarray(0, 8).toString()).toBe("%PDF-1.4");
  });

  it("extracts every synthetic invoice line in order, including payment evidence", async () => {
    const text = await extractPdfText(generateTextInvoicePdf());
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^-- \d+ of \d+ --$/.test(line));
    expect(lines).toEqual(PDF_QA_INVOICE_LINES);
  });

  it("normalizes exact UTC dates, merchants and integer cents without 100x inflation", async () => {
    const result = await parsePdfStatement(
      generateTextInvoicePdf(),
      PDF_QA_CARD_ID,
    );
    expect(result.source).toBe("PDF");
    expect(result.periodLabel).toBe("2026-09");
    expect(result.futureInstallments).toEqual([]);
    expect(
      result.transactions.map((tx) => ({
        date: tx.date.toISOString(),
        merchant: tx.merchant,
        amountCents: tx.amountCents,
      })),
    ).toEqual([...PDF_QA_PURCHASES, PDF_QA_PAYMENT]);
    expect(
      result.transactions
        .filter((tx) => tx.amountCents > 0)
        .reduce((sum, tx) => sum + tx.amountCents, 0),
    ).toBe(PDF_QA_PURCHASE_TOTAL_CENTS);
    // This is the legacy parser's signed ledger total, NOT a purchase total.
    expect(result.totalAmountCents).toBe(0);
    expect(
      result.transactions.map((tx) => ({
        installmentCurrent: tx.installmentCurrent,
        installmentTotal: tx.installmentTotal,
        isFuture: tx.isFuture,
      })),
    ).toEqual(
      Array.from({ length: 6 }, () => ({
        installmentCurrent: undefined,
        installmentTotal: undefined,
        isFuture: false,
      })),
    );
  });

  it("assigns stable unique IDs, scoped to the selected card", async () => {
    const first = await parsePdfStatement(
      generateTextInvoicePdf(),
      PDF_QA_CARD_ID,
    );
    const replay = await parsePdfStatement(
      generateTextInvoicePdf(),
      PDF_QA_CARD_ID,
    );
    const other = await parsePdfStatement(
      generateTextInvoicePdf(),
      "other-qa-card",
    );
    const ids = first.transactions.map((tx) => tx.externalId);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // Public contract truncates SHA-256 to 32 hex digits (types.ts).
    expect(ids).toEqual([
      "02c91af04cb684c3e667e803c979db08",
      "523f033ff948f7dd1cbad06ba927a52b",
      "187374390d0ae3500711353e4490410b",
      "e3e7e1cc06229237c0b80bfc73a7f13f",
      "c97919c21cf4801c1e81f1f87ac5e2d5",
      "d94d172212a6b75d13d7c1947cdae7f2",
    ]);
    expect(replay).toEqual(first);
    expect(other.transactions.map((tx) => tx.externalId)).not.toEqual(ids);
    other.transactions.forEach((tx, index) => {
      expect(tx.externalId).not.toBe(ids[index]);
    });
  });

  it("classifies the extracted payment as ignored evidence, not a purchase", async () => {
    const result = await parsePdfStatement(
      generateTextInvoicePdf(),
      PDF_QA_CARD_ID,
    );
    expect(
      result.transactions.map((tx) => ({
        merchant: tx.merchant,
        ignoredReason: invoicePaymentIgnoredReason(tx.merchant),
      })),
    ).toEqual([
      ...PDF_QA_PURCHASES.map((tx) => ({
        merchant: tx.merchant,
        ignoredReason: null,
      })),
      { merchant: PDF_QA_PAYMENT.merchant, ignoredReason: "INVOICE_PAYMENT" },
    ]);
  });

  it("proves image-only and mixed fixtures have no searchable raster text", async () => {
    const scanned = await extractPdfText(generateScannedOnlyPdf());
    expect(scanned.replace(/-- \d+ of \d+ --/g, "").trim()).toBe("");
    const mixed = await extractPdfText(generateMixedInvoicePdf());
    const lines = mixed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^-- \d+ of \d+ --$/.test(line));
    expect(lines).toEqual(PDF_QA_INVOICE_LINES);
  });

  it("rejects malformed PDF bytes instead of silently returning an empty statement", async () => {
    await expect(
      parsePdfStatement(generateInvalidPdf(), PDF_QA_CARD_ID),
    ).rejects.toMatchObject({ name: "InvalidPDFException" });
  });
});
