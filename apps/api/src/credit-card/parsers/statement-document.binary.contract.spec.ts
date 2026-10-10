import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";
import * as documentModule from "./statement-document";
import { computeImportOrdinals } from "./dedupe-key";
import { parsePdfStatement } from "./pdf";
import { parseXlsx } from "./xlsx";
import {
  DocumentExtractionError,
  type DocumentExtractionV1,
  type DocumentOccurrenceV1,
  type ParseResult,
} from "./types";

type Format = "PDF" | "XLS" | "XLSX";
type BinaryVersion =
  | "card-local-pdf-v1"
  | "card-local-xls-v1"
  | "card-local-xlsx-v1";
type BinaryDocument = Omit<DocumentExtractionV1, "parserVersion"> & {
  readonly parserVersion: BinaryVersion;
};
type BinaryInput =
  | {
      version: 1;
      context: "CARD_INVOICE";
      format: "PDF";
      profile: "PDF_TEXT_CARD";
      bytes: Buffer;
    }
  | {
      version: 1;
      context: "CARD_INVOICE";
      format: "XLS";
      profile: "XLS_CARD";
      bytes: Buffer;
    }
  | {
      version: 1;
      context: "CARD_INVOICE";
      format: "XLSX";
      profile: "XLSX_CARD";
      bytes: Buffer;
    };
type BinaryExtractor = (input: BinaryInput) => Promise<BinaryDocument>;
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

// Import failures propagate normally; only this absent export gets the API-RED marker.
function binaryExtractor(): BinaryExtractor {
  const exports: object = documentModule;
  if (
    !("extractCardStatementBinaryDocument" in exports) ||
    typeof exports.extractCardStatementBinaryDocument !== "function"
  ) {
    throw new Error(
      "X2_API_ABSENT: statement-document.extractCardStatementBinaryDocument",
    );
  }
  return exports.extractCardStatementBinaryDocument as BinaryExtractor;
}

function input(format: Format, bytes: Buffer): BinaryInput {
  if (format === "PDF")
    return {
      version: 1,
      context: "CARD_INVOICE",
      format,
      profile: "PDF_TEXT_CARD",
      bytes,
    };
  if (format === "XLS")
    return {
      version: 1,
      context: "CARD_INVOICE",
      format,
      profile: "XLS_CARD",
      bytes,
    };
  return {
    version: 1,
    context: "CARD_INVOICE",
    format,
    profile: "XLSX_CARD",
    bytes,
  };
}

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pdf(pages: readonly (readonly string[])[], imageOnly = false): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, lines] of pages.entries()) {
    const content = imageOnly
      ? "q 100 0 0 100 40 40 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID 000000> EI Q"
      : lines
          .map((line, i) => {
            const escaped = line.replace(/([\\()])/g, "\\$1");
            return `BT /F1 8 Tf 1 0 0 1 40 ${780 - i * 12} Tm (${escaped}) Tj ET`;
          })
          .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// pypdf 6.10.2, one synthetic blank page, RC4-128; generated secret discarded.
const ENCRYPTED_PDF =
  "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDUxMGM5NTFkZTI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA2MTIgNzkyIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8ZmJlNmEwZDc3NzI1NzBjMzJhMzUzYjBmNTVkM2Q0NzY3YjZhMWMyYzVjZjhmMDMyNWIwMTYzOThiZTBiMzhhNT4KL1UgPGNkMWVhMjQzOGExZWEzZjdiODNiOWFmODY4MWFmMzI5MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1NjEzMTMyNjIzNzY0MzczODM1NjEzNjY0MzUzNTM3MzUzNjM5NjI2MjM3MzA2NDMyMzQzMjMyNjEzNzMwMzk+IDwzNTYxMzEzMjYyMzc2NDM3MzgzNTYxMzY2NDM1MzUzNzM1MzYzOTYyNjIzNzMwNjQzMjM0MzIzMjYxMzczMDM5PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK";

const HEADER = ["Data", "Descricao", "Valor", "Parcelamento"];
const PREAMBLE = [
  "Fatura de cartao",
  "Vencimento 10/11/2025",
  "Lancamentos desta fatura",
  "Data  Descricao  Valor",
];
const CYCLE_LINES = [
  ...PREAMBLE,
  "22/06/2024  LOJA PARC 2/3  100,00",
  "22/06/2024  LOJA PARC 2/3  100,00",
  "Proximas faturas",
  "22/06/2024  LOJA PARC 3/3  100,00",
  "Vencimento 10/12/2025",
  "22/06/2024  LOJA PARC 3/3  100,00",
];
type Cell = string | number | null;

function workbook(
  rows: Cell[][],
  options: {
    date1904?: boolean;
    extra?: "visible" | "hidden" | "empty" | "unsupported";
  } = {},
): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  book.Props = {
    CreatedDate: new Date("2025-01-01T00:00:00.000Z"),
    ModifiedDate: new Date("2025-01-01T00:00:00.000Z"),
  };
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Fatura");
  book.Workbook = { WBProps: { date1904: options.date1904 ?? false } };
  if (options.extra) {
    const extra =
      options.extra === "empty"
        ? []
        : options.extra === "unsupported"
          ? [["alien table", 77]]
          : [HEADER, ["22/06/2024", "OUTRA", "1,00"]];
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(extra), "Outra");
    book.Workbook.Sheets = [
      { name: "Fatura", Hidden: 0 },
      { name: "Outra", Hidden: options.extra === "hidden" ? 1 : 0 },
    ];
  }
  return book;
}

function excel(
  format: "XLS" | "XLSX",
  rows: Cell[][],
  options: Parameters<typeof workbook>[1] = {},
  compression = false,
): Buffer {
  const bytes: unknown = XLSX.write(workbook(rows, options), {
    bookType: format === "XLS" ? "biff8" : "xlsx",
    type: "buffer",
    compression,
  });
  if (!Buffer.isBuffer(bytes))
    throw new Error("Fixture writer did not produce bytes");
  return bytes;
}

const ROWS: Cell[][] = [
  ["Fatura de cartao"],
  ["Vencimento 10/11/2025"],
  HEADER,
  ["22/06/2024", "LOJA", "100,00", "Parcela 2 de 3"],
  [],
  ["22/06/2024", "LOJA", "100,00", "Parcela 2 de 3"],
  ["22/06/2024", "CREDITO", "-2,00"],
];

function row(
  overrides: Partial<DocumentOccurrenceV1> = {},
): Mutable<DocumentOccurrenceV1> {
  return {
    reference: "pdf:page:1:line:5",
    sourceOrdinal: 0,
    section: "CURRENT",
    raw: {
      date: "22/06/2024",
      description: "LOJA PARC 2/3",
      amount: "100,00",
      installment: "PARC 2/3",
    },
    cycle: { invoiceDueMonth: "2025-11", reference: "pdf:page:1:line:2" },
    dateOnly: "2024-06-22",
    merchant: "LOJA",
    amountCents: 10000,
    amountMeaning: "INSTALLMENT_CHARGE",
    installmentCount: 3,
    installmentIndex: 2,
    fitId: null,
    identityOrdinal: 0,
    ...overrides,
  };
}

function dto(format: Format = "PDF"): Mutable<BinaryDocument> {
  const prefix = format.toLowerCase();
  return {
    version: 1,
    parserVersion:
      format === "PDF"
        ? "card-local-pdf-v1"
        : format === "XLS"
          ? "card-local-xls-v1"
          : "card-local-xlsx-v1",
    documentKind: "INVOICE",
    invoiceDueMonth: "2025-11",
    metrics: {
      pages: format === "PDF" ? 1 : 0,
      rows: 1,
      expandedBytes: format === "PDF" ? 0 : 128,
      archiveEntries: format === "PDF" ? 0 : 8,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: [
      row(
        format === "PDF"
          ? {}
          : {
              reference: `${prefix}:sheet:1:row:4`,
              cycle: {
                invoiceDueMonth: "2025-11",
                reference: `${prefix}:sheet:1:cell:A2`,
              },
            },
      ),
    ],
    diagnostics: [],
  };
}

function validated(value: unknown): DocumentExtractionV1 {
  return documentModule.validateDocumentExtraction(value);
}

function expectError(
  action: () => unknown,
  code: DocumentExtractionError["code"],
): void {
  expect(action).toThrow(DocumentExtractionError);
  expect(action).toThrow(expect.objectContaining({ code }));
}

async function refusal(
  action: Promise<unknown>,
  code: DocumentExtractionError["code"],
  reason?: string,
): Promise<void> {
  let error: unknown;
  try {
    await action;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DocumentExtractionError);
  expect(error).toMatchObject({ code, ...(reason ? { reason } : {}) });
  if (!(error instanceof Error)) throw new Error("Expected extraction refusal");
  expect(error.message).not.toMatch(
    /PRIVATE_SOURCE_MUST_NOT_LEAK|SYNTHETIC_PRIVATE|Invalid PDF|PasswordException/,
  );
}

function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) frozen(child);
}

function observation(result: BinaryDocument) {
  return result.occurrences.map((item) => ({
    reference: item.reference,
    source: item.sourceOrdinal,
    identity: item.identityOrdinal,
    merchant: item.merchant,
    section: item.section,
    cycle: item.cycle,
    date: item.dateOnly,
    cents: item.amountCents,
  }));
}

function serialized(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(serialized);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serialized(item)]),
    );
  return value;
}

function legacyGolden(format: "XLS" | "XLSX"): {
  pdf: ParseResult;
  excel: ParseResult;
  empty: ParseResult;
} {
  const missing = {
    rawCategory: undefined,
    installmentCurrent: undefined,
    installmentTotal: undefined,
  };
  return {
    pdf: {
      source: "PDF",
      periodLabel: "2025-06",
      transactions: [
        {
          externalId: "8edccf476da501ecdbf418a9f2edccaa",
          date: new Date("2025-06-22T00:00:00.000Z"),
          merchant: "LOJA",
          amountCents: 10000,
          installmentCurrent: 2,
          installmentTotal: 3,
          isFuture: false,
        },
      ],
      totalAmountCents: 10000,
      futureInstallments: [
        {
          externalId: "f215744187d98926677536acc9c63466",
          date: new Date("2025-06-22T00:00:00.000Z"),
          merchant: "LOJA",
          amountCents: 10000,
          installmentCurrent: 3,
          installmentTotal: 3,
          isFuture: true,
        },
      ],
    },
    excel: {
      source: "XLSX",
      transactions: [
        {
          ...missing,
          externalId: "eab046b44d109275d799bf626897d896",
          date: new Date("2024-06-22T00:00:00.000Z"),
          merchant: "LOJA",
          amountCents: 10000,
          installmentCurrent: 2,
          installmentTotal: 3,
        },
        {
          ...missing,
          externalId: "f73869d6b3570fd119360f5214210e31",
          date: new Date("2024-06-22T00:00:00.000Z"),
          merchant: "LOJA",
          amountCents: 10000,
          installmentCurrent: 2,
          installmentTotal: 3,
        },
        {
          ...missing,
          externalId: "3eb7c08aa342fdb08104ab207b0b0573",
          date: new Date("2024-06-22T00:00:00.000Z"),
          merchant: "CREDITO",
          amountCents: -200,
        },
        {
          ...missing,
          externalId: "ceff3e6788496de6872e7bb9e3a8a740",
          date: new Date(
            process.env.TZ === "America/Sao_Paulo"
              ? "2025-11-01T03:00:00.000Z"
              : "2025-11-01T00:00:00.000Z",
          ),
          merchant: "SERIAL",
          amountCents: 100,
        },
        {
          ...missing,
          externalId: "c0299c6066e5df8846335f9b4485d8f6",
          date: new Date("2024-03-02T00:00:00.000Z"),
          merchant: "ROLLOVER",
          amountCents: 50,
        },
      ],
      totalAmountCents: 19950,
      periodLabel: "2024-06",
      invoiceDueMonth: undefined,
    },
    empty: {
      source: "XLSX",
      transactions: [],
      totalAmountCents: 0,
      error:
        format === "XLS"
          ? "N\u00e3o identifiquei as colunas de data, descri\u00e7\u00e3o e valor. Exporte como CSV ou OFX."
          : "Nenhuma linha no Excel",
    },
  };
}

interface Container {
  FullPaths: string[];
  FileIndex: {
    name: string;
    type: number;
    size: number;
    content: Uint8Array;
  }[];
}
const fixtureContainer: {
  read(bytes: Buffer, options: { type: "buffer" }): Container;
  write(
    container: Container,
    options: { type: "buffer"; fileType: "zip"; compression: boolean },
  ): Buffer;
  utils: { cfb_add(container: Container, path: string, content: Buffer): void };
} = XLSX.CFB;

