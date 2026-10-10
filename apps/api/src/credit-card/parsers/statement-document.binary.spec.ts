import { createHash } from "node:crypto";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";
import * as documentParser from "./statement-document";
import { parsePdfStatement } from "./pdf";
import { parseXlsx } from "./xlsx";
import type { DocumentExtractionV1, ParseResult } from "./types";

type BinaryFormat = "PDF" | "XLS" | "XLSX";
type BinaryInput = Readonly<{
  version: 1;
  context: "CARD_INVOICE";
  bytes: Buffer;
}> &
  (
    | { format: "PDF"; profile: "PDF_TEXT_CARD" }
    | { format: "XLS"; profile: "XLS_CARD" }
    | { format: "XLSX"; profile: "XLSX_CARD" }
  );
type BinaryExtractor = (input: BinaryInput) => Promise<DocumentExtractionV1>;

function binaryExtractor(): BinaryExtractor {
  const exported: unknown = Reflect.get(
    documentParser,
    "extractCardStatementBinaryDocument",
  );
  expect(typeof exported).toBe("function");
  // Test-local planned signature: no stub, fallback or production reference.
  return exported as BinaryExtractor;
}

function inputFor(format: BinaryFormat, bytes: Buffer): BinaryInput {
  const common = { version: 1, context: "CARD_INVOICE", bytes } as const;
  switch (format) {
    case "PDF":
      return { ...common, format, profile: "PDF_TEXT_CARD" };
    case "XLS":
      return { ...common, format, profile: "XLS_CARD" };
    case "XLSX":
      return { ...common, format, profile: "XLSX_CARD" };
  }
}

function textPdf(pages: readonly (readonly string[])[]): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, lines] of pages.entries()) {
    const stream = lines
      .map((line, index) => {
        if (!/^[\x20-\x7e]*$/.test(line))
          throw new Error("ASCII PDF fixture only");
        const escaped = line.replace(/[\\()]/g, "\\$&");
        return `BT /F1 10 Tf 1 0 0 1 36 ${800 - index * 16} Tm (${escaped}) Tj ET`;
      })
      .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function spreadsheet(
  rows: unknown[][],
  format: "XLS" | "XLSX",
  options: {
    date1904?: boolean;
    compression?: boolean;
    extra?: unknown[][];
  } = {},
): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(rows),
    "Fatura",
  );
  workbook.Workbook = {
    WBProps: { date1904: options.date1904 ?? false },
  };
  if (options.extra)
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(options.extra),
      "Outra",
    );
  return Buffer.from(
    XLSX.write(workbook, {
      bookType: format === "XLS" ? "biff8" : "xlsx",
      type: "buffer",
      compression: options.compression ?? false,
    }),
  );
}

const pdfPages = [
  [
    "Fatura de cartao",
    "Vencimento 10/11/2025",
    "Lancamentos desta fatura",
    "Data Descricao Valor",
    "23/10/2025 ULTIMA  LOJA 1.234,56",
    "22/06/2024 LOJA PARC 2/3 100,00",
    "22/06/2024 LOJA PARC 2/3 100,00",
    "22/06/2024 SERIE PARC 1/3 100,00",
    "22/06/2024 SERIE PARC 2/3 99,99",
    "22/06/2024 ZERO 0,00",
    "22/06/2024 CREDITO -12,34",
    "22/06 ANO AUSENTE 1,00",
    "31/02/2025 CALENDARIO 2,00",
    "22/06/2024 SEM VALOR",
    "22/06/2024 4,00",
    "15/12 FUTURO HEURISTICO PARC 2/3 6,00",
    "15/12 NATAL 7,00",
  ],
  [
    "Proximas faturas",
    "22/06/2024 LOJA PARC 3/3 100,00",
    "22/06/2024 LOJA PARC 3/3 100,00",
    "Vencimento 10/12/2025",
    "22/06/2024 LOJA PARC 3/3 100,00",
    "Demonstrativo de parcelamentos",
    "22/06/2024 AMBIGUO PARC 2/3 8,00",
  ],
];

const sheetRows: unknown[][] = [
  ["Fatura de cartao"],
  ["Vencimento"],
  ["10/11/2025"],
  ["Lancamentos desta fatura"],
  ["Data", "Descricao", "Valor", "Parcelamento", "Categoria"],
  ["23/10/2025", " ULTIMA  LOJA ", "1.234,56", undefined, " Alimentos "],
  [],
  ["22/06/2024", "LOJA PARC 2/3", "100,00"],
  ["22/06/2024", "LOJA PARC 2/3", "100,00"],
  ["22/06/2024", "SERIE", "100,00", "Parcela 2 de 3"],
  ["22/06/2024", "ZERO", "0,00"],
  ["22/06/2024", "CREDITO", "-12,34"],
  ["22/06", "ANO AUSENTE", "1,00"],
  ["31/02/2025", "CALENDARIO", "2,00"],
  ["22/06/2024", "SEM VALOR"],
  [undefined, "SEM DATA", "3,00"],
  ["22/06/2024", undefined, "4,00"],
  ["22/06/2024", "", "5,00"],
  [45465, "SERIAL", "6,00"],
  ["22/06/2024", "US", "1,234.56"],
  ["22/06/2024", "CONFLITO PARC 1/3", "7,00", "Parcela 2 de 3"],
  ["22/06/2024", "MALFORMADO", "12abc34"],
  ["Proximas faturas"],
  ["22/06/2024", "FUTURO PARC 3/3", "100,00"],
];

