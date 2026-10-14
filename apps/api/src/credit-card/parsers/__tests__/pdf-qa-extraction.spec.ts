import { invoicePaymentIgnoredReason } from "../../invoice-payment-classification";
import { extractPdfDocument } from "../pdf-document";
import {
  generateInvalidPdf,
  generateMixedInvoicePdf,
  generateScannedOnlyPdf,
  generateTextInvoicePdf,
  PDF_QA_PAYMENT,
  PDF_QA_PURCHASES,
  PDF_QA_PURCHASE_TOTAL_CENTS,
} from "./pdf-qa-fixtures";

// Real production worker, not a mocked PDF library or Jest's ESM fake worker.
// The document contract preserves yearless dates, unlike the legacy ledger
// parser. Card-scoped financial identity is assigned later by materialization.
describe("PDF QA: isolated purchase-document extraction", () => {
  it("generates identical bytes on each call and independent caller buffers", () => {
    const first = generateTextInvoicePdf();
    const second = generateTextInvoicePdf();
    expect(first).toEqual(second);
    first.fill(0);
    expect(second.subarray(0, 8).toString()).toBe("%PDF-1.4");
  });

  it("extracts every source occurrence in order, including signed payment evidence", async () => {
    const result = await extractPdfDocument(generateTextInvoicePdf());
    expect(result.occurrences.map((row) => row.raw)).toEqual([
      {
        date: "01/09",
        description: "MERCADO SINTETICO",
        amount: "206,96",
        installment: null,
      },
      {
        date: "02/09",
        description: "CAFE TESTE",
        amount: "0,01",
        installment: null,
      },
      {
        date: "03/09",
        description: "LIVRARIA FICTICIA",
        amount: "1.500,00",
        installment: null,
      },
      {
        date: "04/09",
        description: "OFICINA DEMO",
        amount: "20.696,00",
        installment: null,
      },
      {
        date: "05/09",
        description: "FARMACIA TESTE",
        amount: "87,43",
        installment: null,
      },
      {
        date: "06/09",
        description: "PAGAMENTO DE FATURA",
        amount: "-22.490,40",
        installment: null,
      },
    ]);
  });

  it("normalizes merchants and exact integer cents without inventing dates or inflating by 100x", async () => {
    const result = await extractPdfDocument(generateTextInvoicePdf());
    expect(result.version).toBe(1);
    expect(result.parserVersion).toBe("card-local-pdf-v1");
    expect(result.documentKind).toBe("INVOICE");
    expect(result.invoiceDueMonth).toBeNull();
    expect(result.metrics).toEqual({
      pages: 1,
      rows: 6,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    });
    expect(
      result.occurrences.map((row) => ({
        dateOnly: row.dateOnly,
        merchant: row.merchant,
        amountCents: row.amountCents,
      })),
    ).toEqual(
      [...PDF_QA_PURCHASES, PDF_QA_PAYMENT].map((tx) => ({
        dateOnly: null,
        merchant: tx.merchant,
        amountCents: tx.amountCents,
      })),
    );
    expect(
      result.occurrences
        .filter((row) => row.amountCents! > 0)
        .reduce((sum, row) => sum + row.amountCents!, 0),
    ).toBe(PDF_QA_PURCHASE_TOTAL_CENTS);
    // Signed evidence balances, but the payment is not a purchase.
    expect(
      result.occurrences.reduce((sum, row) => sum + row.amountCents!, 0),
    ).toBe(0);
    expect(
      result.occurrences.map((row) => ({
        installmentIndex: row.installmentIndex,
        installmentCount: row.installmentCount,
        section: row.section,
        cycle: row.cycle,
        amountMeaning: row.amountMeaning,
        identityOrdinal: row.identityOrdinal,
        fitId: row.fitId,
      })),
    ).toEqual(
      Array.from({ length: 6 }, () => ({
        installmentIndex: null,
        installmentCount: null,
        section: "CURRENT",
        cycle: null,
        amountMeaning: "UNKNOWN",
        identityOrdinal: null,
        fitId: null,
      })),
    );
    expect(result.diagnostics).toEqual(
      result.occurrences.flatMap((row) => [
        { reference: row.reference, code: "UNKNOWN_DATE" },
        { reference: row.reference, code: "UNKNOWN_AMOUNT_MEANING" },
      ]),
    );
  });

  it("assigns stable unique source references and ordinals across replay", async () => {
    const first = await extractPdfDocument(generateTextInvoicePdf());
    const replay = await extractPdfDocument(generateTextInvoicePdf());
    const references = first.occurrences.map((row) => row.reference);
    expect(references).toEqual([
      "pdf:page:1:line:3",
      "pdf:page:1:line:4",
      "pdf:page:1:line:5",
      "pdf:page:1:line:6",
      "pdf:page:1:line:7",
      "pdf:page:1:line:8",
    ]);
    expect(new Set(references).size).toBe(6);
    expect(first.occurrences.map((row) => row.sourceOrdinal)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(replay).toEqual(first);
  });

  it("classifies the extracted payment as ignored evidence, not a purchase", async () => {
    const result = await extractPdfDocument(generateTextInvoicePdf());
    expect(
      result.occurrences.map((row) => ({
        merchant: row.merchant,
        ignoredReason: invoicePaymentIgnoredReason(row.merchant!),
      })),
    ).toEqual([
      ...PDF_QA_PURCHASES.map((tx) => ({
        merchant: tx.merchant,
        ignoredReason: null,
      })),
      { merchant: PDF_QA_PAYMENT.merchant, ignoredReason: "INVOICE_PAYMENT" },
    ]);
  });

  it("rejects scanned-only PDFs with OCR_REQUIRED", async () => {
    await expect(
      extractPdfDocument(generateScannedOnlyPdf()),
    ).rejects.toMatchObject({
      code: "OCR_REQUIRED",
    });
  });

  it("rejects mixed searchable/raster PDFs with DOCUMENT_UNREADABLE", async () => {
    await expect(
      extractPdfDocument(generateMixedInvoicePdf()),
    ).rejects.toMatchObject({
      code: "DOCUMENT_UNREADABLE",
    });
  });

  it("rejects malformed PDF bytes at the real adapter boundary", async () => {
    // The adapter maps PDF.js failures to this typed code; it deliberately
    // does not expose the underlying InvalidPDFException or private details.
    await expect(
      extractPdfDocument(generateInvalidPdf()),
    ).rejects.toMatchObject({
      code: "DOCUMENT_UNREADABLE",
    });
  });
});