function sparseDimension(dimension: string): Buffer {
  const container = fixtureContainer.read(excel("XLSX", ROWS), {
    type: "buffer",
  });
  const index = container.FullPaths.findIndex((path) =>
    path.endsWith("/xl/worksheets/sheet1.xml"),
  );
  if (index < 0) throw new Error("Fixture worksheet XML is absent");
  const xml = Buffer.from(container.FileIndex[index].content).toString("utf8");
  if (!/<dimension ref="[^"]+"\/>/.test(xml))
    throw new Error("Fixture dimension is absent");
  fixtureContainer.utils.cfb_add(
    container,
    container.FullPaths[index],
    Buffer.from(
      xml.replace(
        /<dimension ref="[^"]+"\/>/,
        `<dimension ref="${dimension}"/>`,
      ),
    ),
  );
  return fixtureContainer.write(container, {
    type: "buffer",
    fileType: "zip",
    compression: false,
  });
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: [
      "nextTick",
      "setImmediate",
      "setTimeout",
      "clearTimeout",
      "performance",
      "queueMicrotask",
    ],
  });
  jest.setSystemTime(new Date("2025-11-15T12:00:00.000Z"));
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("X2 independent fixture and legacy controls", () => {
  it("controls_source_domain_guard_and_dependency_resolution_are_explicit", () => {
    const root = resolve(__dirname, "../../../../..");
    expect(require.resolve("./statement-document")).toBe(
      resolve(__dirname, "statement-document.ts"),
    );
    expect(require.resolve("@reformaflow/domain")).toBe(
      resolve(root, "packages/domain/src/index.ts"),
    );
    expect(require.resolve("../../../../../scripts/test-db-env.cjs")).toBe(
      resolve(root, "scripts/test-db-env.cjs"),
    );
    expect(process.env.DATABASE_URL).toBe(
      `file:${root}/prisma/x2-unit-unused.db`,
    );
    expect(require("xlsx/package.json").version).toBe("0.18.5");
    expect(
      require(
        resolve(dirname(require.resolve("pdf-parse")), "../../../package.json"),
      ).version,
    ).toBe("2.4.5");
    console.info(
      "X2_RESOLUTION",
      JSON.stringify({
        source: require.resolve("./statement-document"),
        domain: require.resolve("@reformaflow/domain"),
        guard: require.resolve("../../../../../scripts/test-db-env.cjs"),
        pdf: require.resolve("pdf-parse"),
        xlsx: require.resolve("xlsx"),
        database: process.env.DATABASE_URL,
      }),
    );
  });

  it("controls_real_pdf_pages_and_lines_are_recoverable_without_normalization", async () => {
    const bytes = pdf([CYCLE_LINES, [PREAMBLE[0], CYCLE_LINES[4]]]);
    const parser = new PDFParse({
      data: bytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      stopAtErrors: true,
    });
    try {
      expect((await parser.getInfo()).total).toBe(2);
      const result = await parser.getText({
        partial: [1],
        disableNormalization: true,
        pageJoiner: "",
      });
      expect(result.pages.map((page) => page.num)).toStrictEqual([1]);
      expect(result.pages[0].text.trimEnd().split("\n")).toStrictEqual([
        "Fatura de cartao",
        "Vencimento 10/11/2025",
        "Lancamentos desta fatura",
        "Data Descricao Valor",
        "22/06/2024 LOJA PARC 2/3 100,00",
        "22/06/2024 LOJA PARC 2/3 100,00",
        "Proximas faturas",
        "22/06/2024 LOJA PARC 3/3 100,00",
        "Vencimento 10/12/2025",
        "22/06/2024 LOJA PARC 3/3 100,00",
      ]);
      console.info(
        "X2_FIXTURE_PDF",
        JSON.stringify({
          sha256: sha(bytes),
          base64: bytes.toString("base64"),
          decoded: result.pages[0].text,
        }),
      );
    } finally {
      await parser.destroy();
    }
  });

  it.each(["XLS", "XLSX"] as const)(
    "controls_%s_has_genuine_format_rows_and_inventory",
    (format) => {
      const bytes = excel(format, ROWS);
      expect(bytes.subarray(0, format === "XLS" ? 8 : 4).toString("hex")).toBe(
        format === "XLS" ? "d0cf11e0a1b11ae1" : "504b0304",
      );
      const book = XLSX.read(bytes, { type: "buffer", bookFiles: true });
      expect(book.SheetNames).toStrictEqual(["Fatura"]);
      expect(book.Sheets.Fatura.A4.v).toBe("22/06/2024");
      expect(book.Sheets.Fatura.A5).toBeUndefined();
      expect(book.Sheets.Fatura.D6.v).toBe("Parcela 2 de 3");
      console.info(
        "X2_FIXTURE_EXCEL",
        JSON.stringify({
          format,
          sha256: sha(bytes),
          base64: bytes.toString("base64"),
          inventoryKeys: Object.keys(book).sort(),
        }),
      );
    },
  );

  it("controls_encrypted_and_scanned_are_real_pdf_library_cases", async () => {
    const encrypted = new PDFParse({
      data: Buffer.from(ENCRYPTED_PDF, "base64"),
    });
    const scanned = new PDFParse({ data: pdf([[]], true) });
    try {
      await expect(encrypted.getInfo()).rejects.toMatchObject({
        name: "PasswordException",
      });
      expect((await scanned.getInfo()).total).toBe(1);
      expect(
        (await scanned.getText({ pageJoiner: "" })).pages[0].text.trim(),
      ).toBe("");
    } finally {
      await Promise.all([encrypted.destroy(), scanned.destroy()]);
    }
  });

  it.each(["A1:A1", "A1:XFD1048576"])(
    "controls_sparse_fixture_%s_keeps_real_cells_outside_advertised_range",
    (dimension) => {
      const bytes = sparseDimension(dimension);
      const book = XLSX.read(bytes, { type: "buffer" });
      expect(book.Sheets.Fatura["!ref"]).toBe(
        dimension === "A1:A1" ? "A1" : "A1:XFD1048576",
      );
      expect(book.Sheets.Fatura.A7.v).toBe("22/06/2024");
      expect(book.Sheets.Fatura.C7.v).toBe("-2,00");
      expect(bytes.length).toBeLessThan(20000);
      console.info(
        "X2_FIXTURE_DIMENSION",
        JSON.stringify({
          dimension,
          bytes: bytes.length,
          sha256: sha(bytes),
          base64: bytes.toString("base64"),
        }),
      );
    },
  );

  it.each([false, true])(
    "controls_zip_compression_method_%s",
    (compression) => {
      const bytes = excel("XLSX", ROWS, {}, compression);
      expect(bytes.readUInt16LE(8)).toBe(compression ? 8 : 0);
      expect(XLSX.read(bytes, { type: "buffer" }).Sheets.Fatura.D6.v).toBe(
        "Parcela 2 de 3",
      );
      console.info(
        "X2_FIXTURE_ZIP_METHOD",
        JSON.stringify({
          compression,
          bytes: bytes.length,
          sha256: sha(bytes),
        }),
      );
    },
  );

  it("controls_original_identity_example_uses_captured_merchant_not_invented_facts", () => {
    const text = documentModule.extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes: Buffer.from(
        "date,title,amount\n2024-06-22,LOJA PARC 2/3,100.00\n2024-06-22,LOJA PARC 3/3,100.00",
      ),
    });
    expect(
      text.occurrences.map((r) => [
        r.merchant,
        r.amountCents,
        r.identityOrdinal,
      ]),
    ).toStrictEqual([
      ["LOJA", 10000, 0],
      ["LOJA", 10000, 1],
    ]);
    expect(
      computeImportOrdinals([
        {
          date: new Date("2024-06-22T00:00:00.000Z"),
          merchant: "LOJA",
          amountCents: 10000,
        },
        {
          date: new Date("2024-06-22T00:00:00.000Z"),
          merchant: " loja ",
          amountCents: 10000,
        },
        {
          date: new Date("2024-06-22T00:00:00.000Z"),
          merchant: "LOJA",
          amountCents: 10001,
        },
      ]),
    ).toStrictEqual([0, 1, 0]);
  });

  it("controls_text_api_is_synchronous_and_rejects_binary_inputs", () => {
    const request = {
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes: Buffer.from("date,title,amount\n2024-06-22,LOJA PARC 2/3,100.00"),
    } as const;
    const result = documentModule.extractCardStatementDocument(request);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toStrictEqual({
      ...dto(),
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
        row({
          reference: "csv:record:2",
          section: "UNKNOWN",
          cycle: null,
          raw: {
            date: "2024-06-22",
            description: "LOJA PARC 2/3",
            amount: "100.00",
            installment: "PARC 2/3",
          },
        }),
      ],
    });
    frozen(result);
    const legacy: (arg: unknown) => unknown =
      documentModule.extractCardStatementDocument as (arg: unknown) => unknown;
    for (const format of ["PDF", "XLS", "XLSX"] as const)
      expectError(
        () => legacy(input(format, Buffer.alloc(0))),
        "INVALID_INPUT",
      );
  });

  it.each(["XLS", "XLSX"] as const)(
    "legacy_pdf_xls_xlsx_results_match_complete_871_goldens_%s",
    async (format) => {
      const results = {
        pdf: await parsePdfStatement(pdf([CYCLE_LINES]), "qa-card"),
        excel: parseXlsx(
          excel(format, [
            ...ROWS,
            [45962, "SERIAL", 1],
            ["31/02/2024", "ROLLOVER", "0,50"],
            ["22/06/2024", "ZERO", "0,00"],
          ]),
          "qa-card",
        ),
        empty: parseXlsx(excel(format, []), "qa-card"),
      };
      console.info(
        "X2_LEGACY_GOLDEN",
        JSON.stringify({
          format,
          tz: process.env.TZ,
          results: serialized(results),
        }),
      );
      expect(["UTC", "America/Sao_Paulo"]).toContain(process.env.TZ);
      expect(results).toStrictEqual(legacyGolden(format));
    },
  );
});

describe("X2 additive validator (reachable on the accepted X1 base)", () => {
  it.each(["PDF", "XLS", "XLSX"] as const)(
    "binary_version_%s_accepts_its_complete_envelope_and_freezes_without_aliasing",
    (format) => {
      const candidate = dto(format);
      const result = validated(candidate);
      expect(result).toStrictEqual(candidate);
      frozen(result);
      candidate.occurrences[0].raw.description = "AFTER";
      expect(result.occurrences[0].raw.description).toBe("LOJA PARC 2/3");
    },
  );

  it.each([999, 1000, 1001])(
    "binary_validator_occurrence_boundary_%i",
    (count) => {
      const candidate = dto();
      candidate.occurrences = Array.from({ length: count }, (_, i) =>
        row({
          reference: `pdf:page:1:line:${i + 5}`,
          sourceOrdinal: i,
          identityOrdinal: i,
        }),
      );
      candidate.metrics.rows = count;
      if (count === 1001)
        expectError(() => validated(candidate), "LIMIT_EXCEEDED");
      else expect(validated(candidate).occurrences).toHaveLength(count);
    },
  );

  it.each([29, 30, 31])("binary_validator_page_boundary_%i", (pages) => {
    const candidate = dto();
    candidate.metrics.pages = pages;
    if (pages === 31) expectError(() => validated(candidate), "LIMIT_EXCEEDED");
    else expect(validated(candidate).metrics.pages).toBe(pages);
  });

  it.each([999, 1000, 1001])(
    "archive_limits_are_postparse_entry_boundary_%i",
    (entries) => {
      const candidate = dto("XLSX");
      candidate.metrics.archiveEntries = entries;
      if (entries === 1001)
        expectError(() => validated(candidate), "LIMIT_EXCEEDED");
      else expect(validated(candidate).metrics.archiveEntries).toBe(entries);
    },
  );

  it.each([52428799, 52428800, 52428801])(
    "archive_limits_are_postparse_expanded_byte_boundary_%i",
    (bytes) => {
      const candidate = dto("XLS");
      candidate.metrics.expandedBytes = bytes;
      if (bytes === 52428801)
        expectError(() => validated(candidate), "LIMIT_EXCEEDED");
      else expect(validated(candidate).metrics.expandedBytes).toBe(bytes);
    },
  );

  it.each([10485759, 10485760, 10485761])(
    "binary_complete_compact_UTF8_output_boundary_%i",
    (bytes) => {
      const candidate = dto();
      const raw = {
        date: "22/06/2024",
        description: 'escapes:"\\\n\t\u0000 \ud800 \u00e9 \ud83d\ude00',
        amount: "100,00",
        installment: "PARC 2/3",
      };
      candidate.occurrences = [
        row({ raw }),
        row({
          raw,
          reference: "pdf:page:1:line:6",
          sourceOrdinal: 1,
          identityOrdinal: 1,
        }),
      ];
      candidate.metrics.rows = 2;
      candidate.diagnostics = [
        { reference: "pdf:page:1:line:5", code: "UNSUPPORTED_CONTENT" },
      ];
      const base = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      candidate.occurrences[1].raw = {
        ...raw,
        description: raw.description + "x".repeat(bytes - base),
      };
      expect(Buffer.byteLength(JSON.stringify(candidate), "utf8")).toBe(bytes);
      if (bytes === 10485761)
        expectError(() => validated(candidate), "LIMIT_EXCEEDED");
      else {
        const result = validated(candidate);
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(bytes);
        expect(result).toStrictEqual(candidate);
        frozen(result);
      }
    },
  );

  it("binary_envelope_counts_repeated_aliases_in_full", () => {
    const candidate = dto();
    const shared = {
      ...candidate.occurrences[0].raw,
      description: "x".repeat(5300000),
    };
    candidate.occurrences = [
      row({ raw: shared }),
      row({
        raw: shared,
        reference: "pdf:page:1:line:6",
        sourceOrdinal: 1,
        identityOrdinal: 1,
      }),
    ];
    candidate.metrics.rows = 2;
    expect(
      Buffer.byteLength(JSON.stringify(candidate), "utf8"),
    ).toBeGreaterThan(10485760);
    expectError(() => validated(candidate), "LIMIT_EXCEEDED");
  });

  it("binary_structural_cycles_never_serialize", () => {
    const cyclic = { ...dto(), loop: {} };
    cyclic.loop = cyclic;
    expectError(() => validated(cyclic), "INVALID_RESULT");
  });

  it.each([
    "extra",
    "version",
    "locator",
    "duplicate",
    "sourceOrdinal",
    "identityOrdinal",
    "cycleLocator",
    "pageOutsideInventory",
    "foreignDiagnostic",
    "getter",
    "toJSON",
    "rawGetter",
  ])("binary_validation_remains_closed_and_callback_free_%s", (mutation) => {
    const candidate = dto();
    const callback = jest.fn(() => "should never execute");
    if (mutation === "extra")
      Object.assign(candidate, { externalId: "forbidden" });
    if (mutation === "version")
      Object.assign(candidate, { parserVersion: "card-local-pdf-v2" });
    if (mutation === "locator")
      candidate.occurrences[0].reference = "xlsx:sheet:1:row:5";
    if (mutation === "sourceOrdinal")
      candidate.occurrences[0].sourceOrdinal = 1;
    if (mutation === "identityOrdinal")
      candidate.occurrences[0].identityOrdinal = 4;
    if (mutation === "cycleLocator")
      candidate.occurrences[0].cycle = {
        invoiceDueMonth: "2025-11",
        reference: "csv:record:2",
      };
    if (mutation === "duplicate") {
      candidate.occurrences.push(row({ sourceOrdinal: 1, identityOrdinal: 1 }));
      candidate.metrics.rows = 2;
    }
    if (mutation === "pageOutsideInventory")
      candidate.occurrences[0].reference = "pdf:page:2:line:5";
    if (mutation === "foreignDiagnostic")
      candidate.diagnostics.push({
        reference: "pdf:page:99:line:5",
        code: "UNKNOWN_DATE",
      });
    if (mutation === "getter")
      Object.defineProperty(candidate, "parserVersion", {
        enumerable: true,
        get: callback,
      });
    if (mutation === "rawGetter")
      Object.defineProperty(candidate.occurrences[0].raw, "amount", {
        enumerable: true,
        get: callback,
      });
    if (mutation === "toJSON") Object.assign(candidate, { toJSON: callback });
    expectError(() => validated(candidate), "INVALID_RESULT");
    expect(callback).not.toHaveBeenCalled();
  });

  it("strict_text_version_does_not_accept_binary_locators_or_metrics", () => {
    const candidate = { ...dto(), parserVersion: "card-local-text-v1" };
    expectError(() => validated(candidate), "INVALID_RESULT");
    const text = {
      ...candidate,
      metrics: { ...candidate.metrics, pages: 0 },
      occurrences: [row({ reference: "csv:record:2", cycle: null })],
    };
    expect(validated(text)).toStrictEqual(text);
    expectError(
      () =>
        validated({ ...text, metrics: { ...text.metrics, archiveEntries: 1 } }),
      "INVALID_RESULT",
    );
  });
});