// Controlled synthetic pypdf RC4-40 fixture; never user data or a real credential.
const encryptedPdf = Buffer.from(
  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDQyYmQ5YzIzM2M+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9NZWRpYUJveCBbIDAgMCA2MTIgODQyIF0KL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNSAwIFIKPj4KPj4KL0NvbnRlbnRzIDYgMCBSCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNhCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9MZW5ndGggMTgwCj4+CnN0cmVhbQqCVJGC19MgbvTWk2pqLBzamPJz5FdfOx2BrXxS7BbaUb4Qm5bg5GnDXPpoIwC1iezHb8/5xWCNQ+9Egv82e/CNJkHFs/E3PNY+7IrQdQk3xWd0cYovDhGiAJ8IUT6XsQ5PntmA7ASuDrJhZ9D6vJtJVC8DcH8dCaTMbSnmlc0q68Ehgn0OvhF2rJeAFPzldBBPjtWOJ4JRCgqZSHTOUYcOwJj0UIqeHasghwGRtc+OQbXKvc8KZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8Ci9WIDEKL1IgMgovTGVuZ3RoIDQwCi9QIDQyOTQ5NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPDhlYmFjODZkZTUwZjAxMjhhZjEwYzQ4YTkyYmQwOTJjMmNmN2RhZGI1MGI1Y2JkNTAxMzE3ZGI0YjdhYzFlMjc+Ci9VIDw4ZjdjZmViNGFiMTA4MWQyYjZmYjZjM2FmMjI5YTUxZDFmNzY5NWM3ZGRjMzliMDgzNjIzMmU4ZGY2M2ZmMTBmPgo+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNTkgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAowMDAwMDAwMTY3IDAwMDAwIG4gCjAwMDAwMDAyOTUgMDAwMDAgbiAKMDAwMDAwMDM2NSAwMDAwMCBuIAowMDAwMDAwNTk2IDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgOAovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MDQ3NzI2YzcwNjJjOTFlZDFiNzJiYmEyZGQ0Y2NlZTA+IDw2MjMxMzMzNjY1MzMzMDMzNjQzMjY0MzAzMTM0MzgzMTMxMzgzMjMzNjUzMzMyNjUzMzMzNjI2MzM0NjQ2NDM4PiBdCi9FbmNyeXB0IDcgMCBSCj4+CnN0YXJ0eHJlZgo4MTAKJSVFT0YK",
  "base64",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeLegacy(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value instanceof Date)
    return { $date: value.toISOString(), epochMs: value.getTime() };
  if (Array.isArray(value)) return value.map(encodeLegacy);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeLegacy(item)]),
    );
  return value;
}

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date("2025-11-01T00:30:00.000Z"),
    doNotFake: [
      "hrtime",
      "performance",
      "nextTick",
      "queueMicrotask",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
    ],
  });
});

afterEach(() => jest.useRealTimers());

describe("X2 builder: real fixtures and complete 871 legacy goldens", () => {
  it("uses genuine BIFF8, stored/deflated XLSX and original decoded PDF lines", async () => {
    const biff = spreadsheet(sheetRows, "XLS");
    expect(biff.subarray(0, 8).toString("hex")).toBe("d0cf11e0a1b11ae1");
    for (const compression of [false, true]) {
      const zip = spreadsheet(sheetRows, "XLSX", { compression });
      expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
      expect(zip.readUInt16LE(8)).toBe(compression ? 8 : 0);
      expect(XLSX.read(zip).SheetNames).toStrictEqual(["Fatura"]);
    }
    const bytes = textPdf(pdfPages);
    expect(bytes.subarray(0, 8).toString()).toBe("%PDF-1.4");
    const parser = new PDFParse({
      data: bytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      stopAtErrors: true,
    });
    try {
      expect((await parser.getInfo()).total).toBe(2);
      for (let page = 1; page <= 2; page++) {
        const text = await parser.getText({
          partial: [page],
          disableNormalization: true,
        });
        const expected = [...pdfPages[page - 1]];
        if (page === 1) expected[4] = "23/10/2025 ULTIMA LOJA 1.234,56";
        expect(text.pages.map((item) => item.num)).toStrictEqual([page]);
        expect(text.pages[0].text.trimEnd().split("\n")).toStrictEqual(
          expected,
        );
      }
    } finally {
      await parser.destroy();
    }
  });

  it("legacy_pdf_xls_xlsx_results_match_complete_871_goldens", async () => {
    const records: unknown[] = [];
    const cardId = "x2-synthetic-card";
    async function capture(
      name: string,
      bytes: Buffer,
      parse: (buffer: Buffer) => ParseResult | Promise<ParseResult>,
    ): Promise<void> {
      try {
        records.push({ name, returned: encodeLegacy(await parse(bytes)) });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        records.push({
          name,
          threw: {
            name: error.name,
            message: error.message,
            code: encodeLegacy(Reflect.get(error, "code")),
          },
        });
      }
    }
    const legacyPdf = (buffer: Buffer) => parsePdfStatement(buffer, cardId);
    await capture("pdf-rich", textPdf(pdfPages), legacyPdf);
    await capture(
      "pdf-no-year-2025",
      textPdf([["22/06 SEM ANO 10,00"]]),
      legacyPdf,
    );
    jest.setSystemTime(new Date("2031-01-01T00:30:00.000Z"));
    await capture(
      "pdf-no-year-2031",
      textPdf([["22/06 SEM ANO 10,00"]]),
      legacyPdf,
    );
    jest.setSystemTime(new Date("2025-11-01T00:30:00.000Z"));
    await capture("pdf-empty-page", textPdf([[]]), legacyPdf);
    await capture(
      "pdf-mixed-pages",
      textPdf([["22/06/2024 LEGIVEL 10,00"], []]),
      legacyPdf,
    );
    await capture(
      "pdf-no-transactions",
      textPdf([["Fatura de cartao", "Sem lancamentos"]]),
      legacyPdf,
    );
    await capture(
      "pdf-corrupt",
      Buffer.from("%PDF-1.4\nbroken\n%%EOF"),
      legacyPdf,
    );
    await capture("pdf-empty-buffer", Buffer.alloc(0), legacyPdf);
    await capture("pdf-password-missing", encryptedPdf, legacyPdf);
    await capture("pdf-password-wrong", encryptedPdf, (b) =>
      parsePdfStatement(b, cardId, sha256("x2-wrong-synthetic-key")),
    );
    await capture("pdf-password-correct", encryptedPdf, (b) =>
      parsePdfStatement(b, cardId, sha256("x2-synthetic-only-local-key")),
    );
    for (const format of ["XLS", "XLSX"] as const) {
      const prefix = format.toLowerCase();
      const sheet = spreadsheet(sheetRows, format);
      const parse = (buffer: Buffer) => parseXlsx(buffer, cardId);
      await capture(prefix + "-rich", sheet, parse);
      await capture(prefix + "-empty-sheet", spreadsheet([], format), parse);
      await capture(
        prefix + "-missing-header",
        spreadsheet(
          [
            ["Data", "Descricao"],
            ["22/06/2024", "SEM VALOR"],
          ],
          format,
        ),
        parse,
      );
      await capture(
        prefix + "-empty-results",
        spreadsheet(
          [
            ["Data", "Descricao", "Valor"],
            ["22/06/2024", "ZERO", "0,00"],
          ],
          format,
        ),
        parse,
      );
      await capture(
        prefix + "-extra-sheet",
        spreadsheet(
          [
            ["Data", "Descricao", "Valor"],
            ["22/06/2024", "PRIMEIRA", "10,00"],
          ],
          format,
          {
            extra: [
              ["Data", "Descricao", "Valor"],
              ["22/06/2024", "IGNORADA", "99,00"],
            ],
          },
        ),
        parse,
      );
      for (const date1904 of [false, true]) {
        await capture(
          prefix + "-serial-" + (date1904 ? "1904" : "1900"),
          spreadsheet(
            [
              ["Vencimento"],
              [45465],
              ["Data", "Descricao", "Valor"],
              [45465, "SERIAL", 1],
              [60, "SERIAL 60", 2],
              [1, "SERIAL 1", 3],
            ],
            format,
            { date1904 },
          ),
          parse,
        );
      }
      await capture(
        prefix + "-corrupt-container",
        sheet.subarray(0, 64),
        parse,
      );
    }
    await capture(
      "xlsx-deflated",
      spreadsheet(sheetRows, "XLSX", { compression: true }),
      (buffer) => parseXlsx(buffer, cardId),
    );
    await capture("xlsx-empty-buffer", Buffer.alloc(0), (buffer) =>
      parseXlsx(buffer, cardId),
    );
    expect(records).toHaveLength(29);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(["UTC", "America/Sao_Paulo"]).toContain(timezone);
    // Full pre-edit values: own undefined keys, Date instants, hashes, order,
    // totals, future arrays and all error payloads. Stack traces are evidence-only.
    expect(sha256(JSON.stringify(records, null, 2) + "\n")).toBe(
      timezone === "UTC"
        ? "198a50a55578e88473c1f96ca3f8d7778af2ea5df7702c366d5525cae38c0f20"
        : "61cda4fbad0999eda7941c9281c0eda6b8edc5685ca6425457d1ab48ff3a8f9a",
    );
  });
});

