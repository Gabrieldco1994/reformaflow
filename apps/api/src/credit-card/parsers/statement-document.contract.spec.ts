import { parseCsv } from "./csv";
import { parseOfx } from "./ofx";

// Independent X1-L1 contract, including the mediated complete-JSON envelope.
type TextInput =
  | {
      version: 1;
      context: "CARD_INVOICE";
      format: "CSV";
      profile: "CSV_NUBANK" | "CSV_ITAU";
      bytes: Buffer;
    }
  | {
      version: 1;
      context: "CARD_INVOICE";
      format: "OFX";
      profile: "OFX_CARD";
      bytes: Buffer;
    };

type Raw = {
  date: string | null;
  description: string | null;
  amount: string | null;
  installment: string | null;
};
type Occurrence = {
  reference: string;
  sourceOrdinal: number;
  section: "CURRENT" | "FUTURE" | "UNKNOWN";
  raw: Raw;
  dateOnly: string | null;
  merchant: string | null;
  amountCents: number | null;
  amountMeaning: "TOTAL_PURCHASE" | "INSTALLMENT_CHARGE" | "UNKNOWN";
  installmentCount: number | null;
  installmentIndex: number | null;
  fitId: string | null;
  identityOrdinal: number | null;
  cycle: null;
};
type Diagnostic = {
  reference: string | null;
  code:
    | "UNREADABLE_ROW"
    | "UNKNOWN_DATE"
    | "UNKNOWN_AMOUNT_MEANING"
    | "UNSUPPORTED_CONTENT"
    | "INVALID_CALENDAR_DATE"
    | "AMBIGUOUS_CYCLE"
    | "OVERLONG_FIELD";
};
type Document = {
  version: 1;
  parserVersion: string;
  documentKind: "INVOICE" | "BANK_STATEMENT" | "RECEIPT" | "UNKNOWN";
  invoiceDueMonth: string | null;
  metrics: {
    pages: number;
    rows: number;
    expandedBytes: number;
    archiveEntries: number;
    imagePixels: number;
    frames: number;
  };
  occurrences: Occurrence[];
  diagnostics: Diagnostic[];
};
type ExtractionCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_DOCUMENT"
  | "LIMIT_EXCEEDED"
  | "INVALID_RESULT";
type DocumentApi = {
  extractCardStatementDocument(input: TextInput): Document;
  validateDocumentExtraction(value: unknown): Document;
  DocumentExtractionError: new (...args: never[]) => Error & {
    readonly code: ExtractionCode;
  };
};

function loadApi(): DocumentApi {
  let resolved: string | null = null;
  try {
    resolved = require.resolve("./statement-document");
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "MODULE_NOT_FOUND" ||
      !("message" in error) ||
      typeof error.message !== "string" ||
      !error.message.startsWith("Cannot find module './statement-document'")
    ) {
      throw error;
    }
  }
  expect({
    "QAX1 real statement-document entrypoint (absent on approved 9946)":
      resolved,
  }).toEqual({
    "QAX1 real statement-document entrypoint (absent on approved 9946)":
      expect.any(String),
  });
  if (resolved === null) throw new Error("QAX1: documentary entrypoint absent");
  // Loading is outside the resolution catch: transitive failures must propagate.
  const api: DocumentApi = require(resolved);
  expect(typeof api.extractCardStatementDocument).toBe("function");
  expect(typeof api.validateDocumentExtraction).toBe("function");
  expect(typeof api.DocumentExtractionError).toBe("function");
  return api;
}

function expectError(
  api: DocumentApi,
  action: () => unknown,
  code: ExtractionCode,
): void {
  let failure: unknown;
  try {
    action();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(api.DocumentExtractionError);
  expect(failure).toMatchObject({ code });
}

function expectFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectFrozen(child);
}

function expectClosedDocument(result: Document): void {
  expect(Object.keys(result).sort()).toEqual(
    [
      "version",
      "parserVersion",
      "documentKind",
      "invoiceDueMonth",
      "metrics",
      "occurrences",
      "diagnostics",
    ].sort(),
  );
  expect(result.version).toBe(1);
  expect(result.parserVersion).toBe("card-local-text-v1");
  expect(result.invoiceDueMonth).toBeNull();
  expect(result.metrics).toStrictEqual({
    pages: 0,
    rows: result.occurrences.length,
    expandedBytes: 0,
    archiveEntries: 0,
    imagePixels: 0,
    frames: 0,
  });
  for (const occurrence of result.occurrences) {
    expect(Object.keys(occurrence).sort()).toEqual(
      [
        "reference",
        "sourceOrdinal",
        "section",
        "raw",
        "dateOnly",
        "merchant",
        "amountCents",
        "amountMeaning",
        "installmentCount",
        "installmentIndex",
        "fitId",
        "identityOrdinal",
        "cycle",
      ].sort(),
    );
    expect(Object.keys(occurrence.raw).sort()).toEqual(
      ["date", "description", "amount", "installment"].sort(),
    );
    expect(occurrence.cycle).toBeNull();
    for (const field of [
      occurrence.dateOnly,
      occurrence.merchant,
      occurrence.amountCents,
      occurrence.installmentCount,
      occurrence.installmentIndex,
      occurrence.fitId,
      occurrence.identityOrdinal,
      ...Object.values(occurrence.raw),
    ]) {
      expect(field).not.toBeUndefined();
    }
  }
  for (const diagnostic of result.diagnostics) {
    expect(Object.keys(diagnostic).sort()).toEqual(["code", "reference"]);
  }
  expectFrozen(result);
}

function csvInput(
  content: string,
  profile: "CSV_NUBANK" | "CSV_ITAU" = "CSV_NUBANK",
): TextInput {
  return {
    version: 1,
    context: "CARD_INVOICE",
    format: "CSV",
    profile,
    bytes: Buffer.from(content),
  };
}

