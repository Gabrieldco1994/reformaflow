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
import { execFileSync } from "node:child_process";
import { buildCardDocument } from "../../../api/src/credit-card/parsers/types";

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
// Derive ONLY the live positive from the committed uncompressed fixture. Adding
// six year suffixes changes stream lengths/xref offsets, so rebuild both instead
// of corrupting the PDF with a blind byte substitution. Canonical no-year stays
// untouched and remains the negative preparation fixture.
function withExplicitRowYears(original: Buffer): Buffer {
  const objects = Array.from(
    original.toString("ascii").matchAll(/^(\d+) 0 obj\n([\s\S]*?)\nendobj$/gm),
  ).map((match, index) => {
    assert.equal(Number(match[1]), index + 1);
    return match[2]
      .replace(/stream\n([\s\S]*?)\nendstream/, (_stream, commands: string) => {
        let changed = 0;
        const updated = commands.replace(
          /\((0[1-6]\/09) /g,
          (_date, date: string) => {
            changed++;
            return `(${date}/2026 `;
          },
        );
        assert.equal(changed, 6);
        return `stream\n${updated}\nendstream`;
      })
      .replace(/\/Length \d+(?=[\s\S]*stream\n)/, () => {
        const commands = match[2].match(/stream\n([\s\S]*?)\nendstream/)?.[1];
        assert(commands);
        return `/Length ${Buffer.byteLength(commands) + 6 * 5}`;
      });
  });
  assert(objects.length > 0);
  let document = "%PDF-1.4\n%synthetic-live-full-year-qa\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  return Buffer.from(
    `${document}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
const noYear = generateTextInvoicePdf();
const textual = withExplicitRowYears(noYear);
for (const [name, bytes] of [
  ["textual-invoice.pdf", textual],
  ["renamed-textual-invoice.pdf", textual],
  ["no-year-invoice.pdf", noYear],
  ["scanned-invoice.pdf", generateScannedOnlyPdf()],
  ["mixed-invoice.pdf", generateMixedInvoicePdf()],
  ["invalid-invoice.pdf", generateInvalidPdf()],
] as const) {
  fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
}

async function verifyExtraction() {
  const parse = (fileName: string) => {
    // Native child keeps the real PDF.js worker free of ts-node worker hooks.
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const fs = require("node:fs"), { Worker } = require("node:worker_threads");
      const worker = new Worker(process.argv[1], { workerData: {
        bytes: fs.readFileSync(process.argv[2]), maxPages: 25,
        maxOperators: 200000, maxOutputBytes: 10485760
      }});
      worker.on("message", value => console.log(JSON.stringify(value)));
      worker.on("error", error => { console.error(error); process.exitCode = 1; });
    `,
        path.join(
          root,
          "apps/api/src/credit-card/parsers/pdf-document.worker.mjs",
        ),
        path.join(directory, fileName),
      ],
      { timeout: 60_000 },
    ).toString();
    const extracted = JSON.parse(output);
    assert(Array.isArray(extracted.pages), JSON.stringify(extracted));
    const captures = extracted.pages.flatMap(
      (page: { num: number; text: string }) =>
        page.text.split(/\r?\n/).flatMap((line, index) => {
          const match =
            /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{4})?|\d{4}-\d{2}-\d{2})\s+(.+?)(?:\s+(?:R\$\s*)?([+-]?\s*\d[\d.,]*))?\s*$/.exec(
              line,
            );
          return match
            ? [
                {
                  reference: `pdf:page:${page.num}:line:${index + 1}`,
                  date: match[1],
                  description: match[2],
                  amount: match[3]?.replace(/\s/g, "") ?? null,
                  fitId: null,
                  section: "CURRENT" as const,
                },
              ]
            : [];
        }),
    );
    return buildCardDocument(captures, "PDF", "INVOICE");
  };
  const positive = parse("textual-invoice.pdf");
  assert.equal(positive.occurrences.length, 6);
  assert.deepEqual(
    positive.occurrences.map((row) => ({
      date: row.dateOnly,
      title: row.merchant,
      amountCents: row.amountCents,
    })),
    [
      ...expected.purchases,
      {
        date: "2026-09-06",
        title: expected.ignoredPaymentRow,
        amountCents: -expected.purchaseTotalCents,
      },
    ].map((row) => ({
      date: row.date,
      title: row.title,
      amountCents: row.amountCents,
    })),
  );
  assert.deepEqual(
    positive.occurrences.map((row) => row.identityOrdinal),
    [0, 0, 0, 0, 0, 0],
  );
  const negative = parse("no-year-invoice.pdf");
  assert.equal(negative.occurrences.length, 6);
  assert(
    negative.occurrences.every(
      (row) => row.dateOnly === null && row.identityOrdinal === null,
    ),
  );
  // Preparation's immutable-identity refusal is asserted by the committed
  // documentary-coalescing.integration.spec.ts (SEARCH_IDENTITY_UNAVAILABLE).
  console.log(
    "Live full-year PDF: 6 exact rows with ordinals; canonical no-year: 6 missing identities",
  );
}
void verifyExtraction().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