describe("X2 builder: additive documentary API", () => {
  it("text_API_remains_synchronous_and_byte_compatible", () => {
    const result = documentParser.extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes: Buffer.from("date,title,amount\n2024-06-22,LOJA PARC 2/3,100.00"),
    });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toStrictEqual({
      version: 1,
      parserVersion: "card-local-text-v1",
      documentKind: "UNKNOWN",
      invoiceDueMonth: null,
      metrics: {
        pages: 0,
        rows: 1,
        expandedBytes: 0,
        archiveEntries: 0,
        imagePixels: 0,
        frames: 0,
      },
      occurrences: [
        {
          reference: "csv:record:2",
          sourceOrdinal: 0,
          section: "UNKNOWN",
          raw: {
            date: "2024-06-22",
            description: "LOJA PARC 2/3",
            amount: "100.00",
            installment: "PARC 2/3",
          },
          cycle: null,
          dateOnly: "2024-06-22",
          merchant: "LOJA",
          amountCents: 10000,
          amountMeaning: "INSTALLMENT_CHARGE",
          installmentCount: 3,
          installmentIndex: 2,
          fitId: null,
          identityOrdinal: 0,
        },
      ],
      diagnostics: [],
    });
  });

  it.each(["PDF", "XLS", "XLSX"] as const)(
    "text_API_still_rejects_%s",
    (format) => {
      const bytes =
        format === "PDF" ? textPdf(pdfPages) : spreadsheet(sheetRows, format);
      expect(() =>
        Reflect.apply(documentParser.extractCardStatementDocument, undefined, [
          inputFor(format, bytes),
        ]),
      ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    },
  );

  it("binary_entrypoint_is_additive_and_asynchronous", async () => {
    const pending = binaryExtractor()(
      inputFor(
        "PDF",
        textPdf([
          [
            "Fatura de cartao",
            "Lancamentos desta fatura",
            "Data Descricao Valor",
            "22/06/2024 LOJA 10,00",
          ],
        ]),
      ),
    );
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).parserVersion).toBe("card-local-pdf-v1");
  });

  it("pdf_captures_before_both_legacy_dedup_levels_date_rewrite_and_future_heuristic", async () => {
    const result = await binaryExtractor()(
      inputFor(
        "PDF",
        textPdf([
          [
            "Fatura de cartao",
            "Vencimento 10/11/2025",
            "Lancamentos desta fatura",
            "Data Descricao Valor",
            "22/06/2024 LOJA PARC 2/3 100,00",
            "22/06/2024 LOJA PARC 2/3 100,00",
            "22/06/2024 SERIE PARC 1/3 100,00",
            "22/06/2024 SERIE PARC 2/3 99,99",
            "15/12/2025 FUTURO POR DATA PARC 2/3 6,00",
          ],
        ]),
      ),
    );
    expect(result.invoiceDueMonth).toBe("2025-11");
    expect(
      result.occurrences.map((row) => ({
        reference: row.reference,
        sourceOrdinal: row.sourceOrdinal,
        identityOrdinal: row.identityOrdinal,
        date: row.dateOnly,
        merchant: row.merchant,
        cents: row.amountCents,
        section: row.section,
        cycle: row.cycle,
        installment: row.installmentIndex,
        count: row.installmentCount,
        meaning: row.amountMeaning,
      })),
    ).toStrictEqual(
      [
        [5, 0, 0, "2024-06-22", "LOJA", 10000, 2],
        [6, 1, 1, "2024-06-22", "LOJA", 10000, 2],
        [7, 2, 0, "2024-06-22", "SERIE", 10000, 1],
        [8, 3, 0, "2024-06-22", "SERIE", 9999, 2],
        [9, 4, 0, "2025-12-15", "FUTURO POR DATA", 600, 2],
      ].map(
        ([
          line,
          sourceOrdinal,
          identityOrdinal,
          date,
          merchant,
          cents,
          installment,
        ]) => ({
          reference: `pdf:page:1:line:${line}`,
          sourceOrdinal,
          identityOrdinal,
          date,
          merchant,
          cents,
          installment,
          section: "CURRENT",
          cycle: { invoiceDueMonth: "2025-11", reference: "pdf:page:1:line:2" },
          count: 3,
          meaning: "INSTALLMENT_CHARGE",
        }),
      ),
    );
    expect(result.occurrences[0].raw).toStrictEqual({
      date: "22/06/2024",
      description: "LOJA PARC 2/3",
      amount: "100,00",
      installment: "PARC 2/3",
    });
    expect(result.occurrences.every((row) => !("externalId" in row))).toBe(
      true,
    );
  });

  it("pdf_all_pages_keep_global_ordinals_and_clear_cycles_at_future_and_unknown_blocks", async () => {
    const result = await binaryExtractor()(
      inputFor(
        "PDF",
        textPdf([
          [
            "Fatura de cartao",
            "Vencimento 10/11/2025",
            "Lancamentos desta fatura",
            "Data Descricao Valor",
            "22/06/2024 LOJA PARC 2/3 100,00",
          ],
          [
            "Proximas faturas",
            "22/06/2024 LOJA PARC 3/3 100,00",
            "Vencimento 10/12/2025",
            "22/06/2024 LOJA PARC 3/3 100,00",
            "Demonstrativo de parcelamentos",
            "22/06/2024 LOJA PARC 3/3 100,00",
          ],
        ]),
      ),
    );
    expect(result.metrics.pages).toBe(2);
    expect(result.metrics.rows).toBe(4);
    expect(result.invoiceDueMonth).toBe("2025-11");
    expect(
      result.occurrences.map((row) => ({
        reference: row.reference,
        source: row.sourceOrdinal,
        identity: row.identityOrdinal,
        section: row.section,
        cycle: row.cycle,
      })),
    ).toStrictEqual([
      {
        reference: "pdf:page:1:line:5",
        source: 0,
        identity: 0,
        section: "CURRENT",
        cycle: { invoiceDueMonth: "2025-11", reference: "pdf:page:1:line:2" },
      },
      {
        reference: "pdf:page:2:line:2",
        source: 1,
        identity: 1,
        section: "FUTURE",
        cycle: null,
      },
      {
        reference: "pdf:page:2:line:4",
        source: 2,
        identity: 2,
        section: "FUTURE",
        cycle: { invoiceDueMonth: "2025-12", reference: "pdf:page:2:line:3" },
      },
      {
        reference: "pdf:page:2:line:6",
        source: 3,
        identity: 3,
        section: "UNKNOWN",
        cycle: null,
      },
    ]);
  });

  it.each(["XLS", "XLSX"] as const)(
    "%s_captures_physical_rows_raw_cells_twins_and_installment_column",
    async (format) => {
      const bytes = spreadsheet(
        [
          ["Fatura de cartao"],
          ["Vencimento"],
          ["10/11/2025"],
          ["Lancamentos desta fatura"],
          ["Data", "Descricao", "Valor", "Parcelamento"],
          ["22/06/2024", "  LOJA  ", "100,00", "Parcela 2 de 3"],
          [],
          ["22/06/2024", "  LOJA  ", "100,00", "Parcela 2 de 3"],
          ["22/06/2024", "ZERO", 0],
          ["22/06/2024", "CREDITO", "-12,34"],
          ["22/06/2024", "SEM VALOR"],
          [undefined, "SEM DATA", "3,00"],
          ["22/06/2024", "", "4,00"],
          ["31/02/2025", "CALENDARIO", "2,00"],
        ],
        format,
      );
      const result = await binaryExtractor()(inputFor(format, bytes));
      const prefix = `${format.toLowerCase()}:sheet:1`;
      expect(
        result.occurrences.map((row) => ({
          reference: row.reference,
          ordinal: row.sourceOrdinal,
          identity: row.identityOrdinal,
          date: row.dateOnly,
          merchant: row.merchant,
          cents: row.amountCents,
        })),
      ).toStrictEqual(
        [
          [6, 0, 0, "2024-06-22", "LOJA", 10000],
          [8, 1, 1, "2024-06-22", "LOJA", 10000],
          [9, 2, 0, "2024-06-22", "ZERO", 0],
          [10, 3, 0, "2024-06-22", "CREDITO", -1234],
          [11, 4, null, "2024-06-22", "SEM VALOR", null],
          [12, 5, null, null, "SEM DATA", 300],
          [13, 6, null, "2024-06-22", null, 400],
          [14, 7, null, null, "CALENDARIO", 200],
        ].map(([line, ordinal, identity, date, merchant, cents]) => ({
          reference: `${prefix}:row:${line}`,
          ordinal,
          identity,
          date,
          merchant,
          cents,
        })),
      );
      expect(result.occurrences[0]).toMatchObject({
        raw: {
          date: "22/06/2024",
          description: "  LOJA  ",
          amount: "100,00",
          installment: "Parcela 2 de 3",
        },
        installmentIndex: 2,
        installmentCount: 3,
        amountCents: 10000,
        amountMeaning: "INSTALLMENT_CHARGE",
        cycle: { invoiceDueMonth: "2025-11", reference: `${prefix}:cell:A3` },
      });
      expect(result.occurrences[2].raw.amount).toBe("0");
      expect(result.occurrences[4].raw.amount).toBeNull();
      expect(result.occurrences[5].raw.date).toBeNull();
      expect(result.occurrences[6].raw.description).toBe("");
      expect(result.diagnostics).toContainEqual({
        reference: `${prefix}:row:14`,
        code: "INVALID_CALENDAR_DATE",
      });
    },
  );

  it("pdf_keeps_zero_credit_and_identifiable_incomplete_rows", async () => {
    const result = await binaryExtractor()(
      inputFor(
        "PDF",
        textPdf([
          [
            "Fatura de cartao",
            "Lancamentos desta fatura",
            "Data Descricao Valor",
            "22/06/2024 ZERO 0,00",
            "22/06/2024 CREDITO -12,34",
            "22/06/2024 SEM VALOR",
            "22/06/2024 4,00",
            "31/02/2025 CALENDARIO 2,00",
          ],
        ]),
      ),
    );
    expect(
      result.occurrences.map((row) => [
        row.reference,
        row.sourceOrdinal,
        row.dateOnly,
        row.merchant,
        row.amountCents,
        row.identityOrdinal,
      ]),
    ).toStrictEqual([
      ["pdf:page:1:line:4", 0, "2024-06-22", "ZERO", 0, 0],
      ["pdf:page:1:line:5", 1, "2024-06-22", "CREDITO", -1234, 0],
      ["pdf:page:1:line:6", 2, "2024-06-22", "SEM VALOR", null, null],
      ["pdf:page:1:line:7", 3, "2024-06-22", null, 400, null],
      ["pdf:page:1:line:8", 4, null, "CALENDARIO", 200, null],
    ]);
    expect(result.occurrences[2].raw.amount).toBeNull();
    expect(result.occurrences[3].raw.description).toBeNull();
    expect(result.diagnostics).toContainEqual({
      reference: "pdf:page:1:line:8",
      code: "INVALID_CALENDAR_DATE",
    });
  });

  it.each(["PDF", "XLS", "XLSX"] as const)(
    "%s_missing_year_never_uses_clock_or_invoice_year",
    async (format) => {
      const bytes =
        format === "PDF"
          ? textPdf([
              [
                "Fatura de cartao",
                "Vencimento 10/11/2025",
                "Lancamentos desta fatura",
                "Data Descricao Valor",
                "22/06 SEM ANO 10,00",
                "22/06/24 ANO CURTO 10,00",
              ],
            ])
          : spreadsheet(
              [
                ["Fatura de cartao"],
                ["Vencimento"],
                ["10/11/2025"],
                ["Lancamentos desta fatura"],
                ["Data", "Descricao", "Valor"],
                ["22/06", "SEM ANO", "10,00"],
                ["22/06/24", "ANO CURTO", "10,00"],
              ],
              format,
            );
      const extract = binaryExtractor();
      const first = await extract(inputFor(format, bytes));
      jest.setSystemTime(new Date("2031-01-01T00:30:00.000Z"));
      const later = await extract(inputFor(format, bytes));
      expect(later).toStrictEqual(first);
      expect(
        first.occurrences.map((row) => [row.dateOnly, row.identityOrdinal]),
      ).toStrictEqual([
        [null, null],
        [null, null],
      ]);
      expect(first.invoiceDueMonth).toBe("2025-11");
    },
  );
});