describe("X2 binary extraction (API-absence is not behavioral proof)", () => {
  it.each(["XLS", "XLSX"] as const)(
    "text_disguised_as_%s_is_not_an_excel_container",
    async (format) => {
      const extract = binaryExtractor();
      await refusal(
        extract(
          input(
            format,
            Buffer.from("Data,Descricao,Valor\n22/06/2024,LOJA,100.00"),
          ),
        ),
        "UNSUPPORTED_DOCUMENT",
        "UNSUPPORTED_CONTAINER",
      );
    },
  );

  it.each(["A1:A1", "A1:XFD1048576"])(
    "stale_small_dimension_does_not_hide_cells_and_large_dimension_is_not_densified_%s",
    async (dimension) => {
      const extract = binaryExtractor();
      const toRows = XLSX.utils.sheet_to_json;
      jest
        .spyOn(XLSX.utils, "sheet_to_json")
        .mockImplementation((sheet, options) => {
          if (sheet["!ref"] === "A1:XFD1048576" && options?.range === undefined)
            throw new Error("QA_REFUSES_DENSE_EXPANSION_OF_ADVERTISED_RANGE");
          return toRows(sheet, options);
        });
      const result = await extract(input("XLSX", sparseDimension(dimension)));
      expect(
        result.occurrences.map((r) => [r.reference, r.amountCents]),
      ).toStrictEqual([
        ["xlsx:sheet:1:row:4", 10000],
        ["xlsx:sheet:1:row:6", 10000],
        ["xlsx:sheet:1:row:7", -200],
      ]);
    },
  );

  it.each(["rows", "columns"] as const)(
    "sparse_populated_%s_ceiling_refuses_before_dense_conversion",
    async (axis) => {
      const extract = binaryExtractor();
      const book = workbook([HEADER, ["22/06/2024", "LOJA", "1,00"]]);
      const sheet = book.Sheets.Fatura;
      if (axis === "rows") {
        for (let r = 2; r < 4097; r++)
          sheet[`A${r + 1}`] = { t: "s", v: "Fatura de cartao" };
        sheet["!ref"] = "A1:D4097";
      } else {
        for (let c = 4; c < 257; c++)
          sheet[`${XLSX.utils.encode_col(c)}1`] = {
            t: "s",
            v: `Metadata ${c}`,
          };
        sheet["!ref"] = "A1:IW2";
      }
      const bytes: Buffer = XLSX.write(book, {
        type: "buffer",
        bookType: "xlsx",
      });
      const dense = jest.spyOn(XLSX.utils, "sheet_to_json");
      await refusal(extract(input("XLSX", bytes)), "LIMIT_EXCEEDED");
      expect(dense).not.toHaveBeenCalled();
    },
  );

  it.each(["duplicate-columns", "second-table", "merged"] as const)(
    "unsupported_transaction_structure_refuses_whole_workbook_%s",
    async (structure) => {
      const extract = binaryExtractor();
      const rows: Cell[][] =
        structure === "duplicate-columns"
          ? [
              ["Data", "Descricao", "Valor", "Valor"],
              ["22/06/2024", "LOJA", "1,00", "2,00"],
            ]
          : [HEADER, ["22/06/2024", "LOJA", "1,00"]];
      const book = workbook(rows);
      if (structure === "merged")
        book.Sheets.Fatura["!merges"] = [
          { s: { r: 1, c: 1 }, e: { r: 1, c: 2 } },
        ];
      if (structure === "second-table")
        XLSX.utils.sheet_add_aoa(
          book.Sheets.Fatura,
          [
            ["Data", "Alien Amount", "Alien Merchant"],
            ["22/06/2024", "700,00", "UNACCOUNTED"],
          ],
          { origin: "A5" },
        );
      const bytes: Buffer = XLSX.write(book, {
        type: "buffer",
        bookType: "xlsx",
      });
      await refusal(
        extract(input("XLSX", bytes)),
        "UNSUPPORTED_DOCUMENT",
        "UNSUPPORTED_LAYOUT",
      );
    },
  );

  it.each([10485759, 10485760, 10485761])(
    "decoded_pdf_text_budget_is_postpage_not_allocation_protection_%i",
    async (size) => {
      const extract = binaryExtractor();
      const original = PDFParse.prototype.getText;
      const destroy = jest.spyOn(PDFParse.prototype, "destroy");
      jest
        .spyOn(PDFParse.prototype, "getText")
        .mockImplementation(async function (this: PDFParse, options) {
          const result = await original.call(this, options);
          const text = result.pages[0].text;
          result.pages[0].text =
            text + " ".repeat(size - Buffer.byteLength(text, "utf8"));
          result.text = result.pages[0].text;
          expect(Buffer.byteLength(result.pages[0].text, "utf8")).toBe(size);
          return result;
        });
      const pending = extract(
        input("PDF", pdf([[...PREAMBLE, CYCLE_LINES[4]]])),
      );
      if (size === 10485761) await refusal(pending, "LIMIT_EXCEEDED");
      else expect((await pending).occurrences).toHaveLength(1);
      expect(destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("decoded_pdf_text_budget_accumulates_across_pages_and_stops_before_next_page", async () => {
    const extract = binaryExtractor();
    const original = PDFParse.prototype.getText;
    const getText = jest
      .spyOn(PDFParse.prototype, "getText")
      .mockImplementation(async function (this: PDFParse, options) {
        const result = await original.call(this, options);
        result.pages[0].text += " ".repeat(
          5242881 - Buffer.byteLength(result.pages[0].text, "utf8"),
        );
        result.text = result.pages[0].text;
        return result;
      });
    const destroy = jest.spyOn(PDFParse.prototype, "destroy");
    await refusal(
      extract(
        input(
          "PDF",
          pdf(Array.from({ length: 3 }, () => [...PREAMBLE, CYCLE_LINES[4]])),
        ),
      ),
      "LIMIT_EXCEEDED",
    );
    expect(
      getText.mock.calls.map(([options]) => options?.partial),
    ).toStrictEqual([[1], [2]]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("pdf_page_number_mismatch_refuses_whole_document_and_cleans_up", async () => {
    const extract = binaryExtractor();
    const original = PDFParse.prototype.getText;
    jest
      .spyOn(PDFParse.prototype, "getText")
      .mockImplementation(async function (this: PDFParse, options) {
        const result = await original.call(this, options);
        result.pages[0].num = 2;
        return result;
      });
    const destroy = jest.spyOn(PDFParse.prototype, "destroy");
    await expect(
      extract(input("PDF", pdf([[...PREAMBLE, CYCLE_LINES[4]]]))),
    ).rejects.toBeInstanceOf(DocumentExtractionError);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("pdf_capture_preserves_zero_credit_invalid_date_and_missing_amount", async () => {
    const extract = binaryExtractor();
    const result = await extract(
      input(
        "PDF",
        pdf([
          [
            ...PREAMBLE,
            "22/06/2024  ZERO  0,00",
            "22/06/2024  CREDITO  -2,00",
            "31/02/2024  INVALIDA  3,00",
            "22/06/2024  SEM VALOR",
          ],
        ]),
      ),
    );
    expect(
      result.occurrences.map((r) => [
        r.dateOnly,
        r.merchant,
        r.amountCents,
        r.sourceOrdinal,
        r.identityOrdinal,
      ]),
    ).toStrictEqual([
      ["2024-06-22", "ZERO", 0, 0, 0],
      ["2024-06-22", "CREDITO", -200, 1, 0],
      [null, "INVALIDA", 300, 2, null],
      ["2024-06-22", "SEM VALOR", null, 3, null],
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { reference: "pdf:page:1:line:7", code: "INVALID_CALENDAR_DATE" },
        { reference: "pdf:page:1:line:8", code: "UNREADABLE_ROW" },
      ]),
    );
  });

  it("binary_entrypoint_is_additive_and_text_api_stays_synchronous", async () => {
    const extract = binaryExtractor();
    const pending = extract(input("PDF", pdf([CYCLE_LINES])));
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;
    expect(result.parserVersion).toBe("card-local-pdf-v1");
    expect(Object.keys(result).sort()).toStrictEqual([
      "diagnostics",
      "documentKind",
      "invoiceDueMonth",
      "metrics",
      "occurrences",
      "parserVersion",
      "version",
    ]);
    expect(result.documentKind).toBe("INVOICE");
    frozen(result);
  });

  it("pdf_real_bytes_preserve_twins_before_both_legacy_dedup_levels", async () => {
    const extract = binaryExtractor();
    const result = await extract(
      input(
        "PDF",
        pdf([
          [
            ...PREAMBLE,
            "22/06/2024  LOJA PARC 1/3  100,01",
            "22/06/2024  LOJA PARC 1/3  100,01",
            "22/06/2024  LOJA PARC 2/3  100,00",
          ],
        ]),
      ),
    );
    expect(
      result.occurrences.map((r) => [
        r.reference,
        r.sourceOrdinal,
        r.identityOrdinal,
        r.merchant,
        r.amountCents,
        r.installmentIndex,
        r.installmentCount,
        r.raw.description,
      ]),
    ).toStrictEqual([
      ["pdf:page:1:line:5", 0, 0, "LOJA", 10001, 1, 3, "LOJA PARC 1/3"],
      ["pdf:page:1:line:6", 1, 1, "LOJA", 10001, 1, 3, "LOJA PARC 1/3"],
      ["pdf:page:1:line:7", 2, 0, "LOJA", 10000, 2, 3, "LOJA PARC 2/3"],
    ]);
  });

  it("pdf_preserves_all_pages_and_physical_line_locators", async () => {
    const extract = binaryExtractor();
    const result = await extract(
      input(
        "PDF",
        pdf([
          [...PREAMBLE, CYCLE_LINES[4]],
          [...PREAMBLE, CYCLE_LINES[4]],
        ]),
      ),
    );
    expect(result.metrics).toStrictEqual({
      pages: 2,
      rows: 2,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    });
    expect(
      result.occurrences.map((r) => [
        r.reference,
        r.sourceOrdinal,
        r.identityOrdinal,
      ]),
    ).toStrictEqual([
      ["pdf:page:1:line:5", 0, 0],
      ["pdf:page:2:line:5", 1, 1],
    ]);
  });

  it.each(["XLS", "XLSX"] as const)(
    "%s_preserves_original_rows_and_installment_column",
    async (format) => {
      const extract = binaryExtractor();
      const result = await extract(input(format, excel(format, ROWS)));
      const prefix = format.toLowerCase();
      expect(
        result.occurrences.map((r) => [
          r.reference,
          r.sourceOrdinal,
          r.identityOrdinal,
          r.amountCents,
          r.installmentIndex,
          r.installmentCount,
          r.raw.installment,
        ]),
      ).toStrictEqual([
        [`${prefix}:sheet:1:row:4`, 0, 0, 10000, 2, 3, "Parcela 2 de 3"],
        [`${prefix}:sheet:1:row:6`, 1, 1, 10000, 2, 3, "Parcela 2 de 3"],
        [`${prefix}:sheet:1:row:7`, 2, 0, -200, null, null, null],
      ]);
      expect(result.occurrences[0].amountMeaning).toBe("INSTALLMENT_CHARGE");
      expect(result.occurrences[0].cycle).toStrictEqual({
        invoiceDueMonth: "2025-11",
        reference: `${prefix}:sheet:1:cell:A2`,
      });
    },
  );

  it.each([false, true])(
    "xlsx_zip_stored_and_deflated_are_independently_read_%s",
    async (compression) => {
      const extract = binaryExtractor();
      const bytes = excel("XLSX", ROWS, {}, compression);
      expect(bytes.readUInt16LE(8)).toBe(compression ? 8 : 0);
      const result = await extract(input("XLSX", bytes));
      expect(result.occurrences.map((r) => r.amountCents)).toStrictEqual([
        10000, 10000, -200,
      ]);
      expect(result.metrics.archiveEntries).toBeGreaterThan(0);
      expect(result.metrics.expandedBytes).toBeGreaterThan(0);
    },
  );

  it("future_section_clears_current_cycle_until_own_evidence", async () => {
    const extract = binaryExtractor();
    const result = await extract(input("PDF", pdf([CYCLE_LINES])));
    expect(result.invoiceDueMonth).toBe("2025-11");
    expect(observation(result)).toStrictEqual([
      {
        reference: "pdf:page:1:line:5",
        source: 0,
        identity: 0,
        merchant: "LOJA",
        section: "CURRENT",
        cycle: { invoiceDueMonth: "2025-11", reference: "pdf:page:1:line:2" },
        date: "2024-06-22",
        cents: 10000,
      },
      {
        reference: "pdf:page:1:line:6",
        source: 1,
        identity: 1,
        merchant: "LOJA",
        section: "CURRENT",
        cycle: { invoiceDueMonth: "2025-11", reference: "pdf:page:1:line:2" },
        date: "2024-06-22",
        cents: 10000,
      },
      {
        reference: "pdf:page:1:line:8",
        source: 2,
        identity: 2,
        merchant: "LOJA",
        section: "FUTURE",
        cycle: null,
        date: "2024-06-22",
        cents: 10000,
      },
      {
        reference: "pdf:page:1:line:10",
        source: 3,
        identity: 3,
        merchant: "LOJA",
        section: "FUTURE",
        cycle: { invoiceDueMonth: "2025-12", reference: "pdf:page:1:line:9" },
        date: "2024-06-22",
        cents: 10000,
      },
    ]);
  });

  it.each(["PDF", "XLS", "XLSX"] as const)(
    "binary_missing_year_never_uses_clock_or_invoice_year_%s",
    async (format) => {
      const extract = binaryExtractor();
      const bytes =
        format === "PDF"
          ? pdf([
              [
                ...PREAMBLE,
                "22/06  SEM ANO PARC 2/3  10,00",
                "22/06/24  ANO CURTO PARC 2/3  10,00",
              ],
            ])
          : excel(format, [
              ["Vencimento 10/11/2025"],
              HEADER,
              ["22/06", "SEM ANO", "10,00", "Parcela 2 de 3"],
              ["22/06/24", "ANO CURTO", "10,00", "Parcela 2 de 3"],
            ]);
      const results: BinaryDocument[] = [];
      for (const year of [2025, 2037]) {
        jest.setSystemTime(new Date(`${year}-11-15T12:00:00.000Z`));
        results.push(await extract(input(format, bytes)));
      }
      expect(results[0]).toStrictEqual(results[1]);
      expect(
        results[0].occurrences.map((r) => [r.dateOnly, r.identityOrdinal]),
      ).toStrictEqual([
        [null, null],
        [null, null],
      ]);
      expect(
        results[0].diagnostics.filter((d) => d.code === "UNKNOWN_DATE"),
      ).toHaveLength(2);
    },
  );

  it.each(["PDF", "XLS", "XLSX"] as const)(
    "binary_explicit_historical_dates_survive_current_invoice_%s",
    async (format) => {
      const extract = binaryExtractor();
      const bytes =
        format === "PDF"
          ? pdf([[...PREAMBLE, CYCLE_LINES[4]]])
          : excel(format, ROWS);
      const result = await extract(input(format, bytes));
      expect(result.occurrences[0]).toMatchObject({
        dateOnly: "2024-06-22",
        amountCents: 10000,
        cycle: { invoiceDueMonth: "2025-11" },
      });
    },
  );

  it("ambiguous_section_and_conflicting_cycles_remain_unknown", async () => {
    const extract = binaryExtractor();
    const result = await extract(
      input(
        "PDF",
        pdf([
          [
            "Fatura de cartao",
            "Vencimento 10/11/2025",
            "Vencimento 10/12/2025",
            "Lancamentos desta fatura",
            "Data  Descricao  Valor",
            "22/06/2024  LOJA PARC 2/3  100,00",
            "Demonstrativo de parcelamentos",
            "22/06/2024  LOJA PARC 3/3  100,00",
          ],
        ]),
      ),
    );
    expect(result.invoiceDueMonth).toBeNull();
    expect(result.occurrences.map((r) => [r.section, r.cycle])).toStrictEqual([
      ["CURRENT", null],
      ["UNKNOWN", null],
    ]);
    expect(result.diagnostics.map((d) => d.code)).toContain("AMBIGUOUS_CYCLE");
  });

  it("date_after_invoice_month_does_not_establish_future", async () => {
    const extract = binaryExtractor();
    const result = await extract(
      input("PDF", pdf([[...PREAMBLE, "22/12/2025  LOJA PARC 2/3  100,00"]])),
    );
    expect(result.occurrences[0]).toMatchObject({
      section: "CURRENT",
      dateOnly: "2025-12-22",
      cycle: { invoiceDueMonth: "2025-11" },
    });
  });

  it.each(["XLS", "XLSX"] as const)(
    "binary_total_charge_and_unknown_meanings_are_distinct_%s",
    async (format) => {
      const extract = binaryExtractor();
      const results = await Promise.all([
        extract(
          input(
            format,
            excel(format, [
              ["Data", "Descricao", "Valor total da compra", "Parcelamento"],
              ["22/06/2024", "TOTAL", "300,00", "Parcela 2 de 3"],
            ]),
          ),
        ),
        extract(
          input(
            format,
            excel(format, [
              HEADER,
              ["22/06/2024", "COBRANCA", "100,00", "Parcela 2 de 3"],
            ]),
          ),
        ),
        extract(
          input(
            format,
            excel(format, [HEADER, ["22/06/2024", "GENERICO", "100,00"]]),
          ),
        ),
      ]);
      expect(
        results.map((r) => [
          r.occurrences[0].amountMeaning,
          r.occurrences[0].amountCents,
        ]),
      ).toStrictEqual([
        ["TOTAL_PURCHASE", 30000],
        ["INSTALLMENT_CHARGE", 10000],
        ["UNKNOWN", 10000],
      ]);
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "binary_keeps_missing_zero_negative_and_unreadable_occurrences_%s",
    async (format) => {
      const extract = binaryExtractor();
      const result = await extract(
        input(
          format,
          excel(format, [
            HEADER,
            [null, "SEM DATA", "1,00"],
            ["22/06/2024", null, "2,00"],
            ["22/06/2024", "SEM VALOR", null],
            ["22/06/2024", "ZERO", 0],
            ["22/06/2024", "CREDITO", "-2,00"],
            ["31/02/2024", "INVALIDA", "3,00"],
            ["22/06/2024", "", ""],
            ["22/06/2024", "LIXO", "100,00xyz"],
          ]),
        ),
      );
      expect(
        result.occurrences.map((r) => [
          r.sourceOrdinal,
          r.dateOnly,
          r.merchant,
          r.amountCents,
          r.identityOrdinal,
        ]),
      ).toStrictEqual([
        [0, null, "SEM DATA", 100, null],
        [1, "2024-06-22", null, 200, null],
        [2, "2024-06-22", "SEM VALOR", null, null],
        [3, "2024-06-22", "ZERO", 0, 0],
        [4, "2024-06-22", "CREDITO", -200, 0],
        [5, null, "INVALIDA", 300, null],
        [6, "2024-06-22", null, null, null],
        [7, "2024-06-22", "LIXO", null, null],
      ]);
      expect(result.occurrences[1].raw.description).toBeNull();
      expect(result.occurrences[6].raw.description).toBe("");
      expect(result.occurrences[3].raw.amount).toBe("0");
      expect(result.occurrences[7].raw.amount).toBe("100,00xyz");
      const prefix = format.toLowerCase();
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          { reference: `${prefix}:sheet:1:row:2`, code: "UNKNOWN_DATE" },
          {
            reference: `${prefix}:sheet:1:row:7`,
            code: "INVALID_CALENDAR_DATE",
          },
          { reference: `${prefix}:sheet:1:row:9`, code: "UNREADABLE_ROW" },
        ]),
      );
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "binary_strict_money_and_raw_fields_are_not_legacy_trimmed_%s",
    async (format) => {
      const extract = binaryExtractor();
      const result = await extract(
        input(
          format,
          excel(format, [
            HEADER,
            [" 22/06/2024 ", "  LOJA  ", " 1.234,56 "],
            ["22/06/2024", "US", "1,234.56"],
            ["22/06/2024", "INVALID", "1.234,56oops"],
            ["22/06/2024", "x".repeat(161), "2,00"],
          ]),
        ),
      );
      expect(result.occurrences.map((r) => r.amountCents)).toStrictEqual([
        123456,
        123456,
        null,
        200,
      ]);
      expect(result.occurrences[0].raw).toStrictEqual({
        date: " 22/06/2024 ",
        description: "  LOJA  ",
        amount: " 1.234,56 ",
        installment: null,
      });
      expect(result.occurrences[0].merchant).toBe("LOJA");
      expect(result.occurrences[3].merchant).toBeNull();
      expect(result.occurrences[3].raw.description).toHaveLength(161);
      expect(result.diagnostics.map((d) => d.code)).toContain("OVERLONG_FIELD");
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "conflicting_installment_column_and_description_stay_unknown_%s",
    async (format) => {
      const extract = binaryExtractor();
      const result = await extract(
        input(
          format,
          excel(format, [
            HEADER,
            ["22/06/2024", "LOJA PARC 1/3", "100,00", "Parcela 2 de 3"],
          ]),
        ),
      );
      expect(result.occurrences[0]).toMatchObject({
        installmentCount: null,
        installmentIndex: null,
        amountMeaning: "UNKNOWN",
        raw: { description: "LOJA PARC 1/3", installment: "Parcela 2 de 3" },
      });
      expect(result.diagnostics.map((d) => d.code)).toContain(
        "UNSUPPORTED_CONTENT",
      );
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "xls_date_systems_are_calendar_based_not_timezone_based_%s",
    async (format) => {
      const extract = binaryExtractor();
      for (const [date1904, serial] of [
        [false, 45465],
        [true, 44003],
      ] as const) {
        const result = await extract(
          input(
            format,
            excel(format, [HEADER, [serial, "SERIAL", 1]], { date1904 }),
          ),
        );
        expect(result.occurrences[0].raw.date).toBe(String(serial));
        expect(result.occurrences[0].dateOnly).toBe("2024-06-22");
      }
      const invalid = await extract(
        input(format, excel(format, [HEADER, [60, "LEAP BUG", 1]])),
      );
      expect(invalid.occurrences[0].dateOnly).toBeNull();
      expect(invalid.occurrences[0].identityOrdinal).toBeNull();
      expect(invalid.diagnostics.map((d) => d.code)).toContain(
        "INVALID_CALENDAR_DATE",
      );
    },
  );

  it.each(
    (["XLS", "XLSX"] as const).flatMap((format) =>
      (["visible", "hidden", "empty", "unsupported"] as const).map((extra) => ({
        format,
        extra,
      })),
    ),
  )(
    "extra_$extra_sheet_refuses_whole_$format_workbook",
    async ({ format, extra }) => {
      const extract = binaryExtractor();
      await refusal(
        extract(input(format, excel(format, ROWS, { extra }))),
        "UNSUPPORTED_DOCUMENT",
        "MULTIPLE_SHEETS",
      );
    },
  );

  it.each(["PDF", "XLS", "XLSX"] as const)(
    "no_recognized_table_is_not_empty_success_%s",
    async (format) => {
      const extract = binaryExtractor();
      await refusal(
        extract(
          input(
            format,
            format === "PDF"
              ? pdf([["not an invoice"]])
              : excel(format, [["not an invoice"]]),
          ),
        ),
        "UNSUPPORTED_DOCUMENT",
        "UNSUPPORTED_LAYOUT",
      );
    },
  );

  it.each(["encrypted", "scanned", "mixed", "corrupt"] as const)(
    "password_scanned_mixed_page_and_corrupt_pdf_fail_distinctly_%s",
    async (kind) => {
      const extract = binaryExtractor();
      const bytes =
        kind === "encrypted"
          ? Buffer.from(ENCRYPTED_PDF, "base64")
          : kind === "scanned"
            ? pdf([[]], true)
            : kind === "mixed"
              ? pdf([[...PREAMBLE, CYCLE_LINES[4]], []])
              : Buffer.from("%PDF-1.4\nPRIVATE_SOURCE_MUST_NOT_LEAK");
      const reason =
        kind === "encrypted"
          ? "PASSWORD_PROTECTED"
          : kind === "corrupt"
            ? "CORRUPT_DOCUMENT"
            : "NO_TEXT_LAYER";
      await refusal(
        extract(input("PDF", bytes)),
        "UNSUPPORTED_DOCUMENT",
        reason,
      );
    },
  );

  it.each(
    (["PDF", "XLS", "XLSX"] as const).flatMap((format) =>
      [999, 1000, 1001].map((count) => ({ format, count })),
    ),
  )(
    "binary_occurrence_limits_include_incomplete_and_future_rows_$format_$count",
    async ({ format, count }) => {
      const extract = binaryExtractor();
      let bytes: Buffer;
      if (format === "PDF") {
        const lines = Array.from({ length: count }, (_, i) =>
          i % 2 === 0
            ? "22/06/2024  LOJA PARC 2/3  0,00"
            : "22/06  SEM ANO PARC 2/3  1,00",
        );
        const pages = Array.from(
          { length: Math.ceil(count / 40) },
          (_, page) => [
            ...PREAMBLE,
            "Proximas faturas",
            ...lines.slice(page * 40, page * 40 + 40),
          ],
        );
        bytes = pdf(pages);
      } else {
        bytes = excel(format, [
          HEADER,
          ...Array.from({ length: count }, (_, i): Cell[] => [
            i % 2 ? null : "22/06/2024",
            "LOJA",
            i % 2 ? "1,00" : "0,00",
          ]),
        ]);
      }
      if (count === 1001)
        await refusal(extract(input(format, bytes)), "LIMIT_EXCEEDED");
      else {
        const result = await extract(input(format, bytes));
        expect(result.occurrences).toHaveLength(count);
        expect(result.metrics.rows).toBe(count);
        expect(result.occurrences[count - 1].sourceOrdinal).toBe(count - 1);
        expect(
          result.occurrences.filter((r) => r.amountCents === 0),
        ).toHaveLength(Math.ceil(count / 2));
        if (format === "PDF")
          expect(
            result.occurrences.every(
              (r) => r.section === "FUTURE" && r.cycle === null,
            ),
          ).toBe(true);
      }
    },
  );

  it.each([29, 30, 31])(
    "pdf_page_limit_never_returns_a_truncated_success_%i",
    async (count) => {
      const extract = binaryExtractor();
      const original = PDFParse.prototype.getText;
      let active = 0;
      let maximumActive = 0;
      const getText = jest
        .spyOn(PDFParse.prototype, "getText")
        .mockImplementation(async function (this: PDFParse, options) {
          active++;
          maximumActive = Math.max(maximumActive, active);
          try {
            return await original.call(this, options);
          } finally {
            active--;
          }
        });
      const destroy = jest.spyOn(PDFParse.prototype, "destroy");
      const bytes = pdf(
        Array.from({ length: count }, () => [...PREAMBLE, CYCLE_LINES[4]]),
      );
      if (count === 31) {
        await refusal(extract(input("PDF", bytes)), "LIMIT_EXCEEDED");
        expect(getText).not.toHaveBeenCalled();
      } else {
        const result = await extract(input("PDF", bytes));
        expect(result.metrics.pages).toBe(count);
        expect(maximumActive).toBe(1);
        expect(result.occurrences).toHaveLength(count);
        expect(
          getText.mock.calls.map(([options]) => options?.partial),
        ).toStrictEqual(Array.from({ length: count }, (_, i) => [i + 1]));
        expect(
          getText.mock.calls.every(
            ([options]) => options?.disableNormalization === true,
          ),
        ).toBe(true);
      }
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(active).toBe(0);
    },
  );

  it.each([10485759, 10485760, 10485761])(
    "binary_input_boundary_is_checked_before_library_read_%i",
    async (size) => {
      const extract = binaryExtractor();
      const base = pdf([[...PREAMBLE, CYCLE_LINES[4]]]);
      // A PDF comment before xref is harmless controlled padding, not a compressed bomb.
      const marker = base.indexOf("xref\n");
      const tail = base.subarray(marker).toString("latin1");
      const padSize = size - base.length;
      const shiftedTail = tail.replace(
        /startxref\n\d+/,
        `startxref\n${marker + padSize}`,
      );
      const correction = shiftedTail.length - tail.length;
      const padding = `%${" ".repeat(padSize - correction - 2)}\n`;
      const bytes = Buffer.concat([
        base.subarray(0, marker),
        Buffer.from(padding),
        Buffer.from(
          shiftedTail.replace(
            /startxref\n\d+/,
            `startxref\n${marker + padding.length}`,
          ),
        ),
      ]);
      expect(bytes.length).toBe(size);
      const info = jest.spyOn(PDFParse.prototype, "getInfo");
      if (size === 10485761) {
        await refusal(extract(input("PDF", bytes)), "LIMIT_EXCEEDED");
        expect(info).not.toHaveBeenCalled();
      } else
        expect((await extract(input("PDF", bytes))).occurrences).toHaveLength(
          1,
        );
    },
  );

  it("parallel_extractions_do_not_share_section_cycle_or_parser_state", async () => {
    const extract = binaryExtractor();
    const destroy = jest.spyOn(PDFParse.prototype, "destroy");
    const november = pdf([[...PREAMBLE, CYCLE_LINES[4]]]);
    const december = pdf([
      [
        ...PREAMBLE.map((line) => line.replace("10/11/2025", "10/12/2025")),
        CYCLE_LINES[4],
      ],
    ]);
    const before = [sha(november), sha(december)];
    const results = await Promise.allSettled([
      extract(input("PDF", november)),
      extract(input("PDF", december)),
      extract(input("PDF", pdf([[]]))),
    ]);
    expect(results.map((r) => r.status)).toStrictEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
    for (const [index, month] of ["2025-11", "2025-12"].entries()) {
      const result = results[index];
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.occurrences[0].cycle?.invoiceDueMonth).toBe(month);
      expect(result.value.occurrences[0].identityOrdinal).toBe(0);
    }
    expect([sha(november), sha(december)]).toStrictEqual(before);
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(new Set(destroy.mock.contexts).size).toBe(3);
  });

  it.each(["PDF", "XLS", "XLSX"] as const)(
    "input_mutation_after_start_cannot_change_snapshot_%s",
    async (format) => {
      const extract = binaryExtractor();
      const bytes =
        format === "PDF"
          ? pdf([[...PREAMBLE, CYCLE_LINES[4]]])
          : excel(format, ROWS);
      const expected = await extract(input(format, Buffer.from(bytes)));
      const pending = extract(input(format, bytes));
      bytes.fill(0);
      expect(await pending).toStrictEqual(expected);
    },
  );

  it("cleanup_failure_cannot_be_success", async () => {
    const extract = binaryExtractor();
    const destroy = PDFParse.prototype.destroy;
    jest
      .spyOn(PDFParse.prototype, "destroy")
      .mockImplementation(async function (this: PDFParse) {
        await destroy.call(this);
        throw new Error("SYNTHETIC_PRIVATE_CLEANUP_FAILURE");
      });
    await expect(
      extract(input("PDF", pdf([[...PREAMBLE, CYCLE_LINES[4]]]))),
    ).rejects.toBeInstanceOf(Error);
  });

  it.each([
    "extra",
    "password",
    "getter",
    "toJSON",
    "wrongProfile",
    "bank",
    "receipt",
    "version",
  ] as const)("binary_input_is_closed_callback_free_%s", async (mutation) => {
    const extract = binaryExtractor();
    const request = input("PDF", pdf([[...PREAMBLE, CYCLE_LINES[4]]]));
    const callback = jest.fn(() => request.bytes);
    if (mutation === "extra")
      Object.assign(request, { filename: "invoice.pdf" });
    if (mutation === "password") Object.assign(request, { password: "" });
    if (mutation === "getter")
      Object.defineProperty(request, "bytes", {
        enumerable: true,
        get: callback,
      });
    if (mutation === "toJSON") Object.assign(request, { toJSON: callback });
    if (mutation === "wrongProfile")
      Object.assign(request, { profile: "XLS_CARD" });
    if (mutation === "bank")
      Object.assign(request, { context: "BANK_STATEMENT" });
    if (mutation === "receipt") Object.assign(request, { context: "RECEIPT" });
    if (mutation === "version") Object.assign(request, { version: 2 });
    await refusal(extract(request), "INVALID_INPUT");
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("X2 supplement: real spreadsheet cycles and post-read admission", () => {
  const cycleRows: Cell[][] = [
    ["Fatura de cartao"],
    ["Vencimento 10/11/2025"],
    ["Lancamentos desta fatura"],
    HEADER,
    ["22/06/2024", "LOJA PARC 2/3", "100,00"],
    [],
    ["22/06/2024", "LOJA PARC 2/3", "100,00"],
    ["Proximas faturas"],
    ["22/06/2024", "LOJA PARC 3/3", 100],
    ["Vencimento 10/12/2025"],
    ["22/06/2024", "LOJA PARC 3/3", "100,00"],
    ["Demonstrativo de parcelamentos"],
    ["22/06/2024", "LOJA PARC 3/3", "100,00"],
  ];
  const conflictRows: Cell[][] = [
    ["Fatura de cartao"],
    ["Vencimento 10/11/2025"],
    ["Vencimento 10/12/2025"],
    ["Lancamentos desta fatura"],
    HEADER,
    ["22/06/2024", "LOJA PARC 2/3", "100,00"],
    ["Proximas faturas"],
    ["Vencimento 10/01/2026"],
    ["Vencimento 10/02/2026"],
    ["22/06/2024", "LOJA PARC 3/3", "100,00"],
    ["Demonstrativo de parcelamentos"],
    ["22/06/2024", "LOJA PARC 3/3", "100,00"],
  ];
  const boundaries = [
    { format: "XLS", axis: "rows", count: 4095 },
    { format: "XLS", axis: "rows", count: 4096 },
    { format: "XLS", axis: "rows", count: 4097 },
    { format: "XLSX", axis: "rows", count: 4095 },
    { format: "XLSX", axis: "rows", count: 4096 },
    { format: "XLSX", axis: "rows", count: 4097 },
    { format: "XLS", axis: "columns", count: 255 },
    { format: "XLS", axis: "columns", count: 256 },
    { format: "XLSX", axis: "columns", count: 255 },
    { format: "XLSX", axis: "columns", count: 256 },
    { format: "XLSX", axis: "columns", count: 257 },
  ] as const;

  function boundaryRows(axis: "rows" | "columns", count: number): Cell[][] {
    const transaction = ["22/06/2024", "LOJA", "100,00", "Parcela 2 de 3"];
    if (axis === "rows")
      return [
        HEADER,
        transaction,
        ...Array.from({ length: count - 2 }, () => ["Fatura de cartao"]),
      ];
    return [
      [
        ...HEADER,
        ...Array.from(
          { length: count - 4 },
          (_, column) => `Metadata ${column + 5}`,
        ),
      ],
      transaction,
    ];
  }

  function decodedCells(bytes: Buffer, format: "XLS" | "XLSX") {
    expect(bytes.subarray(0, format === "XLS" ? 8 : 4).toString("hex")).toBe(
      format === "XLS" ? "d0cf11e0a1b11ae1" : "504b0304",
    );
    const book = XLSX.read(bytes, { type: "buffer" });
    expect(book.SheetNames).toStrictEqual(["Fatura"]);
    const sheet = book.Sheets.Fatura;
    const addresses = Object.keys(sheet)
      .filter((address) => /^[A-Z]+[1-9]\d*$/.test(address))
      .sort();
    const rows = new Set<number>();
    const columns = new Set<number>();
    for (const address of addresses) {
      const position = XLSX.utils.decode_cell(address);
      rows.add(position.r);
      columns.add(position.c);
      expect(["s", "n"]).toContain(sheet[address].t);
      expect(sheet[address].v).not.toBeNull();
      expect(sheet[address].v).not.toBeUndefined();
    }
    return {
      sheet,
      populatedRows: rows.size,
      populatedColumns: columns.size,
      cells: addresses.map((address) => ({
        address,
        type: sheet[address].t,
        value: sheet[address].v,
      })),
    };
  }

  function receipt(
    name: string,
    bytes: Buffer,
    decoded: ReturnType<typeof decodedCells>,
  ): void {
    console.info(
      "X2_SUPPLEMENT_FIXTURE",
      JSON.stringify({
        name,
        sha256: sha(bytes),
        byteLength: bytes.length,
        base64: bytes.toString("base64"),
        populatedRows: decoded.populatedRows,
        populatedColumns: decoded.populatedColumns,
        cells: decoded.cells,
      }),
    );
  }

  it.each(["XLS", "XLSX"] as const)(
    "cycle_fixture_%s_has_real_numeric_cell_and_physical_gaps",
    (format) => {
      const bytes = excel(format, cycleRows);
      const decoded = decodedCells(bytes, format);
      expect(decoded.populatedRows).toBe(12);
      expect(decoded.populatedColumns).toBe(4);
      expect(decoded.sheet.A6).toBeUndefined();
      expect(decoded.sheet.A2).toMatchObject({
        t: "s",
        v: "Vencimento 10/11/2025",
      });
      expect(decoded.sheet.A10).toMatchObject({
        t: "s",
        v: "Vencimento 10/12/2025",
      });
      expect(decoded.sheet.A12).toMatchObject({
        t: "s",
        v: "Demonstrativo de parcelamentos",
      });
      expect(decoded.sheet.C9).toMatchObject({ t: "n", v: 100 });
      expect(decoded.sheet.C11).toMatchObject({ t: "s", v: "100,00" });
      expect(decoded.sheet.D9).toBeUndefined();
      expect(
        [5, 7, 9, 11, 13].map((r) => [
          decoded.sheet[`A${r}`].v,
          decoded.sheet[`B${r}`].v,
        ]),
      ).toStrictEqual([
        ["22/06/2024", "LOJA PARC 2/3"],
        ["22/06/2024", "LOJA PARC 2/3"],
        ["22/06/2024", "LOJA PARC 3/3"],
        ["22/06/2024", "LOJA PARC 3/3"],
        ["22/06/2024", "LOJA PARC 3/3"],
      ]);
      receipt(`cycles-${format}`, bytes, decoded);
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "cycle_conflict_fixture_%s_decodes_each_anchor_in_its_own_cell",
    (format) => {
      const bytes = excel(format, conflictRows);
      const decoded = decodedCells(bytes, format);
      expect([2, 3, 8, 9].map((r) => decoded.sheet[`A${r}`].v)).toStrictEqual([
        "Vencimento 10/11/2025",
        "Vencimento 10/12/2025",
        "Vencimento 10/01/2026",
        "Vencimento 10/02/2026",
      ]);
      expect(
        [6, 10, 12].map((r) => [
          decoded.sheet[`B${r}`].v,
          decoded.sheet[`C${r}`].v,
        ]),
      ).toStrictEqual([
        ["LOJA PARC 2/3", "100,00"],
        ["LOJA PARC 3/3", "100,00"],
        ["LOJA PARC 3/3", "100,00"],
      ]);
      receipt(`conflicting-cycles-${format}`, bytes, decoded);
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "cycle_sections_%s_clear_inherited_anchors_and_keep_global_identity",
    async (format) => {
      const extract = binaryExtractor();
      const result = await extract(input(format, excel(format, cycleRows)));
      const prefix = format.toLowerCase();
      expect(result.invoiceDueMonth).toBe("2025-11");
      expect(result.metrics.rows).toBe(5);
      expect(observation(result)).toStrictEqual([
        {
          reference: `${prefix}:sheet:1:row:5`,
          source: 0,
          identity: 0,
          merchant: "LOJA",
          section: "CURRENT",
          cycle: {
            invoiceDueMonth: "2025-11",
            reference: `${prefix}:sheet:1:cell:A2`,
          },
          date: "2024-06-22",
          cents: 10000,
        },
        {
          reference: `${prefix}:sheet:1:row:7`,
          source: 1,
          identity: 1,
          merchant: "LOJA",
          section: "CURRENT",
          cycle: {
            invoiceDueMonth: "2025-11",
            reference: `${prefix}:sheet:1:cell:A2`,
          },
          date: "2024-06-22",
          cents: 10000,
        },
        {
          reference: `${prefix}:sheet:1:row:9`,
          source: 2,
          identity: 2,
          merchant: "LOJA",
          section: "FUTURE",
          cycle: null,
          date: "2024-06-22",
          cents: 10000,
        },
        {
          reference: `${prefix}:sheet:1:row:11`,
          source: 3,
          identity: 3,
          merchant: "LOJA",
          section: "FUTURE",
          cycle: {
            invoiceDueMonth: "2025-12",
            reference: `${prefix}:sheet:1:cell:A10`,
          },
          date: "2024-06-22",
          cents: 10000,
        },
        {
          reference: `${prefix}:sheet:1:row:13`,
          source: 4,
          identity: 4,
          merchant: "LOJA",
          section: "UNKNOWN",
          cycle: null,
          date: "2024-06-22",
          cents: 10000,
        },
      ]);
      expect(
        result.occurrences.map((r) => [
          r.raw.amount,
          r.installmentIndex,
          r.installmentCount,
          r.amountMeaning,
        ]),
      ).toStrictEqual([
        ["100,00", 2, 3, "INSTALLMENT_CHARGE"],
        ["100,00", 2, 3, "INSTALLMENT_CHARGE"],
        ["100", 3, 3, "INSTALLMENT_CHARGE"],
        ["100,00", 3, 3, "INSTALLMENT_CHARGE"],
        ["100,00", 3, 3, "INSTALLMENT_CHARGE"],
      ]);
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "cycle_conflicts_%s_never_choose_first_anchor_in_current_or_future",
    async (format) => {
      const extract = binaryExtractor();
      const result = await extract(input(format, excel(format, conflictRows)));
      const prefix = format.toLowerCase();
      expect(result.invoiceDueMonth).toBeNull();
      expect(result.metrics.rows).toBe(3);
      expect(observation(result)).toStrictEqual([
        {
          reference: `${prefix}:sheet:1:row:6`,
          source: 0,
          identity: 0,
          merchant: "LOJA",
          section: "CURRENT",
          cycle: null,
          date: "2024-06-22",
          cents: 10000,
        },
        {
          reference: `${prefix}:sheet:1:row:10`,
          source: 1,
          identity: 1,
          merchant: "LOJA",
          section: "FUTURE",
          cycle: null,
          date: "2024-06-22",
          cents: 10000,
        },
        {
          reference: `${prefix}:sheet:1:row:12`,
          source: 2,
          identity: 2,
          merchant: "LOJA",
          section: "UNKNOWN",
          cycle: null,
          date: "2024-06-22",
          cents: 10000,
        },
      ]);
      expect(result.diagnostics.map((d) => d.code)).toContain(
        "AMBIGUOUS_CYCLE",
      );
    },
  );

  it.each(boundaries)(
    "boundary_fixture $format/$axis/$count counts_decoded_cells_not_ref",
    ({ format, axis, count }) => {
      const bytes = excel(format, boundaryRows(axis, count));
      const decoded = decodedCells(bytes, format);
      expect(decoded.populatedRows).toBe(axis === "rows" ? count : 2);
      expect(decoded.populatedColumns).toBe(axis === "columns" ? count : 4);
      expect(decoded.sheet.A2).toMatchObject({ t: "s", v: "22/06/2024" });
      expect(decoded.sheet.B2).toMatchObject({ t: "s", v: "LOJA" });
      expect(decoded.sheet.C2).toMatchObject({ t: "s", v: "100,00" });
      expect(decoded.sheet.D2).toMatchObject({ t: "s", v: "Parcela 2 de 3" });
      expect(bytes.length).toBeLessThan(10485760);
      receipt(`${format}-${axis}-${count}`, bytes, decoded);
    },
  );

  it("boundary_fixture_biff8_cannot_supply_a_genuine_257_column_workbook", () => {
    expect(() =>
      XLSX.write(workbook(boundaryRows("columns", 257)), {
        type: "buffer",
        bookType: "biff8",
        WTF: true,
      }),
    ).toThrow(/exceeds format limit/);
  });

  it.each(boundaries)(
    "boundary_admission $format/$axis/$count is_post_read_not_layout_approval",
    async ({ format, axis, count }) => {
      const extract = binaryExtractor();
      const bytes = excel(format, boundaryRows(axis, count));
      const dense = jest.spyOn(XLSX.utils, "sheet_to_json");
      const pending = extract(input(format, bytes));
      if (
        (axis === "rows" && count === 4097) ||
        (axis === "columns" && count === 257)
      ) {
        await refusal(pending, "LIMIT_EXCEEDED");
        expect(dense).not.toHaveBeenCalled();
        return;
      }
      const outcome = await pending.then(
        (document) => ({ kind: "document" as const, document }),
        (error: unknown) => ({ kind: "refusal" as const, error }),
      );
      if (outcome.kind === "refusal") {
        await refusal(
          Promise.reject(outcome.error),
          "UNSUPPORTED_DOCUMENT",
          "UNSUPPORTED_LAYOUT",
        );
        return;
      }
      expect(validated(outcome.document)).toStrictEqual(outcome.document);
      frozen(outcome.document);
      expect(outcome.document.metrics.rows).toBe(1);
      expect(outcome.document.occurrences).toHaveLength(1);
      expect(outcome.document.occurrences[0]).toMatchObject({
        reference: `${format.toLowerCase()}:sheet:1:row:2`,
        sourceOrdinal: 0,
        identityOrdinal: 0,
        dateOnly: "2024-06-22",
        merchant: "LOJA",
        amountCents: 10000,
        installmentCount: 3,
        installmentIndex: 2,
        amountMeaning: "INSTALLMENT_CHARGE",
      });
    },
  );
});

describe("X2 inventory addendum: post-library extraction, not DTO metrics", () => {
  type ExcelFormat = "XLS" | "XLSX";
  interface Member {
    name: string;
    type: number;
    size: number;
    content?: Buffer | Uint8Array;
  }
  interface Ole {
    FullPaths: string[];
    FileIndex: Member[];
  }
  interface Zip {
    keys: string[];
    files: Record<string, Member>;
  }
  type InventoryBook = XLSX.WorkBook & {
    cfb?: unknown;
    keys?: unknown;
    files?: unknown;
  };
  const sentinel = "\u0001Sh33tJ5";
  const dependency = jest.requireActual<typeof import("xlsx")>("xlsx");

  function ole(): Ole {
    const backing = Buffer.alloc(64, 9);
    return {
      FullPaths: [
        "Budget Root/",
        `Budget Root/${sentinel}`,
        "Budget Root/docs/",
        "Budget Root/docs/five",
        "Budget Root/two",
        "Budget Root/empty",
        "",
        "",
      ],
      FileIndex: [
        {
          name: "Budget Root",
          type: 5,
          size: 512,
          content: Buffer.alloc(512, 7),
        },
        {
          name: sentinel,
          type: 2,
          size: 4,
          content: Buffer.from([55, 50, 54, 50]),
        },
        { name: "docs", type: 1, size: 0 },
        {
          name: "five",
          type: 2,
          size: 5,
          content: new Uint8Array(backing.buffer, backing.byteOffset + 8, 5),
        },
        { name: "two", type: 2, size: 2, content: backing.subarray(20, 22) },
        { name: "empty", type: 2, size: 0 },
        { name: "", type: 0, size: 0 },
        { name: "", type: 0, size: 0, content: Buffer.alloc(0) },
      ],
    };
  }

  function zip(): Zip {
    const backing = Buffer.alloc(64, 9);
    return {
      keys: ["", sentinel, "docs/", "five", "two", "empty"],
      files: {
        "": { name: "Root Entry", type: 5, size: 0 },
        [sentinel]: {
          name: sentinel,
          type: 2,
          size: 4,
          content: Buffer.from([55, 50, 54, 50]),
        },
        "docs/": { name: "docs", type: 2, size: 0, content: Buffer.alloc(0) },
        five: {
          name: "five",
          type: 2,
          size: 5,
          content: new Uint8Array(backing.buffer, backing.byteOffset + 8, 5),
        },
        two: {
          name: "two",
          type: 2,
          size: 2,
          content: backing.subarray(20, 22),
        },
        empty: { name: "empty", type: 2, size: 0, content: new Uint8Array(0) },
      },
    };
  }

  function addOle(inventory: Ole, path: string, member: Member): void {
    inventory.FullPaths.push(`Budget Root/${path}`);
    inventory.FileIndex.push(member);
  }

  function addZip(inventory: Zip, path: string, member: Member): void {
    inventory.keys.push(path);
    inventory.files[path] = member;
  }

  function entryVector(format: ExcelFormat, count: number): Ole | Zip {
    if (format === "XLS") {
      const inventory = ole();
      for (let index = 5; index < count; index++)
        addOle(inventory, `empty-${index}`, {
          name: `empty-${index}`,
          type: 2,
          size: 0,
        });
      return inventory;
    }
    const inventory = zip();
    for (let index = 4; index < count; index++)
      addZip(inventory, `empty-${index}`, {
        name: `empty-${index}`,
        type: 2,
        size: 0,
        content: Buffer.alloc(0),
      });
    return inventory;
  }

  function byteVector(format: ExcelFormat, lastBytes: number) {
    const backing = Buffer.alloc(65568, 3);
    const alias = new Uint8Array(
      backing.buffer,
      backing.byteOffset + 16,
      65536,
    );
    const tail = new Uint8Array(
      backing.buffer,
      backing.byteOffset + 16,
      lastBytes,
    );
    const members = Array.from(
      { length: 799 },
      (_, i): Member => ({
        name: `alias-${i}`,
        type: 2,
        size: 65536,
        content: alias,
      }),
    );
    members.push({ name: "tail", type: 2, size: lastBytes, content: tail });
    if (format === "XLS") {
      const inventory = ole();
      inventory.FullPaths.splice(3, 2);
      inventory.FileIndex.splice(3, 2);
      for (const member of members) addOle(inventory, member.name, member);
      return { inventory, members, alias, tail, backing };
    }
    const inventory = zip();
    inventory.keys = inventory.keys.filter(
      (key) => key !== "five" && key !== "two",
    );
    delete inventory.files.five;
    delete inventory.files.two;
    for (const member of members) addZip(inventory, member.name, member);
    return { inventory, members, alias, tail, backing };
  }

  function replaceInventory(
    book: InventoryBook,
    format: ExcelFormat,
    inventory: Ole | Zip,
  ): void {
    if (format === "XLS") book.cfb = inventory;
    else Object.assign(book, inventory);
  }

  function instrument(bytes: Buffer, change?: (book: InventoryBook) => void) {
    const read = dependency.read;
    const seen: { book: InventoryBook; originalKeys: string[] }[] = [];
    const spy = jest
      .spyOn(dependency, "read")
      .mockImplementation((data, options) => {
        expect(options?.bookFiles).toBe(true);
        if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array))
          throw new Error("Expected original binary bytes at the SheetJS seam");
        expect(Buffer.from(data).equals(bytes)).toBe(true);
        const book: InventoryBook = read(data, options);
        const originalKeys = Object.keys(book);
        change?.(book);
        seen.push({ book, originalKeys });
        return book;
      });
    return { spy, seen };
  }

  // Evidence serialization only: no membership classification or byte summation.
  function describeInventory(value: unknown): unknown {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array)
      return {
        binary: Buffer.isBuffer(value) ? "Buffer" : "Uint8Array",
        byteLength: value.byteLength,
        backingBytes: value.buffer.byteLength,
        sha256: sha(Buffer.from(value)),
      };
    if (Array.isArray(value)) return value.map(describeInventory);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          describeInventory(item),
        ]),
      );
    return value;
  }

  function cycleFixture(conflicts: boolean): Cell[][] {
    if (conflicts)
      return [
        ["Fatura de cartao"],
        ["Vencimento 10/11/2025"],
        ["Vencimento 10/12/2025"],
        ["Lancamentos desta fatura"],
        HEADER,
        ["22/06/2024", "LOJA PARC 2/3", "100,00"],
        ["Proximas faturas"],
        ["Vencimento 10/01/2026"],
        ["Vencimento 10/02/2026"],
        ["22/06/2024", "LOJA PARC 3/3", "100,00"],
        ["Demonstrativo de parcelamentos"],
        ["22/06/2024", "LOJA PARC 3/3", "100,00"],
      ];
    return [
      ["Fatura de cartao"],
      ["Vencimento 10/11/2025"],
      ["Lancamentos desta fatura"],
      HEADER,
      ["22/06/2024", "LOJA PARC 2/3", "100,00"],
      [],
      ["22/06/2024", "LOJA PARC 2/3", "100,00"],
      ["Proximas faturas"],
      ["22/06/2024", "LOJA PARC 3/3", 100],
      ["Vencimento 10/12/2025"],
      ["22/06/2024", "LOJA PARC 3/3", "100,00"],
      ["Demonstrativo de parcelamentos"],
      ["22/06/2024", "LOJA PARC 3/3", "100,00"],
    ];
  }

  function boundaryFixture(axis: "rows" | "columns", count: number): Cell[][] {
    const transaction = ["22/06/2024", "LOJA", "100,00", "Parcela 2 de 3"];
    return axis === "rows"
      ? [
          HEADER,
          transaction,
          ...Array.from({ length: count - 2 }, () => ["Fatura de cartao"]),
        ]
      : [
          [
            ...HEADER,
            ...Array.from({ length: count - 4 }, (_, i) => `Metadata ${i + 5}`),
          ],
          transaction,
        ];
  }

  const sealedFixtures: {
    name: string;
    format: ExcelFormat;
    digest: string;
    bytes: () => Buffer;
  }[] = [
    {
      name: "V1-XLS",
      format: "XLS",
      digest:
        "2643709d2a52fab8ca82a7dbe0ca8f65f2903089b78131bdd9f40dff9a9008ad",
      bytes: () => excel("XLS", ROWS),
    },
    {
      name: "V1-XLSX-stored",
      format: "XLSX",
      digest:
        "23c14a714d454545b98a95113d0bc5354bac921cc3cd97383378a428472e33c2",
      bytes: () => excel("XLSX", ROWS),
    },
    {
      name: "V1-XLSX-deflated",
      format: "XLSX",
      digest:
        "451762acfb36490dec4dea10a86b93dd4d1fcb5a0a77f7485e8b19c058071716",
      bytes: () => excel("XLSX", ROWS, {}, true),
    },
    {
      name: "V1-small-ref",
      format: "XLSX",
      digest:
        "7289101c0a37d757ef92cce1a805589596de174eef36cf23dc685a1afff180ab",
      bytes: () => sparseDimension("A1:A1"),
    },
    {
      name: "V1-huge-ref",
      format: "XLSX",
      digest:
        "b707d3d1bc8359afccf7a9ab0dfd036b75e34a50855033f66a6052bb068b3229",
      bytes: () => sparseDimension("A1:XFD1048576"),
    },
    {
      name: "V2-cycles-XLS",
      format: "XLS",
      digest:
        "5aec8745564d77f19fb6b673dd6786f6f7b8524bddcd266a8ab3a33f401153cc",
      bytes: () => excel("XLS", cycleFixture(false)),
    },
    {
      name: "V2-cycles-XLSX",
      format: "XLSX",
      digest:
        "2c3ee6694e19fee60f6078609b445e97ae2620388e7946607c4c6262405d6eb9",
      bytes: () => excel("XLSX", cycleFixture(false)),
    },
    {
      name: "V2-conflict-XLS",
      format: "XLS",
      digest:
        "4e49d71929476866545483e3a2d4c9a4d6498906edd7b66527a8fb6f8b41ec9c",
      bytes: () => excel("XLS", cycleFixture(true)),
    },
    {
      name: "V2-conflict-XLSX",
      format: "XLSX",
      digest:
        "11d989b6ce807f34c0895d0d8c8e97e8ad0d9e3239c6b5157875fbf39cea454c",
      bytes: () => excel("XLSX", cycleFixture(true)),
    },
    ...(
      [
        [
          "XLS",
          "rows",
          4095,
          "6311ce85b97e915d18a16d56268d98ff43ba3053eb667610d1c3d4c7aadc77a5",
        ],
        [
          "XLS",
          "rows",
          4096,
          "78e536b15347f8b2b073c9958012bf56707b38949e71d6e651c09ccf215210a2",
        ],
        [
          "XLS",
          "rows",
          4097,
          "401cabc583a4ea06e56bfa8c83cd0a9c852338c9fdb3c2ea6d85277546c5aa4e",
        ],
        [
          "XLSX",
          "rows",
          4095,
          "2182a7ea7a5ef35cfed28bb40ef93a863ec78031a92ed3605c3093c5ae0177b2",
        ],
        [
          "XLSX",
          "rows",
          4096,
          "334e3f26d274c3dc6f4d50561c240a537bf3383530e8ba6b39191af6aa35ec67",
        ],
        [
          "XLSX",
          "rows",
          4097,
          "a87031626c3e3c2e95baa50c8b77e5b4aa98e8c30b07d3eb4dafe5d2dbf7390c",
        ],
        [
          "XLS",
          "columns",
          255,
          "e32515ecd216f27ae39eb7865929571a2f202abd291d4d7484665b4ac4d67634",
        ],
        [
          "XLS",
          "columns",
          256,
          "b6270c3c0b27ec33def95975d6f5f2347f7861c73063e62b695fb7685455a996",
        ],
        [
          "XLSX",
          "columns",
          255,
          "daf25dca7d321989a43d2ec32ee6a1c09ef3e9f2966f47267d8c975150dece09",
        ],
        [
          "XLSX",
          "columns",
          256,
          "51f6cab40278304bcdf4acd3a7cfd2179b136521d502f9761c4c3ecbe7a8edeb",
        ],
        [
          "XLSX",
          "columns",
          257,
          "4075353303022095f4a0e5016534e301535043602ab0eb00716302c431728b4d",
        ],
      ] as const
    ).map(([format, axis, count, digest]) => ({
      name: `V2-${format}-${axis}-${count}`,
      format,
      digest,
      bytes: () => excel(format, boundaryFixture(axis, count)),
    })),
  ];

  it.each(sealedFixtures)(
    "binding_control $name uses_real_bookFiles_and_sealed_bytes",
    (fixture) => {
      const bytes = fixture.bytes();
      expect(sha(bytes)).toBe(fixture.digest);
      const { spy, seen } = instrument(bytes);
      const book: InventoryBook = XLSX.read(bytes, {
        type: "buffer",
        bookFiles: true,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(seen[0].book).toBe(book);
      expect(book.SheetNames).toStrictEqual(["Fatura"]);
      if (fixture.format === "XLS") {
        expect(seen[0].originalKeys).toContain("cfb");
        expect(book.cfb).toEqual(
          expect.objectContaining({
            FullPaths: expect.any(Array),
            FileIndex: expect.any(Array),
          }),
        );
      } else {
        expect(seen[0].originalKeys).toEqual(
          expect.arrayContaining(["keys", "files"]),
        );
        expect(book.keys).toEqual(
          expect.arrayContaining(["", sentinel, "xl/worksheets/sheet1.xml"]),
        );
        expect(book.files).toEqual(
          expect.objectContaining({
            "": expect.objectContaining({
              name: "Root Entry",
              type: 5,
              size: 0,
            }),
          }),
        );
      }
      console.info(
        "X2_INVENTORY_BINDING",
        JSON.stringify({
          fixture: fixture.name,
          format: fixture.format,
          sha256: sha(bytes),
          inventory: describeInventory(
            fixture.format === "XLS"
              ? book.cfb
              : { keys: book.keys, files: book.files },
          ),
        }),
      );
    },
  );

  it.each([
    { name: "V1-XLS", entries: 3, expanded: 1701 },
    { name: "V1-XLSX-stored", entries: 10, expanded: 15589 },
    { name: "V1-XLSX-deflated", entries: 10, expanded: 15589 },
  ])(
    "real_inventory_extraction $name matches_pinned_sealed_member_catalog",
    async ({ name, entries, expanded }) => {
      const extract = binaryExtractor();
      const fixture = sealedFixtures.find((item) => item.name === name);
      if (!fixture) throw new Error("Missing sealed fixture");
      const bytes = fixture.bytes();
      expect(sha(bytes)).toBe(fixture.digest);
      const { spy } = instrument(bytes);
      const result = await extract(input(fixture.format, bytes));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.metrics).toMatchObject({
        archiveEntries: entries,
        expandedBytes: expanded,
        rows: 3,
      });
      expect(result.occurrences.map((r) => r.amountCents)).toStrictEqual([
        10000, 10000, -200,
      ]);
    },
  );

  it.each(sealedFixtures)(
    "binding_extraction $name refuses_missing_real_inventory_instead_of_zero_metrics",
    async (fixture) => {
      const extract = binaryExtractor();
      const bytes = fixture.bytes();
      expect(sha(bytes)).toBe(fixture.digest);
      const toRows = XLSX.utils.sheet_to_json;
      jest
        .spyOn(XLSX.utils, "sheet_to_json")
        .mockImplementation((sheet, options) => {
          if (sheet["!ref"] === "A1:XFD1048576" && options?.range === undefined)
            throw new Error("QA_REFUSES_DENSE_EXPANSION_OF_ADVERTISED_RANGE");
          return toRows(sheet, options);
        });
      const { spy, seen } = instrument(bytes, (book) => {
        if (fixture.format === "XLS") delete book.cfb;
        else {
          delete book.keys;
          delete book.files;
        }
      });
      await refusal(extract(input(fixture.format, bytes)), "INVALID_RESULT");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(seen[0].originalKeys).toContain(
        fixture.format === "XLS" ? "cfb" : "files",
      );
    },
  );

  it.each(["XLS", "XLSX"] as const)(
    "vector_control_%s_real_read_passthrough_can_replace_only_inventory",
    (format) => {
      const bytes = excel(format, ROWS);
      const inventory = format === "XLS" ? ole() : zip();
      const { spy, seen } = instrument(bytes, (book) =>
        replaceInventory(book, format, inventory),
      );
      const book: InventoryBook = XLSX.read(bytes, {
        type: "buffer",
        bookFiles: true,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(book.Sheets.Fatura.C4.v).toBe("100,00");
      expect(book.Sheets.Fatura.C7.v).toBe("-2,00");
      expect(seen[0].originalKeys).toContain(
        format === "XLS" ? "cfb" : "files",
      );
      if (format === "XLS") expect(book.cfb).toBe(inventory);
      else
        expect(book.files).toBe(
          "files" in inventory ? inventory.files : undefined,
        );
      console.info(
        "X2_INVENTORY_VECTOR",
        JSON.stringify({ format, inventory: describeInventory(inventory) }),
      );
    },
  );

  it("ole_counts_physical_sentinel_storage_and_empty_stream_not_root_or_padding", async () => {
    const extract = binaryExtractor();
    const bytes = excel("XLS", ROWS);
    instrument(bytes, (book) => {
      book.cfb = ole();
    });
    const result = await extract(input("XLS", bytes));
    expect(result.metrics).toMatchObject({
      archiveEntries: 5,
      expandedBytes: 11,
      rows: 3,
    });
    expect(result.occurrences.map((r) => r.amountCents)).toStrictEqual([
      10000, 10000, -200,
    ]);
  });

  it("zip_excludes_only_seeded_root_and_sentinel_and_counts_explicit_directory", async () => {
    const extract = binaryExtractor();
    const bytes = excel("XLSX", ROWS);
    instrument(bytes, (book) => Object.assign(book, zip()));
    const result = await extract(input("XLSX", bytes));
    expect(result.metrics).toMatchObject({
      archiveEntries: 4,
      expandedBytes: 7,
      rows: 3,
    });
    expect(result.occurrences.map((r) => r.amountCents)).toStrictEqual([
      10000, 10000, -200,
    ]);
  });

  it("ole_without_sentinel_is_valid_and_equal_basenames_in_distinct_storages_do_not_collapse", async () => {
    const extract = binaryExtractor();
    const bytes = excel("XLS", ROWS);
    const inventory: Ole = {
      FullPaths: [
        "Budget Root/",
        "Budget Root/a/",
        "Budget Root/b/",
        "Budget Root/a/value",
        "Budget Root/b/value",
      ],
      FileIndex: [
        { name: "Budget Root", type: 5, size: 512, content: Buffer.alloc(512) },
        { name: "a", type: 1, size: 0 },
        { name: "b", type: 1, size: 0 },
        { name: "value", type: 2, size: 2, content: Buffer.alloc(2) },
        { name: "value", type: 2, size: 3, content: Buffer.alloc(3) },
      ],
    };
    instrument(bytes, (book) => {
      book.cfb = inventory;
    });
    expect((await extract(input("XLS", bytes))).metrics).toMatchObject({
      archiveEntries: 4,
      expandedBytes: 5,
    });
  });

  it("zip_counts_control_names_nested_sentinel_and_unlisted_ancestors_only_when_material", async () => {
    const extract = binaryExtractor();
    const bytes = excel("XLSX", ROWS);
    const inventory = zip();
    addZip(inventory, `implicit/${sentinel}`, {
      name: sentinel,
      type: 2,
      size: 4,
      content: Buffer.from([55, 50, 54, 50]),
    });
    addZip(inventory, `${sentinel}-copy`, {
      name: `${sentinel}-copy`,
      type: 2,
      size: 2,
      content: Buffer.alloc(2),
    });
    instrument(bytes, (book) => Object.assign(book, inventory));
    expect((await extract(input("XLSX", bytes))).metrics).toMatchObject({
      archiveEntries: 6,
      expandedBytes: 13,
    });
  });

  it.each([
    "absent",
    "undefined",
    "Buffer-empty",
    "Uint8Array-empty",
    "Buffer-empty-view",
    "Uint8Array-empty-view",
  ] as const)(
    "zip_root_minimal_shape_accepts_%s_content_without_internal_bookkeeping_fields",
    async (kind) => {
      const extract = binaryExtractor();
      const bytes = excel("XLSX", ROWS);
      const inventory = zip();
      if (kind === "undefined") inventory.files[""].content = undefined;
      if (kind === "Buffer-empty")
        inventory.files[""].content = Buffer.alloc(0);
      if (kind === "Uint8Array-empty")
        inventory.files[""].content = new Uint8Array(0);
      if (kind === "Buffer-empty-view")
        inventory.files[""].content = Buffer.from([7, 8]).subarray(1, 1);
      if (kind === "Uint8Array-empty-view")
        inventory.files[""].content = new Uint8Array(new ArrayBuffer(8), 4, 0);
      instrument(bytes, (book) => Object.assign(book, inventory));
      expect((await extract(input("XLSX", bytes))).metrics).toMatchObject({
        archiveEntries: 4,
        expandedBytes: 7,
      });
    },
  );

  const oleInvalid: { name: string; mutate: (inventory: Ole) => void }[] = [
    {
      name: "missing-paths",
      mutate: (x) => {
        Reflect.deleteProperty(x, "FullPaths");
      },
    },
    {
      name: "missing-entries",
      mutate: (x) => {
        Reflect.deleteProperty(x, "FileIndex");
      },
    },
    {
      name: "different-lengths",
      mutate: (x) => {
        x.FullPaths.pop();
      },
    },
    {
      name: "sparse-paths",
      mutate: (x) => {
        delete x.FullPaths[2];
      },
    },
    {
      name: "sparse-entries",
      mutate: (x) => {
        delete x.FileIndex[2];
      },
    },
    {
      name: "non-string-path",
      mutate: (x) => {
        Object.assign(x.FullPaths, { 1: 1 });
      },
    },
    {
      name: "no-root",
      mutate: (x) => {
        x.FileIndex[0].type = 1;
      },
    },
    {
      name: "root-not-index-zero",
      mutate: (x) => {
        [x.FileIndex[0], x.FileIndex[1]] = [x.FileIndex[1], x.FileIndex[0]];
        [x.FullPaths[0], x.FullPaths[1]] = [x.FullPaths[1], x.FullPaths[0]];
      },
    },
    {
      name: "duplicate-root",
      mutate: (x) => {
        addOle(x, "second/", { name: "second", type: 5, size: 0 });
      },
    },
    {
      name: "incoherent-root-path",
      mutate: (x) => {
        x.FullPaths[0] = "Someone Else/";
      },
    },
    {
      name: "duplicate-active-path",
      mutate: (x) => {
        x.FullPaths[4] = x.FullPaths[3];
        x.FileIndex[4].name = "five";
      },
    },
    {
      name: "outside-root-path",
      mutate: (x) => {
        x.FullPaths[3] = "Outside/five";
      },
    },
    {
      name: "unknown-type",
      mutate: (x) => {
        x.FileIndex[3].type = 9;
      },
    },
    {
      name: "storage-payload",
      mutate: (x) => {
        x.FileIndex[2].size = 1;
        x.FileIndex[2].content = Buffer.from([1]);
      },
    },
    {
      name: "padding-payload",
      mutate: (x) => {
        x.FileIndex[6].size = 1;
        x.FileIndex[6].content = Buffer.from([1]);
      },
    },
    {
      name: "stream-content-absent",
      mutate: (x) => {
        delete x.FileIndex[3].content;
      },
    },
    {
      name: "stream-size-mismatch",
      mutate: (x) => {
        x.FileIndex[3].size = 6;
      },
    },
    {
      name: "negative-size",
      mutate: (x) => {
        x.FileIndex[3].size = -1;
      },
    },
    {
      name: "fractional-size",
      mutate: (x) => {
        x.FileIndex[3].size = 5.5;
      },
    },
    {
      name: "string-size",
      mutate: (x) => {
        Object.assign(x.FileIndex[3], { size: "5" });
      },
    },
    {
      name: "unsafe-size",
      mutate: (x) => {
        x.FileIndex[3].size = 9007199254740992;
      },
    },
    {
      name: "array-content",
      mutate: (x) => {
        Object.assign(x.FileIndex[3], { content: [1, 2, 3, 4, 5] });
      },
    },
    {
      name: "empty-null-content",
      mutate: (x) => {
        Object.assign(x.FileIndex[5], { content: null });
      },
    },
  ];
  it.each(oleInvalid)(
    "ole_invalid $name fails_closed_in_extraction",
    async ({ mutate }) => {
      const extract = binaryExtractor();
      const bytes = excel("XLS", ROWS);
      const inventory = ole();
      mutate(inventory);
      instrument(bytes, (book) => {
        book.cfb = inventory;
      });
      await refusal(extract(input("XLS", bytes)), "INVALID_RESULT");
    },
  );

  const zipInvalid: { name: string; mutate: (inventory: Zip) => void }[] = [
    {
      name: "missing-keys",
      mutate: (x) => {
        Reflect.deleteProperty(x, "keys");
      },
    },
    {
      name: "missing-files",
      mutate: (x) => {
        Reflect.deleteProperty(x, "files");
      },
    },
    {
      name: "sparse-keys",
      mutate: (x) => {
        delete x.keys[2];
      },
    },
    {
      name: "non-string-key",
      mutate: (x) => {
        Object.assign(x.keys, { 2: 2 });
      },
    },
    {
      name: "missing-own-file",
      mutate: (x) => {
        delete x.files.five;
      },
    },
    {
      name: "extra-own-file",
      mutate: (x) => {
        x.files.extra = {
          name: "extra",
          type: 2,
          size: 0,
          content: Buffer.alloc(0),
        };
      },
    },
    {
      name: "duplicate-key",
      mutate: (x) => {
        x.keys.push("five");
      },
    },
    {
      name: "sentinel-collision",
      mutate: (x) => {
        x.keys.push(sentinel);
      },
    },
    {
      name: "root-collision",
      mutate: (x) => {
        x.keys.push("");
      },
    },
    {
      name: "missing-sentinel",
      mutate: (x) => {
        x.keys = x.keys.filter((k) => k !== sentinel);
        delete x.files[sentinel];
      },
    },
    {
      name: "sentinel-wrong-name",
      mutate: (x) => {
        x.files[sentinel].name = "not-seed";
      },
    },
    {
      name: "sentinel-wrong-type",
      mutate: (x) => {
        x.files[sentinel].type = 1;
      },
    },
    {
      name: "sentinel-wrong-size",
      mutate: (x) => {
        x.files[sentinel].size = 5;
      },
    },
    {
      name: "sentinel-wrong-payload",
      mutate: (x) => {
        x.files[sentinel].content = Buffer.from([55, 50, 54, 51]);
      },
    },
    {
      name: "sentinel-array",
      mutate: (x) => {
        Object.assign(x.files[sentinel], { content: [55, 50, 54, 50] });
      },
    },
    {
      name: "missing-root",
      mutate: (x) => {
        x.keys = x.keys.filter((k) => k !== "");
        delete x.files[""];
      },
    },
    {
      name: "inherited-root-not-own",
      mutate: (x) => {
        const root = x.files[""];
        delete x.files[""];
        Object.setPrototypeOf(x.files, { "": root });
      },
    },
    {
      name: "root-wrong-name",
      mutate: (x) => {
        x.files[""].name = "R";
      },
    },
    {
      name: "root-wrong-type",
      mutate: (x) => {
        x.files[""].type = 2;
      },
    },
    {
      name: "root-string-size",
      mutate: (x) => {
        Object.assign(x.files[""], { size: "0" });
      },
    },
    {
      name: "root-nonzero-size",
      mutate: (x) => {
        x.files[""].size = 1;
      },
    },
    {
      name: "root-null-content",
      mutate: (x) => {
        Object.assign(x.files[""], { content: null });
      },
    },
    {
      name: "root-string-content",
      mutate: (x) => {
        Object.assign(x.files[""], { content: "" });
      },
    },
    {
      name: "root-array-content",
      mutate: (x) => {
        Object.assign(x.files[""], { content: [] });
      },
    },
    {
      name: "root-Buffer-payload",
      mutate: (x) => {
        x.files[""].content = Buffer.from([0]);
      },
    },
    {
      name: "root-Uint8Array-payload",
      mutate: (x) => {
        x.files[""].content = new Uint8Array([0]);
      },
    },
    {
      name: "directory-payload",
      mutate: (x) => {
        x.files["docs/"].size = 1;
        x.files["docs/"].content = Buffer.from([0]);
      },
    },
    {
      name: "unknown-file-type",
      mutate: (x) => {
        x.files.five.type = 9;
      },
    },
    {
      name: "positive-content-absent",
      mutate: (x) => {
        delete x.files.five.content;
      },
    },
    {
      name: "empty-content-absent",
      mutate: (x) => {
        delete x.files.empty.content;
      },
    },
    {
      name: "content-size-mismatch",
      mutate: (x) => {
        x.files.five.size = 6;
      },
    },
    {
      name: "string-file-size",
      mutate: (x) => {
        Object.assign(x.files.five, { size: "5" });
      },
    },
    {
      name: "unsafe-file-size",
      mutate: (x) => {
        x.files.five.size = 9007199254740992;
      },
    },
    {
      name: "file-array-content",
      mutate: (x) => {
        Object.assign(x.files.five, { content: [1, 2, 3, 4, 5] });
      },
    },
  ];
  it.each(zipInvalid)(
    "zip_invalid $name fails_closed_in_extraction",
    async ({ mutate }) => {
      const extract = binaryExtractor();
      const bytes = excel("XLSX", ROWS);
      const inventory = zip();
      mutate(inventory);
      instrument(bytes, (book) => {
        delete book.keys;
        delete book.files;
        Object.assign(book, inventory);
      });
      await refusal(extract(input("XLSX", bytes)), "INVALID_RESULT");
    },
  );

  const entryCases = (["XLS", "XLSX"] as const).flatMap((format) =>
    [999, 1000, 1001].map((count) => ({ format, count })),
  );
  it.each(entryCases)(
    "entry_vector_control $format/$count keeps_structural_slots_separate",
    ({ format, count }) => {
      const inventory = entryVector(format, count);
      if ("FullPaths" in inventory) {
        expect(inventory.FullPaths).toHaveLength(count + 3);
        expect(inventory.FileIndex[0]).toMatchObject({ type: 5, size: 512 });
        expect(
          inventory.FileIndex.filter((member) => member.type === 0),
        ).toHaveLength(2);
      } else {
        expect(inventory.keys).toHaveLength(count + 2);
        expect(inventory.keys.slice(0, 3)).toStrictEqual([
          "",
          sentinel,
          "docs/",
        ]);
      }
      console.info(
        "X2_INVENTORY_ENTRIES",
        JSON.stringify({
          format,
          count,
          inventory: describeInventory(inventory),
        }),
      );
    },
  );
  it.each(entryCases)(
    "entry_boundary $format/$count counts_members_in_extraction_not_supplied_DTO_metrics",
    async ({ format, count }) => {
      const extract = binaryExtractor();
      const bytes = excel(format, ROWS);
      instrument(bytes, (book) =>
        replaceInventory(book, format, entryVector(format, count)),
      );
      if (count === 1001)
        await refusal(extract(input(format, bytes)), "LIMIT_EXCEEDED");
      else
        expect((await extract(input(format, bytes))).metrics).toMatchObject({
          archiveEntries: count,
          expandedBytes: format === "XLS" ? 11 : 7,
        });
    },
  );

  const byteCases = [
    { format: "XLS", bytes: 52428799, lastBytes: 65531, entries: 803 },
    { format: "XLS", bytes: 52428800, lastBytes: 65532, entries: 803 },
    { format: "XLS", bytes: 52428801, lastBytes: 65533, entries: 803 },
    { format: "XLSX", bytes: 52428799, lastBytes: 65535, entries: 802 },
    { format: "XLSX", bytes: 52428800, lastBytes: 65536, entries: 802 },
    { format: "XLSX", bytes: 52428801, lastBytes: 65537, entries: 802 },
  ] as const;
  it.each(byteCases)(
    "byte_vector_control $format/$bytes uses_small_shared_backing_and_exact_views",
    ({ format, bytes, lastBytes }) => {
      const vector = byteVector(format, lastBytes);
      expect(vector.backing.byteLength).toBe(65568);
      expect(vector.alias.byteLength).toBe(65536);
      expect(vector.alias.buffer).toBe(vector.tail.buffer);
      expect(vector.tail.byteLength).toBe(lastBytes);
      expect(vector.members).toHaveLength(800);
      expect(vector.members[799].content).toBe(vector.tail);
      expect(
        vector.members
          .slice(0, 799)
          .every((member) => member.content === vector.alias),
      ).toBe(true);
      expect(799 * 65536 + lastBytes + (format === "XLS" ? 4 : 0)).toBe(bytes);
      console.info(
        "X2_INVENTORY_BYTES",
        JSON.stringify({
          format,
          expectedBytes: bytes,
          repeatedViewCount: 799,
          lastBytes,
          backingBase64: vector.backing.toString("base64"),
          backingSha256: sha(vector.backing),
          view: describeInventory(vector.alias),
          tail: describeInventory(vector.tail),
        }),
      );
    },
  );
  it.each(byteCases)(
    "expanded_boundary $format/$bytes counts_views_and_aliases_through_extraction",
    async ({ format, bytes, lastBytes, entries }) => {
      const extract = binaryExtractor();
      const original = excel(format, ROWS);
      const vector = byteVector(format, lastBytes);
      instrument(original, (book) =>
        replaceInventory(book, format, vector.inventory),
      );
      if (bytes === 52428801)
        await refusal(extract(input(format, original)), "LIMIT_EXCEEDED");
      else
        expect((await extract(input(format, original))).metrics).toMatchObject({
          archiveEntries: entries,
          expandedBytes: bytes,
        });
    },
  );
});