function ofxInput(content: string): TextInput {
  return {
    version: 1,
    context: "CARD_INVOICE",
    format: "OFX",
    profile: "OFX_CARD",
    bytes: Buffer.from(content),
  };
}

function wrapOfx(transactions: string): string {
  return `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>BRL
<CCACCTFROM><ACCTID>QAX1-CARD</CCACCTFROM>
<BANKTRANLIST><DTSTART>20250101<DTEND>20251130
${transactions}
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
}

const NUBANK = [
  "date,title,amount",
  "2025-09-14,ATELIER LUA PARC 2/3,45.67",
  ",SEM CALENDARIO,100abc",
  "2025-09-14,ATELIER LUA PARC 2/3,45.67",
  "2025-01-02,AJUSTE,-12.34",
  "2025-09-16,ZERO,0.00",
].join("\n");
const ITAU = [
  "data;descricao;valor",
  "14/09/2025;ATELIER LUA PARC 2/3;R$ 45,67",
  ";SEM CALENDARIO;100abc",
  "14/09/2025;ATELIER LUA PARC 2/3;R$ 45,67",
  "02/01/2025;AJUSTE;-12,34",
  "16/09/2025;ZERO;0,00",
].join("\n");
const OFX = wrapOfx(
  [
    "<STMTTRN><DTPOSTED>20250914<TRNAMT>-45.67<FITID>QA-FIT-7<MEMO>ORBITA PARC 2/3</STMTTRN>",
    "<STMTTRN><DTPOSTED>20250915<TRNAMT>-8.90<MEMO>GEMEA</STMTTRN>",
    "<STMTTRN><TRNAMT>-100abc<MEMO>SEM DATA</STMTTRN>",
    "<STMTTRN><DTPOSTED>20250915<TRNAMT>-8.90<MEMO>GEMEA</STMTTRN>",
    "<STMTTRN><DTPOSTED>20250914<TRNAMT>-45.67<FITID>QA-FIT-7<MEMO>ORBITA PARC 2/3</STMTTRN>",
    "<STMTTRN><DTPOSTED>20250102<TRNAMT>12.34<MEMO>CREDITO</STMTTRN>",
  ].join("\n"),
);
const csvCases = [
  ["CSV_NUBANK", NUBANK],
  ["CSV_ITAU", ITAU],
] as const;

function validDocument(): Document {
  return {
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
          date: "2025-01-02",
          description: "CANDEIA",
          amount: "0.00",
          installment: null,
        },
        dateOnly: "2025-01-02",
        merchant: "CANDEIA",
        amountCents: 0,
        amountMeaning: "UNKNOWN",
        installmentCount: null,
        installmentIndex: null,
        fitId: null,
        identityOrdinal: 0,
        cycle: null,
      },
    ],
    diagnostics: [
      { reference: "csv:record:2", code: "UNKNOWN_AMOUNT_MEANING" },
    ],
  };
}

function unknownDocument(): Document {
  const value = validDocument();
  Object.assign(value.occurrences[0], {
    raw: { date: null, description: null, amount: null, installment: null },
    dateOnly: null,
    merchant: null,
    amountCents: null,
    identityOrdinal: null,
  });
  value.diagnostics.push(
    { reference: "csv:record:2", code: "UNKNOWN_DATE" },
    { reference: "csv:record:2", code: "UNREADABLE_ROW" },
  );
  return value;
}

const rawFields = ["date", "description", "amount", "installment"] as const;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sizedDocument(
  target: number,
  variant: "ascii" | "escaped-unicode" | "aliased-raw",
): Document {
  const value = unknownDocument();
  const first = value.occurrences[0];
  first.raw.description =
    variant === "escaped-unicode"
      ? '\u00e7\u{1f680}"\\\n\t\u0000\ud800'.repeat(2048)
      : "";
  value.diagnostics.push({
    reference: "csv:record:2",
    code: "OVERLONG_FIELD",
  });
  if (variant === "aliased-raw") {
    value.occurrences.push(
      { ...first, reference: "csv:record:3", sourceOrdinal: 1 },
      {
        ...first,
        reference: "csv:record:4",
        sourceOrdinal: 2,
        raw: { date: null, description: "", amount: null, installment: null },
      },
    );
    value.metrics.rows = 3;
  }
  const remaining = target - jsonBytes(value);
  expect(remaining).toBeGreaterThan(0);
  if (variant === "aliased-raw") {
    expect(value.occurrences[0].raw).toBe(value.occurrences[1].raw);
    first.raw.description += "x".repeat(Math.floor(remaining / 2));
    value.occurrences[2].raw.description = "x".repeat(remaining % 2);
  } else {
    first.raw.description += "x".repeat(remaining);
  }
  expect(jsonBytes(value)).toBe(target);
  return value;
}

describe("QAX1 documentary API — prospective contract on inactive 9946", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("exports the real opt-in entrypoint, validator and typed error", () => {
    loadApi();
  });

  it.each(csvCases)(
    "%s preserves complete occurrences before legacy filtering",
    (profile, content) => {
      const api = loadApi();
      const result = api.extractCardStatementDocument(
        csvInput(content, profile),
      );
      expectClosedDocument(result);
      expect(result.documentKind).toBe("UNKNOWN");
      expect(result.metrics.rows).toBe(5);
      expect(result.occurrences.map((row) => row.reference)).toEqual([
        "csv:record:2",
        "csv:record:3",
        "csv:record:4",
        "csv:record:5",
        "csv:record:6",
      ]);
      expect(result.occurrences.map((row) => row.sourceOrdinal)).toEqual([
        0, 1, 2, 3, 4,
      ]);
      expect(result.occurrences.map((row) => row.identityOrdinal)).toEqual([
        0,
        null,
        1,
        0,
        0,
      ]);
      expect(result.occurrences.map((row) => row.amountCents)).toEqual([
        4567,
        null,
        4567,
        -1234,
        0,
      ]);
      expect(result.occurrences.map((row) => row.dateOnly)).toEqual([
        "2025-09-14",
        null,
        "2025-09-14",
        "2025-01-02",
        "2025-09-16",
      ]);
      expect(result.occurrences.map((row) => row.fitId)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(result.occurrences[1].raw.amount).toBe("100abc");
      expect(result.occurrences[1].raw.date).toBe("");
      for (const index of [0, 2]) {
        expect(result.occurrences[index]).toMatchObject({
          merchant: "ATELIER LUA",
          amountMeaning: "INSTALLMENT_CHARGE",
          installmentIndex: 2,
          installmentCount: 3,
          amountCents: 4567,
        });
      }
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          { reference: "csv:record:3", code: "UNKNOWN_DATE" },
          { reference: "csv:record:3", code: "UNREADABLE_ROW" },
        ]),
      );
    },
  );

  it("preserves OFX FITID presence, absence, repetition, twins and source order", () => {
    const api = loadApi();
    const result = api.extractCardStatementDocument(ofxInput(OFX));
    expectClosedDocument(result);
    expect(result.documentKind).toBe("INVOICE");
    expect(result.metrics.rows).toBe(6);
    expect(result.occurrences.map((row) => row.reference)).toEqual([
      "ofx:stmttrn:1",
      "ofx:stmttrn:2",
      "ofx:stmttrn:3",
      "ofx:stmttrn:4",
      "ofx:stmttrn:5",
      "ofx:stmttrn:6",
    ]);
    expect(result.occurrences.map((row) => row.sourceOrdinal)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(result.occurrences.map((row) => row.identityOrdinal)).toEqual([
      0,
      0,
      null,
      1,
      1,
      0,
    ]);
    expect(result.occurrences.map((row) => row.fitId)).toEqual([
      "QA-FIT-7",
      null,
      null,
      null,
      "QA-FIT-7",
      null,
    ]);
    expect(result.occurrences.map((row) => row.amountCents)).toEqual([
      4567,
      890,
      null,
      890,
      4567,
      -1234,
    ]);
    expect(result.occurrences.map((row) => row.raw.amount)).toEqual([
      "-45.67",
      "-8.90",
      "-100abc",
      "-8.90",
      "-45.67",
      "12.34",
    ]);
    expect(result.occurrences[2].raw.date).toBeNull();
    expect(result.occurrences[2].dateOnly).toBeNull();
    expect(result.occurrences[0]).toMatchObject({
      amountMeaning: "INSTALLMENT_CHARGE",
      installmentCount: 3,
      installmentIndex: 2,
    });
    expect(result.occurrences[5].dateOnly).toBe("2025-01-02");
  });

  it.each(["CSV_NUBANK", "CSV_ITAU"] as const)(
    "%s requires whole money tokens and keeps empty, zero and negative rows",
    (profile) => {
      const api = loadApi();
      const content =
        profile === "CSV_NUBANK"
          ? "date,title,amount\n2025-01-02,A,100abc\n2025-01-02,B,\n2025-01-02,C,0.00\n2025-01-02,D,-12.34\n"
          : "data;descricao;valor\n02/01/2025;A;100abc\n02/01/2025;B;\n02/01/2025;C;0,00\n02/01/2025;D;-12,34\n";
      const result = api.extractCardStatementDocument(
        csvInput(content, profile),
      );
      expectClosedDocument(result);
      expect(result.metrics.rows).toBe(4);
      expect(result.occurrences.map((row) => row.amountCents)).toEqual([
        null,
        null,
        0,
        -1234,
      ]);
      expect(result.occurrences.map((row) => row.identityOrdinal)).toEqual([
        null,
        null,
        0,
        0,
      ]);
      expect(
        result.occurrences.slice(0, 2).map((row) => row.raw.amount),
      ).toEqual(["100abc", ""]);
    },
  );

  it("requires whole OFX money tokens and applies the card sign exactly once", () => {
    const api = loadApi();
    const result = api.extractCardStatementDocument(
      ofxInput(
        wrapOfx(
          ["-100abc", "", "0.00", "-12.34", "12.34"]
            .map(
              (amount) =>
                `<STMTTRN><DTPOSTED>20250102<TRNAMT>${amount}<MEMO>DINHEIRO</STMTTRN>`,
            )
            .join("\n"),
        ),
      ),
    );
    expectClosedDocument(result);
    expect(result.metrics.rows).toBe(5);
    expect(result.occurrences.map((row) => row.amountCents)).toEqual([
      null,
      null,
      0,
      1234,
      -1234,
    ]);
  });

  it.each([25, 60])(
    "keeps printed installment count %i as fact, without building a schedule",
    (count) => {
      const api = loadApi();
      const result = api.extractCardStatementDocument(
        csvInput(`date,title,amount\n2025-01-02,ESTUDIO PARC 2/${count},17.89`),
      );
      expectClosedDocument(result);
      expect(result.metrics.rows).toBe(1);
      expect(result.occurrences[0]).toMatchObject({
        amountMeaning: "INSTALLMENT_CHARGE",
        installmentCount: count,
        installmentIndex: 2,
        amountCents: 1789,
        cycle: null,
      });
    },
  );

  it("does not promote absent installment evidence to total-purchase certainty", () => {
    const api = loadApi();
    const result = api.extractCardStatementDocument(
      csvInput("date,title,amount\n2025-01-02,CANDEIA,0.00"),
    );
    expectClosedDocument(result);
    expect(result.occurrences).toStrictEqual(validDocument().occurrences);
  });

  it.each(["2026-12-31T23:59:59.000Z", "2027-01-01T00:00:01.000Z"])(
    "calendar facts do not depend on clock %s (run in UTC and BRT)",
    (clock) => {
      const api = loadApi();
      jest.useFakeTimers().setSystemTime(new Date(clock));
      const cases = [
        csvInput(
          "date,title,amount\n2025-01-02,A,1.00\n,B,1.00\n02/01,C,1.00\n2026-02-31,D,1.00\n2024-02-29,E,1.00",
        ),
        csvInput(
          "data;descricao;valor\n02/01/2025;A;1,00\n;B;1,00\n02/01;C;1,00\n31/02/2026;D;1,00\n29/02/2024;E;1,00",
          "CSV_ITAU",
        ),
        ofxInput(
          wrapOfx(
            ["20250102", "", "0102", "20260231", "20240229"]
              .map(
                (date, index) =>
                  `<STMTTRN><DTPOSTED>${date}<TRNAMT>-1.00<MEMO>D${index}</STMTTRN>`,
              )
              .join("\n"),
          ),
        ),
      ];
      for (const input of cases) {
        const result = api.extractCardStatementDocument(input);
        expectClosedDocument(result);
        expect(result.metrics.rows).toBe(5);
        expect(result.occurrences.map((row) => row.dateOnly)).toEqual([
          "2025-01-02",
          null,
          null,
          null,
          "2024-02-29",
        ]);
        for (const index of [1, 2]) {
          expect(result.diagnostics).toContainEqual({
            reference: result.occurrences[index].reference,
            code: "UNKNOWN_DATE",
          });
        }
        expect(result.diagnostics).toContainEqual({
          reference: result.occurrences[3].reference,
          code: "INVALID_CALENDAR_DATE",
        });
      }
    },
  );

  it("preserves CSV structural decoding, spaces, empty fields and absent cells", () => {
    const api = loadApi();
    const result = api.extractCardStatementDocument(
      csvInput(
        'date,title,amount\n 2025-01-02 ,"  LOJA ""LUA""  ", 0.00 \n,,\n,\n   , \t ,  ',
      ),
    );
    expectClosedDocument(result);
    expect(result.metrics.rows).toBe(4);
    expect(result.occurrences.map((row) => row.raw)).toStrictEqual([
      {
        date: " 2025-01-02 ",
        description: '  LOJA "LUA"  ',
        amount: " 0.00 ",
        installment: null,
      },
      { date: "", description: "", amount: "", installment: null },
      { date: "", description: "", amount: null, installment: null },
      { date: "   ", description: " \t ", amount: "  ", installment: null },
    ]);
  });

  it("preserves OFX absent versus empty tags and captured whitespace", () => {
    const api = loadApi();
    const result = api.extractCardStatementDocument(
      ofxInput(
        wrapOfx(
          "<STMTTRN></STMTTRN>\n" +
            "<STMTTRN><DTPOSTED></DTPOSTED><TRNAMT></TRNAMT><MEMO></MEMO></STMTTRN>\n" +
            "<STMTTRN><DTPOSTED> 20250102 </DTPOSTED><TRNAMT> -1.00 </TRNAMT><MEMO>  LUA  </MEMO></STMTTRN>",
        ),
      ),
    );
    expectClosedDocument(result);
    expect(result.metrics.rows).toBe(3);
    expect(result.occurrences.map((row) => row.raw)).toStrictEqual([
      { date: null, description: null, amount: null, installment: null },
      { date: "", description: "", amount: "", installment: null },
      {
        date: " 20250102 ",
        description: "  LUA  ",
        amount: " -1.00 ",
        installment: null,
      },
    ]);
  });

  it.each(["CSV_NUBANK", "CSV_ITAU", "OFX_CARD"] as const)(
    "%s captures long date/description/amount verbatim before normalization",
    (profile) => {
      const api = loadApi();
      const text = "e\u0301".repeat(751);
      const input =
        profile === "OFX_CARD"
          ? ofxInput(
              wrapOfx(
                `<STMTTRN><DTPOSTED>${text}<TRNAMT>${text}<MEMO>${text}</STMTTRN>`,
              ),
            )
          : csvInput(
              profile === "CSV_ITAU"
                ? `data;descricao;valor\n${text};${text};${text}`
                : `date,title,amount\n${text},${text},${text}`,
              profile,
            );
      const result = api.extractCardStatementDocument(input);
      expectClosedDocument(result);
      expect(result.occurrences).toHaveLength(1);
      expect(result.occurrences[0]).toMatchObject({
        raw: { date: text, description: text, amount: text, installment: null },
        dateOnly: null,
        merchant: null,
        amountCents: null,
        identityOrdinal: null,
      });
      expect(result.diagnostics).toContainEqual({
        reference: result.occurrences[0].reference,
        code: "OVERLONG_FIELD",
      });
    },
  );

  it.each([160, 161, 1001])(
    "merchant length %i uses its own cap without truncating raw",
    (length) => {
      const api = loadApi();
      const description = "M".repeat(length);
      const result = api.extractCardStatementDocument(
        csvInput(`date,title,amount\n2025-01-02,${description},1.00`),
      );
      expectClosedDocument(result);
      expect(result.occurrences[0].raw.description).toBe(description);
      expect(result.occurrences[0].merchant).toBe(
        length <= 160 ? description : null,
      );
      if (length > 160) {
        expect(result.occurrences[0].identityOrdinal).toBeNull();
        expect(result.diagnostics).toContainEqual({
          reference: "csv:record:2",
          code: "OVERLONG_FIELD",
        });
      }
    },
  );

  const invalidInputs: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["version", { ...csvInput(NUBANK), version: 2 }],
    ["BANK", { ...csvInput(NUBANK), context: "BANK_STATEMENT" }],
    ["RECEIPT", { ...csvInput(NUBANK), context: "RECEIPT" }],
    ["AUTO", { ...csvInput(NUBANK), format: "AUTO" }],
    ["PDF", { ...csvInput(NUBANK), format: "PDF" }],
    ["XLS", { ...csvInput(NUBANK), format: "XLS" }],
    ["XLSX", { ...csvInput(NUBANK), format: "XLSX" }],
    ["PNG", { ...csvInput(NUBANK), format: "PNG" }],
    ["generic CSV", { ...csvInput(NUBANK), profile: "CSV_GENERIC" }],
    ["unknown profile", { ...csvInput(NUBANK), profile: "SYNTHETIC" }],
    ["CSV OFX profile", { ...csvInput(NUBANK), profile: "OFX_CARD" }],
    ["OFX CSV profile", { ...ofxInput(OFX), profile: "CSV_ITAU" }],
    ["string bytes", { ...csvInput(NUBANK), bytes: NUBANK }],
    ["Uint8Array bytes", { ...csvInput(NUBANK), bytes: new Uint8Array([1]) }],
    ["filename", { ...csvInput(NUBANK), filename: "test.csv" }],
    ["path", { ...csvInput(NUBANK), path: "/not-read.csv" }],
    ["tenant", { ...csvInput(NUBANK), tenantId: "not-authority" }],
    ["clock", { ...csvInput(NUBANK), clock: "2027-01-01" }],
    ["card", { ...csvInput(NUBANK), cardId: "not-evidence" }],
  ];
  it.each(invalidInputs)(
    "rejects exact input violation %s",
    (_label, input) => {
      const api = loadApi();
      expectError(
        api,
        () =>
          Reflect.apply(api.extractCardStatementDocument, undefined, [input]),
        "INVALID_INPUT",
      );
    },
  );

  it.each(["version", "context", "format", "profile", "bytes"])(
    "rejects missing input key %s",
    (key) => {
      const api = loadApi();
      const input = csvInput(NUBANK);
      Reflect.deleteProperty(input, key);
      expectError(
        api,
        () => api.extractCardStatementDocument(input),
        "INVALID_INPUT",
      );
    },
  );

  it("rejects unequivocal BANK OFX instead of applying card conventions", () => {
    const api = loadApi();
    const bank =
      "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL" +
      "<BANKACCTFROM><BANKID>001<ACCTID>QAX1-BANK<ACCTTYPE>CHECKING</BANKACCTFROM>" +
      "<BANKTRANLIST><STMTTRN><DTPOSTED>20250102<TRNAMT>-1.00<MEMO>BANCO</STMTTRN></BANKTRANLIST>" +
      "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
    expectError(
      api,
      () => api.extractCardStatementDocument(ofxInput(bank)),
      "UNSUPPORTED_DOCUMENT",
    );
  });

  it.each(["2025-01-02,CANDEIA,1.00", "a,b,c\n2025-01-02,CANDEIA,1.00"])(
    "refuses CSV without a recognized header: %s",
    (content) => {
      const api = loadApi();
      expectError(
        api,
        () => api.extractCardStatementDocument(csvInput(content)),
        "UNSUPPORTED_DOCUMENT",
      );
    },
  );

  it.each(["CSV_NUBANK", "CSV_ITAU", "OFX_CARD"] as const)(
    "%s row limit is inclusive and never silently truncates",
    (profile) => {
      const api = loadApi();
      for (const count of [999, 1000, 1001]) {
        const input =
          profile === "OFX_CARD"
            ? ofxInput(
                wrapOfx(
                  "<STMTTRN><DTPOSTED>20250102<TRNAMT>-1.00<MEMO>GEMEA</STMTTRN>\n".repeat(
                    count,
                  ),
                ),
              )
            : csvInput(
                profile === "CSV_ITAU"
                  ? `data;descricao;valor\n${"02/01/2025;GEMEA;1,00\n".repeat(count)}`
                  : `date,title,amount\n${"2025-01-02,GEMEA,1.00\n".repeat(count)}`,
                profile,
              );
        if (count > 1000) {
          expectError(
            api,
            () => api.extractCardStatementDocument(input),
            "LIMIT_EXCEEDED",
          );
        } else {
          const result = api.extractCardStatementDocument(input);
          expectClosedDocument(result);
          expect(result.metrics.rows).toBe(count);
          expect(result.occurrences).toHaveLength(count);
          expect(result.occurrences[count - 1]).toMatchObject({
            reference:
              profile === "OFX_CARD"
                ? `ofx:stmttrn:${count}`
                : `csv:record:${count + 1}`,
            sourceOrdinal: count - 1,
            identityOrdinal: count - 1,
          });
        }
      }
    },
  );

  it.each([10485759, 10485760, 10485761])(
    "independently enforces input byte boundary %i",
    (size) => {
      const api = loadApi();
      const content = wrapOfx(
        "<STMTTRN><DTPOSTED>20250102<TRNAMT>-1.00<MEMO>CANDEIA</STMTTRN>",
      );
      const input = ofxInput(
        content + " ".repeat(size - Buffer.byteLength(content, "utf8")),
      );
      expect(input.bytes.byteLength).toBe(size);
      if (size > 10485760) {
        expectError(
          api,
          () => api.extractCardStatementDocument(input),
          "LIMIT_EXCEEDED",
        );
      } else {
        const result = api.extractCardStatementDocument(input);
        expectClosedDocument(result);
        expect(result.metrics.rows).toBe(1);
        expect(result.occurrences[0].amountCents).toBe(100);
      }
    },
  );

  it("rejects a legal CSV input that expands beyond the complete output envelope", () => {
    const api = loadApi();
    const raw = "\\".repeat(5242880);
    const input = csvInput(`date,title,amount\n2025-01-02,${raw},1.00`);
    expect(input.bytes.byteLength).toBeLessThan(10485760);
    expect(Buffer.byteLength(JSON.stringify(raw), "utf8")).toBe(10485762);
    expectError(
      api,
      () => api.extractCardStatementDocument(input),
      "LIMIT_EXCEEDED",
    );
  });

  it("does not perform file, network or child-process IO while extracting text", () => {
    const api = loadApi();
    const fs: typeof import("node:fs") = require("node:fs");
    const http: typeof import("node:http") = require("node:http");
    const https: typeof import("node:https") = require("node:https");
    const childProcess: typeof import("node:child_process") = require("node:child_process");
    const denied = () => {
      throw new Error("QAX1: local text extraction must not perform IO");
    };
    const guards = [
      jest.spyOn(fs, "readFileSync").mockImplementation(denied),
      jest.spyOn(fs, "writeFileSync").mockImplementation(denied),
      jest.spyOn(fs, "openSync").mockImplementation(denied),
      jest.spyOn(fs.promises, "readFile").mockImplementation(denied),
      jest.spyOn(fs.promises, "writeFile").mockImplementation(denied),
      jest.spyOn(fs.promises, "open").mockImplementation(denied),
      jest.spyOn(http, "request").mockImplementation(denied),
      jest.spyOn(https, "request").mockImplementation(denied),
      jest.spyOn(globalThis, "fetch").mockImplementation(denied),
      jest.spyOn(childProcess, "spawn").mockImplementation(denied),
      jest.spyOn(childProcess, "execFile").mockImplementation(denied),
    ];
    const results: Document[] = [];
    let calls: number[] = [];
    try {
      for (const input of [
        csvInput(NUBANK),
        csvInput(ITAU, "CSV_ITAU"),
        ofxInput(OFX),
      ]) {
        results.push(api.extractCardStatementDocument(input));
      }
    } finally {
      calls = guards.map((guard) => guard.mock.calls.length);
      for (const guard of guards) guard.mockRestore();
    }
    expect(calls).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(results.map((result) => result.metrics.rows)).toEqual([5, 5, 6]);
    for (const result of results) expectClosedDocument(result);
  });
});

describe("QAX1 standalone unknown-result validation", () => {
  it("returns an exact independent deeply frozen copy, not frozen caller objects", () => {
    const api = loadApi();
    const input = validDocument();
    const result = api.validateDocumentExtraction(input);
    expect(result).toStrictEqual(input);
    expectClosedDocument(result);
    expect(result).not.toBe(input);
    expect(result.metrics).not.toBe(input.metrics);
    expect(result.occurrences).not.toBe(input.occurrences);
    expect(result.occurrences[0]).not.toBe(input.occurrences[0]);
    expect(result.occurrences[0].raw).not.toBe(input.occurrences[0].raw);
    expect(result.diagnostics[0]).not.toBe(input.diagnostics[0]);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.occurrences[0].raw)).toBe(false);
    input.occurrences[0].raw.description = "MUTATED CALLER";
    input.metrics.rows = 7;
    expect(result.occurrences[0].raw.description).toBe("CANDEIA");
    expect(result.metrics.rows).toBe(1);
    expect(Reflect.set(result.occurrences[0], "amountCents", 999)).toBe(false);
    expect(result.occurrences[0].amountCents).toBe(0);
  });

  it("accepts the complete empty document rather than requiring financial rows", () => {
    const api = loadApi();
    const value = validDocument();
    value.metrics.rows = 0;
    value.occurrences = [];
    value.diagnostics = [];
    const result = api.validateDocumentExtraction(value);
    expect(result).toStrictEqual(value);
    expectClosedDocument(result);
  });

  it.each(rawFields)(
    "preserves every allowed raw.%s representation",
    (field) => {
      const api = loadApi();
      for (const text of [null, "", " \t\r\n ", "x".repeat(1001), "e\u0301"]) {
        const value = unknownDocument();
        value.occurrences[0].raw[field] = text;
        const result = api.validateDocumentExtraction(value);
        expect(result).toStrictEqual(value);
        expectClosedDocument(result);
        expect(result.occurrences[0].raw[field]).toBe(text);
      }
    },
  );

  it.each(["ascii", "escaped-unicode", "aliased-raw"] as const)(
    "%s complete UTF-8 JSON envelope accepts N-1/N and rejects N+1",
    (variant) => {
      const api = loadApi();
      for (const size of [10485759, 10485760, 10485761]) {
        const value = sizedDocument(size, variant);
        expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(size);
        if (size > 10485760) {
          expectError(
            api,
            () => api.validateDocumentExtraction(value),
            "LIMIT_EXCEEDED",
          );
        } else {
          const result = api.validateDocumentExtraction(value);
          expect(result).toStrictEqual(value);
          expectClosedDocument(result);
          expect(jsonBytes(result)).toBe(size);
        }
      }
    },
  );

  it("counts all DTO overhead, not just raw, and does not use the draft 1 MiB cap", () => {
    const api = loadApi();
    const over = sizedDocument(10485761, "ascii");
    expect(jsonBytes(over.occurrences[0].raw)).toBeLessThan(10485760);
    expectError(
      api,
      () => api.validateDocumentExtraction(over),
      "LIMIT_EXCEEDED",
    );
    const legal = sizedDocument(1048577, "ascii");
    const result = api.validateDocumentExtraction(legal);
    expect(jsonBytes(result)).toBe(1048577);
    expect(result).toStrictEqual(legal);
  });

  it("rejects overflow before whole-object serialization, cloning or freezing", () => {
    const api = loadApi();
    const value = sizedDocument(10485761, "escaped-unicode");
    const stringify = JSON.stringify;
    const serialize = jest
      .spyOn(JSON, "stringify")
      .mockImplementation((item, replacer, space) => {
        if (item !== null && typeof item === "object") {
          throw new Error(
            "QAX1: overflow must precede whole-object serialization",
          );
        }
        return stringify(item, replacer, space);
      });
    const freeze = jest.spyOn(Object, "freeze");
    const clone = jest
      .spyOn(globalThis, "structuredClone")
      .mockImplementation(() => {
        throw new Error("QAX1: overflow must precede cloning");
      });
    let failure: unknown;
    let freezeCalls = 0;
    let cloneCalls = 0;
    let objectSerializations = 0;
    try {
      api.validateDocumentExtraction(value);
    } catch (error: unknown) {
      failure = error;
    } finally {
      freezeCalls = freeze.mock.calls.length;
      cloneCalls = clone.mock.calls.length;
      objectSerializations = serialize.mock.calls.filter(
        ([item]) => item !== null && typeof item === "object",
      ).length;
      serialize.mockRestore();
      freeze.mockRestore();
      clone.mockRestore();
    }
    expect(failure).toBeInstanceOf(api.DocumentExtractionError);
    expect(failure).toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(freezeCalls).toBe(0);
    expect(cloneCalls).toBe(0);
    expect(objectSerializations).toBe(0);
  });

  const invalidResults: Array<[string, (value: Document) => unknown]> = [
    ["null", () => null],
    ["array", () => []],
    ["version", (v) => ({ ...v, version: 2 })],
    ["kind", (v) => ({ ...v, documentKind: "CARD_INVOICE" })],
    ["extra financial decision", (v) => ({ ...v, decision: "CREATE" })],
    ["extra authority", (v) => ({ ...v, confirmed: true, tenantId: "other" })],
    ["metrics extra", (v) => ({ ...v, metrics: { ...v.metrics, rss: 1 } })],
    [
      "metrics fractional",
      (v) => ({ ...v, metrics: { ...v.metrics, rows: 0.5 } }),
    ],
    [
      "metrics missing row",
      (v) => ({ ...v, metrics: { ...v.metrics, rows: 0 } }),
    ],
    [
      "metrics negative",
      (v) => ({ ...v, metrics: { ...v.metrics, pages: -1 } }),
    ],
    ["metrics NaN", (v) => ({ ...v, metrics: { ...v.metrics, rows: NaN } })],
    [
      "metrics Infinity",
      (v) => ({ ...v, metrics: { ...v.metrics, rows: Infinity } }),
    ],
    [
      "occurrence extra",
      (v) => ({
        ...v,
        occurrences: [{ ...v.occurrences[0], canonicalExpenseId: "expense" }],
      }),
    ],
    [
      "invented externalId",
      (v) => ({
        ...v,
        occurrences: [{ ...v.occurrences[0], externalId: "invented" }],
      }),
    ],
    [
      "raw extra",
      (v) => ({
        ...v,
        occurrences: [
          {
            ...v.occurrences[0],
            raw: { ...v.occurrences[0].raw, corrected: true },
          },
        ],
      }),
    ],
    [
      "diagnostic extra",
      (v) => ({
        ...v,
        diagnostics: [{ ...v.diagnostics[0], decision: "CREATE" }],
      }),
    ],
    [
      "diagnostic code",
      (v) => ({ ...v, diagnostics: [{ reference: null, code: "OK" }] }),
    ],
    [
      "duplicate reference",
      (v) => ({
        ...v,
        metrics: { ...v.metrics, rows: 2 },
        occurrences: [
          v.occurrences[0],
          { ...v.occurrences[0], sourceOrdinal: 1 },
        ],
      }),
    ],
    [
      "source order",
      (v) => ({
        ...v,
        metrics: { ...v.metrics, rows: 2 },
        occurrences: [
          { ...v.occurrences[0], sourceOrdinal: 1, reference: "csv:record:3" },
          v.occurrences[0],
        ],
      }),
    ],
  ];
  it.each(invalidResults)("rejects invalid result %s", (_label, corrupt) => {
    const api = loadApi();
    expectError(
      api,
      () => api.validateDocumentExtraction(corrupt(validDocument())),
      "INVALID_RESULT",
    );
  });

  it.each([
    ["amountCents", NaN],
    ["amountCents", Infinity],
    ["amountCents", 0.5],
    ["amountCents", 2147483648],
    ["amountCents", -2147483648],
    ["sourceOrdinal", -1],
    ["sourceOrdinal", 0.5],
    ["identityOrdinal", -1],
    ["identityOrdinal", Number.MAX_SAFE_INTEGER + 1],
    ["installmentIndex", 0],
    ["installmentCount", 0],
    ["dateOnly", "2025-02-29"],
    ["dateOnly", "1900-02-29"],
    ["dateOnly", "1899-12-31"],
    ["dateOnly", "2200-01-01"],
    ["dateOnly", "2025-01-02T00:00:00Z"],
    ["merchant", "x".repeat(161)],
    ["reference", "x".repeat(193)],
    ["section", "PAID"],
    ["amountMeaning", "CREATE_EXPENSE"],
  ])("rejects invalid occurrence %s=%s", (field, replacement) => {
    const api = loadApi();
    const value = validDocument();
    Reflect.set(value.occurrences[0], field, replacement);
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "INVALID_RESULT",
    );
  });

  it.each([
    "dateOnly",
    "merchant",
    "amountCents",
    "installmentCount",
    "installmentIndex",
    "fitId",
    "identityOrdinal",
    "cycle",
  ])("requires explicit nullable occurrence key %s", (key) => {
    const api = loadApi();
    const value = unknownDocument();
    Reflect.deleteProperty(value.occurrences[0], key);
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "INVALID_RESULT",
    );
  });

  it.each(rawFields)("requires explicit raw key %s", (key) => {
    const api = loadApi();
    const value = unknownDocument();
    Reflect.deleteProperty(value.occurrences[0].raw, key);
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "INVALID_RESULT",
    );
  });

  it("requires explicit invoiceDueMonth null", () => {
    const api = loadApi();
    const value = validDocument();
    Reflect.deleteProperty(value, "invoiceDueMonth");
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "INVALID_RESULT",
    );
  });

  it.each([
    ["minimum", "1900-01-01", -2147483647],
    ["maximum", "2199-12-31", 2147483647],
    ["Gregorian leap", "2000-02-29", 0],
  ] as const)(
    "accepts factual calendar/cents boundary %s",
    (_label, date, cents) => {
      const api = loadApi();
      const value = validDocument();
      value.occurrences[0].dateOnly = date;
      value.occurrences[0].amountCents = cents;
      const result = api.validateDocumentExtraction(value);
      expect(result).toStrictEqual(value);
      expectClosedDocument(result);
    },
  );

  it("does not trust caller metrics to hide more than 1000 occurrences", () => {
    const api = loadApi();
    const value = unknownDocument();
    value.occurrences = Array.from({ length: 1001 }, (_, index) => ({
      ...value.occurrences[0],
      sourceOrdinal: index,
      reference: `csv:record:${index + 2}`,
    }));
    value.metrics.rows = 1001;
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "LIMIT_EXCEEDED",
    );
    value.metrics.rows = 1;
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "INVALID_RESULT",
    );
  });

  it.each([
    "root",
    "metrics",
    "occurrence",
    "raw",
    "diagnostic",
    "array",
  ] as const)("rejects %s accessors without invoking them", (location) => {
    const api = loadApi();
    const value = validDocument();
    const getter = jest.fn(() => {
      throw new Error("QAX1 getter must not execute");
    });
    const [target, key] =
      location === "root"
        ? [value, "version"]
        : location === "metrics"
          ? [value.metrics, "rows"]
          : location === "occurrence"
            ? [value.occurrences[0], "merchant"]
            : location === "raw"
              ? [value.occurrences[0].raw, "amount"]
              : location === "diagnostic"
                ? [value.diagnostics[0], "code"]
                : [value.occurrences, "0"];
    Object.defineProperty(target, key, { enumerable: true, get: getter });
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "INVALID_RESULT",
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["root", "raw", "array"] as const)(
    "rejects %s toJSON without invoking it",
    (location) => {
      const api = loadApi();
      const value = validDocument();
      const callback = jest.fn(() => validDocument());
      const target =
        location === "root"
          ? value
          : location === "raw"
            ? value.occurrences[0].raw
            : value.occurrences;
      Object.defineProperty(target, "toJSON", {
        value: callback,
        enumerable: false,
      });
      expectError(
        api,
        () => api.validateDocumentExtraction(value),
        "INVALID_RESULT",
      );
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["undefined", undefined],
    ["bigint", BigInt(1)],
    ["Date", new Date("2025-01-02T00:00:00Z")],
    ["Map", new Map()],
    ["function", () => "not JSON"],
    ["symbol", Symbol("not JSON")],
  ])("rejects non-JSON raw data: %s", (_label, badValue) => {
    const api = loadApi();
    const value = unknownDocument();
    Reflect.set(value.occurrences[0].raw, "description", badValue);
    expectError(
      api,
      () => api.validateDocumentExtraction(value),
      "INVALID_RESULT",
    );
  });

  it("rejects cycles and sparse arrays as invalid, not an empty success", () => {
    const api = loadApi();
    const cyclic = unknownDocument();
    Reflect.set(cyclic.occurrences[0].raw, "description", cyclic);
    expectError(
      api,
      () => api.validateDocumentExtraction(cyclic),
      "INVALID_RESULT",
    );
    const sparse = validDocument();
    Reflect.deleteProperty(sparse.occurrences, "0");
    expectError(
      api,
      () => api.validateDocumentExtraction(sparse),
      "INVALID_RESULT",
    );
  });
});

describe("QAX1 real legacy controls — frozen complete 9946 goldens", () => {
  it.each(csvCases)(
    "%s legacy API remains byte-functional",
    (profile, text) => {
      const result = parseCsv(text, {
        cardId: "qax1-card-fixture",
        source: profile,
      });
      expect(result).toStrictEqual({
        source: profile,
        transactions: [
          {
            externalId: "a4c0248244ccf20e530c6515c0a6d88d",
            date: new Date("2025-09-14T00:00:00.000Z"),
            merchant: "ATELIER LUA",
            amountCents: 4567,
            rawCategory: undefined,
            installmentCurrent: 2,
            installmentTotal: 3,
          },
          {
            externalId: "df772f5d41d4b0cf283be74ce5c8e3d7",
            date: new Date("2025-09-14T00:00:00.000Z"),
            merchant: "ATELIER LUA",
            amountCents: 4567,
            rawCategory: undefined,
            installmentCurrent: 2,
            installmentTotal: 3,
          },
          {
            externalId: "094abf626f5cfe651b35e29bcf502113",
            date: new Date("2025-01-02T00:00:00.000Z"),
            merchant: "AJUSTE",
            amountCents: -1234,
            rawCategory: undefined,
            installmentCurrent: undefined,
            installmentTotal: undefined,
          },
        ],
        totalAmountCents: 7900,
        periodLabel: "2025-09",
      });
    },
  );

  it("OFX legacy API retains FITIDs, duplicate hashes, signs, order and totals", () => {
    expect(parseOfx(OFX, "qax1-card-fixture")).toStrictEqual({
      source: "OFX",
      transactions: [
        {
          externalId: "822a0ddbe85fdb45a5131d90689b41a2",
          date: new Date("2025-09-14T00:00:00.000Z"),
          merchant: "ORBITA",
          amountCents: 4567,
          installmentCurrent: 2,
          installmentTotal: 3,
          fitId: "QA-FIT-7",
        },
        {
          externalId: "55d232d98e330d69ac066b49de440b69",
          date: new Date("2025-09-15T00:00:00.000Z"),
          merchant: "GEMEA",
          amountCents: 890,
          installmentCurrent: undefined,
          installmentTotal: undefined,
          fitId: undefined,
        },
        {
          externalId: "55d232d98e330d69ac066b49de440b69",
          date: new Date("2025-09-15T00:00:00.000Z"),
          merchant: "GEMEA",
          amountCents: 890,
          installmentCurrent: undefined,
          installmentTotal: undefined,
          fitId: undefined,
        },
        {
          externalId: "822a0ddbe85fdb45a5131d90689b41a2",
          date: new Date("2025-09-14T00:00:00.000Z"),
          merchant: "ORBITA",
          amountCents: 4567,
          installmentCurrent: 2,
          installmentTotal: 3,
          fitId: "QA-FIT-7",
        },
        {
          externalId: "bc65712d57291c58d72a9c2ba8d6606f",
          date: new Date("2025-01-02T00:00:00.000Z"),
          merchant: "CREDITO",
          amountCents: -1234,
          installmentCurrent: undefined,
          installmentTotal: undefined,
          fitId: undefined,
        },
      ],
      totalAmountCents: 9680,
      periodLabel: "2025-09",
    });
  });
});