describe("X2 builder: existing validator receives the new literal versions", () => {
  const cases = [
    ["card-local-pdf-v1", "pdf:page:1:line:5", "pdf:page:1:line:2", 1, 0, 0],
    [
      "card-local-xls-v1",
      "xls:sheet:1:row:6",
      "xls:sheet:1:cell:A3",
      0,
      100,
      1,
    ],
    [
      "card-local-xlsx-v1",
      "xlsx:sheet:1:row:6",
      "xlsx:sheet:1:cell:A3",
      0,
      100,
      1,
    ],
  ] as const;
  function binaryDto([
    parserVersion,
    reference,
    cycleReference,
    pages,
    expandedBytes,
    archiveEntries,
  ]: (typeof cases)[number]) {
    return {
      version: 1,
      parserVersion,
      documentKind: "INVOICE",
      invoiceDueMonth: "2025-11",
      metrics: {
        pages,
        rows: 1,
        expandedBytes,
        archiveEntries,
        imagePixels: 0,
        frames: 0,
      },
      occurrences: [
        {
          reference,
          sourceOrdinal: 0,
          identityOrdinal: 0,
          section: "CURRENT",
          raw: {
            date: "22/06/2024",
            description: "LOJA PARC 2/3",
            amount: "100,00",
            installment: "PARC 2/3",
          },
          cycle: { invoiceDueMonth: "2025-11", reference: cycleReference },
          dateOnly: "2024-06-22",
          merchant: "LOJA",
          amountCents: 10000,
          amountMeaning: "INSTALLMENT_CHARGE",
          installmentCount: 3,
          installmentIndex: 2,
          fitId: null,
        },
      ],
      diagnostics: [],
    };
  }
  it.each(cases.map((fixture) => ({ version: fixture[0], fixture })))(
    "accepts_and_freezes $version without_changing_text_branch",
    ({ fixture }) => {
      const dto = binaryDto(fixture);
      const validated = documentParser.validateDocumentExtraction(dto);
      expect(validated).toStrictEqual(dto);
      expect(validated).not.toBe(dto);
      for (const part of [
        validated,
        validated.metrics,
        validated.occurrences,
        validated.occurrences[0],
        validated.occurrences[0].raw,
        validated.occurrences[0].cycle,
        validated.diagnostics,
      ])
        expect(Object.isFrozen(part)).toBe(true);
    },
  );
  it.each(cases.map((fixture) => ({ version: fixture[0], fixture })))(
    "text_version_still_refuses_binary_locator_and_metrics_$version",
    ({ fixture }) => {
      const dto = {
        ...binaryDto(fixture),
        parserVersion: "card-local-text-v1",
      };
      expect(() => documentParser.validateDocumentExtraction(dto)).toThrow(
        expect.objectContaining({ code: "INVALID_RESULT" }),
      );
    },
  );
});

