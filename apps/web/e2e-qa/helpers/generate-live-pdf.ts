/** Node-only generator: the browser spec never imports the API parser/module graph. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  generateTextInvoicePdf,
  generateScannedOnlyPdf,
  generateMixedInvoicePdf,
  generateInvalidPdf,
  PDF_QA_PURCHASES,
  PDF_QA_PURCHASE_TOTAL_CENTS,
  PDF_QA_PAYMENT,
  PDF_QA_INVOICE_LINES,
} from "../../../api/src/credit-card/parsers/__tests__/pdf-qa-fixtures";

const directory = process.argv[2];
assert(directory && path.isAbsolute(directory));
const root = path.resolve(__dirname, "../../../..");
assert(
  !path.resolve(directory).startsWith(`${root}${path.sep}`),
  "PDF bytes must stay outside the checkout",
);
const expected = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../fixtures/pdf-expected.json"),
    "utf8",
  ),
);
assert.deepEqual(
  PDF_QA_PURCHASES.map((purchase) => ({
    title: purchase.merchant,
    amountCents: purchase.amountCents,
    date: purchase.date.slice(0, 10),
  })),
  expected.purchases,
);
assert.equal(PDF_QA_PURCHASE_TOTAL_CENTS, expected.purchaseTotalCents);
assert.equal(PDF_QA_PAYMENT.merchant, expected.ignoredPaymentRow);
assert.equal(PDF_QA_PAYMENT.amountCents, -expected.purchaseTotalCents);
assert.equal(
  expected.purchases
    .slice(0, 2)
    .reduce(
      (sum: number, purchase: { amountCents: number }) =>
        sum + purchase.amountCents,
      0,
    ),
  expected.selectedTotalCents,
);
assert(
  PDF_QA_INVOICE_LINES.some(
    (line) =>
      line ===
      `Vencimento ${expected.declarations.firstDueDate.split("-").reverse().join("/")}`,
  ),
);
assert.equal(
  expected.declarations.firstDueDate.slice(0, 7),
  expected.declarations.invoiceDueMonth,
);
const textual = generateTextInvoicePdf();
for (const [name, bytes] of [
  ["textual-invoice.pdf", textual],
  ["renamed-textual-invoice.pdf", textual],
  ["scanned-invoice.pdf", generateScannedOnlyPdf()],
  ["mixed-invoice.pdf", generateMixedInvoicePdf()],
  ["invalid-invoice.pdf", generateInvalidPdf()],
] as const) {
  fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
}