describe("X2 builder: lexical capture cannot discard recognizable rows", () => {
  it("pdf_missing_date_and_ISO_date_are_not_silently_lost", async () => {
    const result = await binaryExtractor()(
      inputFor(
        "PDF",
        textPdf([
          [
            "Fatura de cartao",
            "Lancamentos desta fatura",
            "Data Descricao Valor",
            "SEM DATA 1,00",
            "2024-06-22 HISTORICA 2,00",
            "Total 3,00",
          ],
        ]),
      ),
    );
    expect(
      result.occurrences.map((row) => [
        row.reference,
        row.sourceOrdinal,
        row.raw.date,
        row.raw.description,
        row.raw.amount,
        row.dateOnly,
        row.amountCents,
        row.identityOrdinal,
      ]),
    ).toStrictEqual([
      ["pdf:page:1:line:4", 0, null, "SEM DATA", "1,00", null, 100, null],
      [
        "pdf:page:1:line:5",
        1,
        "2024-06-22",
        "HISTORICA",
        "2,00",
        "2024-06-22",
        200,
        0,
      ],
    ]);
  });

  it("pdf_date_only_is_an_incomplete_occurrence_not_an_unsupported_page", async () => {
    const result = await binaryExtractor()(
      inputFor(
        "PDF",
        textPdf([
          [
            "Fatura de cartao",
            "Lancamentos desta fatura",
            "Data Descricao Valor",
            "22/06/2024",
            "22/06/2024 LOJA 1,00",
          ],
        ]),
      ),
    );
    expect(
      result.occurrences.map((row) => ({
        reference: row.reference,
        ordinal: row.sourceOrdinal,
        raw: row.raw,
        date: row.dateOnly,
        merchant: row.merchant,
        cents: row.amountCents,
        identity: row.identityOrdinal,
      })),
    ).toStrictEqual([
      {
        reference: "pdf:page:1:line:4",
        ordinal: 0,
        raw: {
          date: "22/06/2024",
          description: null,
          amount: null,
          installment: null,
        },
        date: "2024-06-22",
        merchant: null,
        cents: null,
        identity: null,
      },
      {
        reference: "pdf:page:1:line:5",
        ordinal: 1,
        raw: {
          date: "22/06/2024",
          description: "LOJA",
          amount: "1,00",
          installment: null,
        },
        date: "2024-06-22",
        merchant: "LOJA",
        cents: 100,
        identity: 0,
      },
    ]);
  });

  it.each(["XLS", "XLSX"] as const)(
    "%s_merchant_text_is_not_a_section_heading",
    async (format) => {
      const result = await binaryExtractor()(
        inputFor(
          format,
          spreadsheet(
            [
              ["Fatura de cartao"],
              ["Vencimento 10/11/2025"],
              ["Data", "Descricao", "Valor"],
              ["22/06/2024", "Proximas faturas", "1,00"],
              ["22/06/2024", "Vencimento 10/12/2025", "2,00"],
              [undefined, "Fatura de cartao", "3,00"],
            ],
            format,
          ),
        ),
      );
      expect(
        result.occurrences.map((row) => [
          row.raw.description,
          row.amountCents,
          row.section,
          row.cycle?.invoiceDueMonth,
        ]),
      ).toStrictEqual([
        ["Proximas faturas", 100, "CURRENT", "2025-11"],
        ["Vencimento 10/12/2025", 200, "CURRENT", "2025-11"],
        ["Fatura de cartao", 300, "CURRENT", "2025-11"],
      ]);
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "%s_transaction_before_recognized_header_is_not_silently_lost",
    async (format) => {
      await expect(
        binaryExtractor()(
          inputFor(
            format,
            spreadsheet(
              [
                ["22/06/2024", "UNACCOUNTED", "10,00"],
                ["Data", "Descricao", "Valor"],
                ["22/06/2024", "ACCOUNTED", "1,00"],
              ],
              format,
            ),
          ),
        ),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_DOCUMENT",
        reason: "UNSUPPORTED_LAYOUT",
      });
    },
  );
});

describe.each(["XLS", "XLSX"] as const)("X2 G1/G2 real %s rows", (format) => {
  const prefix = format.toLowerCase();

  it("G1_total_prefix_with_explicit_date_is_a_purchase_not_a_footer", async () => {
    const bytes = spreadsheet(
      [
        ["Descricao", "Data", "Valor"],
        ["TOTAL ATACADO", "22/06/2024", "100,00"],
        ["LOJA", "22/06/2024", "1,00"],
      ],
      format,
    );
    expect(bytes.subarray(0, format === "XLS" ? 8 : 4).toString("hex")).toBe(
      format === "XLS" ? "d0cf11e0a1b11ae1" : "504b0304",
    );
    expect(XLSX.read(bytes, { type: "buffer" }).Sheets.Fatura.B2).toMatchObject(
      {
        t: "s",
        v: "22/06/2024",
      },
    );
    const result = await binaryExtractor()(inputFor(format, bytes));
    expect(result.metrics.rows).toBe(2);
    expect(result.occurrences).toMatchObject([
      {
        reference: `${prefix}:sheet:1:row:2`,
        sourceOrdinal: 0,
        identityOrdinal: 0,
        raw: {
          date: "22/06/2024",
          description: "TOTAL ATACADO",
          amount: "100,00",
          installment: null,
        },
        dateOnly: "2024-06-22",
        merchant: "TOTAL ATACADO",
        amountCents: 10000,
        section: "UNKNOWN",
        cycle: null,
      },
      {
        reference: `${prefix}:sheet:1:row:3`,
        sourceOrdinal: 1,
        identityOrdinal: 0,
        raw: {
          date: "22/06/2024",
          description: "LOJA",
          amount: "1,00",
          installment: null,
        },
        dateOnly: "2024-06-22",
        merchant: "LOJA",
        amountCents: 100,
        section: "UNKNOWN",
        cycle: null,
      },
    ]);
    expect(result.diagnostics).toStrictEqual([
      { reference: `${prefix}:sheet:1:row:2`, code: "UNKNOWN_AMOUNT_MEANING" },
      { reference: `${prefix}:sheet:1:row:3`, code: "UNKNOWN_AMOUNT_MEANING" },
    ]);
  });

  it("G2_numeric_date_only_45465_retains_incomplete_row_before_complete_row", async () => {
    const bytes = spreadsheet(
      [["Data", "Descricao", "Valor"], [45465], ["22/06/2024", "LOJA", "1,00"]],
      format,
    );
    expect(bytes.subarray(0, format === "XLS" ? 8 : 4).toString("hex")).toBe(
      format === "XLS" ? "d0cf11e0a1b11ae1" : "504b0304",
    );
    expect(XLSX.read(bytes, { type: "buffer" }).Sheets.Fatura.A2).toMatchObject(
      {
        t: "n",
        v: 45465,
      },
    );
    const result = await binaryExtractor()(inputFor(format, bytes));
    expect(result.metrics.rows).toBe(2);
    expect(result.occurrences).toMatchObject([
      {
        reference: `${prefix}:sheet:1:row:2`,
        sourceOrdinal: 0,
        identityOrdinal: null,
        raw: {
          date: "45465",
          description: null,
          amount: null,
          installment: null,
        },
        dateOnly: "2024-06-22",
        merchant: null,
        amountCents: null,
        section: "UNKNOWN",
        cycle: null,
      },
      {
        reference: `${prefix}:sheet:1:row:3`,
        sourceOrdinal: 1,
        identityOrdinal: 0,
        raw: {
          date: "22/06/2024",
          description: "LOJA",
          amount: "1,00",
          installment: null,
        },
        dateOnly: "2024-06-22",
        merchant: "LOJA",
        amountCents: 100,
        section: "UNKNOWN",
        cycle: null,
      },
    ]);
    expect(result.diagnostics).toStrictEqual([
      { reference: `${prefix}:sheet:1:row:2`, code: "UNREADABLE_ROW" },
      { reference: `${prefix}:sheet:1:row:2`, code: "UNKNOWN_AMOUNT_MEANING" },
      { reference: `${prefix}:sheet:1:row:3`, code: "UNKNOWN_AMOUNT_MEANING" },
    ]);
  });

  it.each([
    { date1904: false, serial: 45465 },
    { date1904: true, serial: 44003 },
  ])(
    "G1_calendar $date1904 keeps_prefixes_incomplete_dates_and_global_twins",
    async ({ date1904, serial }) => {
      const result = await binaryExtractor()(
        inputFor(
          format,
          spreadsheet(
            [
              ["Descricao", "Data", "Valor"],
              ["TOTAL ATACADO", "22/06/2024", "100,00"],
              ["SUBTOTAL MERCADO", "22/06"],
              ["SALDO MERCADO", serial],
              ["LIMITE LOJA", "31/02/2024", 0],
              [undefined, "Total da fatura", "100,00"],
              [undefined, "Subtotal", "100,00"],
              [undefined, "Saldo anterior", "100,00"],
              [undefined, "Limite disponivel", "200,00"],
              ["TOTAL ATACADO", "22/06/2024", "100,00"],
            ],
            format,
            { date1904 },
          ),
        ),
      );
      expect(result.metrics.rows).toBe(5);
      expect(
        result.occurrences.map((row) => [
          row.reference,
          row.sourceOrdinal,
          row.identityOrdinal,
          row.raw.date,
          row.raw.description,
          row.raw.amount,
          row.dateOnly,
          row.merchant,
          row.amountCents,
        ]),
      ).toStrictEqual([
        [
          `${prefix}:sheet:1:row:2`,
          0,
          0,
          "22/06/2024",
          "TOTAL ATACADO",
          "100,00",
          "2024-06-22",
          "TOTAL ATACADO",
          10000,
        ],
        [
          `${prefix}:sheet:1:row:3`,
          1,
          null,
          "22/06",
          "SUBTOTAL MERCADO",
          null,
          null,
          "SUBTOTAL MERCADO",
          null,
        ],
        [
          `${prefix}:sheet:1:row:4`,
          2,
          null,
          String(serial),
          "SALDO MERCADO",
          null,
          "2024-06-22",
          "SALDO MERCADO",
          null,
        ],
        [
          `${prefix}:sheet:1:row:5`,
          3,
          null,
          "31/02/2024",
          "LIMITE LOJA",
          "0",
          null,
          "LIMITE LOJA",
          0,
        ],
        [
          `${prefix}:sheet:1:row:10`,
          4,
          1,
          "22/06/2024",
          "TOTAL ATACADO",
          "100,00",
          "2024-06-22",
          "TOTAL ATACADO",
          10000,
        ],
      ]);
      expect(result.diagnostics).toStrictEqual([
        {
          reference: `${prefix}:sheet:1:row:2`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
        { reference: `${prefix}:sheet:1:row:3`, code: "UNKNOWN_DATE" },
        { reference: `${prefix}:sheet:1:row:3`, code: "UNREADABLE_ROW" },
        {
          reference: `${prefix}:sheet:1:row:3`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
        { reference: `${prefix}:sheet:1:row:4`, code: "UNREADABLE_ROW" },
        {
          reference: `${prefix}:sheet:1:row:4`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
        { reference: `${prefix}:sheet:1:row:5`, code: "INVALID_CALENDAR_DATE" },
        {
          reference: `${prefix}:sheet:1:row:5`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
        {
          reference: `${prefix}:sheet:1:row:10`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
      ]);
    },
  );

  it.each([
    {
      name: "1904-numeric",
      value: 44003,
      date1904: true,
      date: "2024-06-22",
      code: null,
    },
    {
      name: "1900-serial60",
      value: 60,
      date1904: false,
      date: null,
      code: "INVALID_CALENDAR_DATE",
    },
    {
      name: "1904-serial60",
      value: 60,
      date1904: true,
      date: "1904-03-01",
      code: null,
    },
    {
      name: "1900-text",
      value: "22/06/2024",
      date1904: false,
      date: "2024-06-22",
      code: null,
    },
    {
      name: "1904-text",
      value: "22/06/2024",
      date1904: true,
      date: "2024-06-22",
      code: null,
    },
    {
      name: "missing-year",
      value: "22/06",
      date1904: false,
      date: null,
      code: "UNKNOWN_DATE",
    },
    {
      name: "two-digit-year",
      value: "22/06/24",
      date1904: true,
      date: null,
      code: "UNKNOWN_DATE",
    },
    {
      name: "invalid-calendar",
      value: "31/02/2024",
      date1904: false,
      date: null,
      code: "INVALID_CALENDAR_DATE",
    },
  ] as const)(
    "G2_date_only $name preserves_raw_and_nullable_facts",
    async ({ value, date1904, date, code }) => {
      const bytes = spreadsheet(
        [
          ["Data", "Descricao", "Valor"],
          ["22/06/2024", "LOJA", "1,00"],
          [value],
          [],
          ["22/06/2024", "LOJA", "1,00"],
        ],
        format,
        { date1904 },
      );
      expect(
        XLSX.read(bytes, { type: "buffer" }).Sheets.Fatura.A3,
      ).toMatchObject({
        t: typeof value === "number" ? "n" : "s",
        v: value,
      });
      const result = await binaryExtractor()(inputFor(format, bytes));
      expect(result.metrics.rows).toBe(3);
      expect(
        result.occurrences.map((row) => [
          row.reference,
          row.sourceOrdinal,
          row.identityOrdinal,
          row.raw.date,
          row.raw.description,
          row.raw.amount,
          row.dateOnly,
          row.merchant,
          row.amountCents,
        ]),
      ).toStrictEqual([
        [
          `${prefix}:sheet:1:row:2`,
          0,
          0,
          "22/06/2024",
          "LOJA",
          "1,00",
          "2024-06-22",
          "LOJA",
          100,
        ],
        [
          `${prefix}:sheet:1:row:3`,
          1,
          null,
          String(value),
          null,
          null,
          date,
          null,
          null,
        ],
        [
          `${prefix}:sheet:1:row:5`,
          2,
          1,
          "22/06/2024",
          "LOJA",
          "1,00",
          "2024-06-22",
          "LOJA",
          100,
        ],
      ]);
      expect(result.diagnostics).toStrictEqual([
        {
          reference: `${prefix}:sheet:1:row:2`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
        ...(code === null
          ? []
          : [{ reference: `${prefix}:sheet:1:row:3`, code }]),
        { reference: `${prefix}:sheet:1:row:3`, code: "UNREADABLE_ROW" },
        {
          reference: `${prefix}:sheet:1:row:3`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
        {
          reference: `${prefix}:sheet:1:row:5`,
          code: "UNKNOWN_AMOUNT_MEANING",
        },
      ]);
    },
  );

  it("G1_structural_footers_do_not_become_transactions_or_consume_ordinals", async () => {
    const result = await binaryExtractor()(
      inputFor(
        format,
        spreadsheet(
          [
            ["Data", "Descricao", "Valor"],
            ["22/06/2024", "LOJA", "1,00"],
            ["Total da fatura", null, "1,00"],
            ["Subtotal", "", 0],
            ["Saldo anterior", " ", -1],
            ["Limite disponivel", null, 2],
            ["22/06/2024", "LOJA", "1,00"],
          ],
          format,
        ),
      ),
    );
    expect(result.metrics.rows).toBe(2);
    expect(
      result.occurrences.map((row) => [
        row.reference,
        row.sourceOrdinal,
        row.identityOrdinal,
        row.dateOnly,
        row.merchant,
        row.amountCents,
      ]),
    ).toStrictEqual([
      [`${prefix}:sheet:1:row:2`, 0, 0, "2024-06-22", "LOJA", 100],
      [`${prefix}:sheet:1:row:7`, 1, 1, "2024-06-22", "LOJA", 100],
    ]);
    expect(result.diagnostics).toStrictEqual([
      { reference: `${prefix}:sheet:1:row:2`, code: "UNKNOWN_AMOUNT_MEANING" },
      { reference: `${prefix}:sheet:1:row:7`, code: "UNKNOWN_AMOUNT_MEANING" },
    ]);
  });

  it.each([
    {
      name: "date-column-with-merchant",
      header: ["Data", "Descricao", "Valor"],
      ambiguous: ["Total", "LOJA", "100,00"],
      complete: ["22/06/2024", "LOJA", "1,00"],
    },
    {
      name: "merchant-column-without-date",
      header: ["Descricao", "Data", "Valor"],
      ambiguous: ["Total da fatura", undefined, "100,00"],
      complete: ["LOJA", "22/06/2024", "1,00"],
    },
  ])(
    "G1_ambiguous_total $name refuses_without_partial_success_or_fabrication",
    async ({ header, ambiguous, complete }) => {
      await expect(
        binaryExtractor()(
          inputFor(format, spreadsheet([header, ambiguous, complete], format)),
        ),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_DOCUMENT",
        reason: "UNSUPPORTED_LAYOUT",
      });
    },
  );
});
