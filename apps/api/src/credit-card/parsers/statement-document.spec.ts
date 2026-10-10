import { parseCsv } from "./csv";
import { parseOfx } from "./ofx";
import {
  DocumentExtractionError,
  extractCardStatementDocument,
  validateDocumentExtraction,
} from "./statement-document";

const csv = (
  content: string,
  profile: "CSV_NUBANK" | "CSV_ITAU" = "CSV_NUBANK",
) =>
  extractCardStatementDocument({
    version: 1,
    context: "CARD_INVOICE",
    format: "CSV",
    profile,
    bytes: Buffer.from(content),
  });
const ofx = (content: string) =>
  extractCardStatementDocument({
    version: 1,
    context: "CARD_INVOICE",
    format: "OFX",
    profile: "OFX_CARD",
    bytes: Buffer.from(content),
  });
const statement = (blocks: string[]) =>
  "<OFX><CREDITCARDMSGSRSV1><CCSTMTRS>" +
  blocks.map((x) => `<STMTTRN>${x}</STMTTRN>`).join("\n") +
  "</CCSTMTRS></CREDITCARDMSGSRSV1></OFX>";
const validDto = () => ({
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
        date: null as string | null,
        description: null as string | null,
        amount: null as string | null,
        installment: null as string | null,
      },
      cycle: null,
      dateOnly: null,
      merchant: null,
      amountCents: null,
      amountMeaning: "UNKNOWN",
      installmentCount: null,
      installmentIndex: null,
      fitId: null,
      identityOrdinal: null,
    },
  ],
  diagnostics: [] as { reference: string | null; code: string }[],
});
function fails(work: () => unknown, code: string): void {
  expect(work).toThrow(DocumentExtractionError);
  try {
    work();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("X1-L1 inactive local statement document", () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date("2026-10-08T03:00:00Z")),
  );
  afterEach(() => jest.useRealTimers());

  it("extracts_complete_csv_document_contract_before_legacy_filters", () => {
    const result = csv(
      "date,title,amount\n2025-06-22,LOJA TESTE PARC 2/3,100.00\n,LOJA SEM DATA,abc\n2025-06-22,LOJA TESTE PARC 2/3,100.00\n",
    );
    expect(result).toEqual({
      version: 1,
      parserVersion: "card-local-text-v1",
      documentKind: "UNKNOWN",
      invoiceDueMonth: null,
      metrics: {
        pages: 0,
        rows: 3,
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
            date: "2025-06-22",
            description: "LOJA TESTE PARC 2/3",
            amount: "100.00",
            installment: "PARC 2/3",
          },
          cycle: null,
          dateOnly: "2025-06-22",
          merchant: "LOJA TESTE",
          amountCents: 10000,
          amountMeaning: "INSTALLMENT_CHARGE",
          installmentCount: 3,
          installmentIndex: 2,
          fitId: null,
          identityOrdinal: 0,
        },
        {
          reference: "csv:record:3",
          sourceOrdinal: 1,
          section: "UNKNOWN",
          raw: {
            date: "",
            description: "LOJA SEM DATA",
            amount: "abc",
            installment: null,
          },
          cycle: null,
          dateOnly: null,
          merchant: "LOJA SEM DATA",
          amountCents: null,
          amountMeaning: "UNKNOWN",
          installmentCount: null,
          installmentIndex: null,
          fitId: null,
          identityOrdinal: null,
        },
        {
          reference: "csv:record:4",
          sourceOrdinal: 2,
          section: "UNKNOWN",
          raw: {
            date: "2025-06-22",
            description: "LOJA TESTE PARC 2/3",
            amount: "100.00",
            installment: "PARC 2/3",
          },
          cycle: null,
          dateOnly: "2025-06-22",
          merchant: "LOJA TESTE",
          amountCents: 10000,
          amountMeaning: "INSTALLMENT_CHARGE",
          installmentCount: 3,
          installmentIndex: 2,
          fitId: null,
          identityOrdinal: 1,
        },
      ],
      diagnostics: [
        { reference: "csv:record:3", code: "UNKNOWN_DATE" },
        { reference: "csv:record:3", code: "UNREADABLE_ROW" },
        { reference: "csv:record:3", code: "UNKNOWN_AMOUNT_MEANING" },
      ],
    });
  });

  it("ofx_preserves_fitid_absence_twins_and_original_order", () => {
    const result = ofx(
      statement([
        "<DTPOSTED>20250622<TRNAMT>-100.00<FITID> fit-1 <MEMO>LOJA PARC 2/3",
        "<DTPOSTED>20250622<TRNAMT>-100.00<MEMO>LOJA PARC 2/3",
        "<MEMO>INCOMPLETA",
        "<DTPOSTED>20250622<TRNAMT>-100.00<MEMO>LOJA PARC 2/3",
        "<DTPOSTED>20250623<TRNAMT>12.34<NAME>ESTORNO",
      ]),
    );
    expect(result.documentKind).toBe("INVOICE");
    expect(result.occurrences.map((x) => x.reference)).toEqual([
      "ofx:stmttrn:1",
      "ofx:stmttrn:2",
      "ofx:stmttrn:3",
      "ofx:stmttrn:4",
      "ofx:stmttrn:5",
    ]);
    expect(result.occurrences.map((x) => x.identityOrdinal)).toEqual([
      0,
      1,
      null,
      2,
      0,
    ]);
    expect(result.occurrences.map((x) => x.amountCents)).toEqual([
      10000,
      10000,
      null,
      10000,
      -1234,
    ]);
    expect(result.occurrences.map((x) => x.fitId)).toEqual([
      "fit-1",
      null,
      null,
      null,
      null,
    ]);
    expect(
      result.occurrences.every((x) => !("externalId" in x) && x.cycle === null),
    ).toBe(true);
    expect(result.invoiceDueMonth).toBeNull();
  });

  it("money_requires_whole_token_and_preserves_zero_negative", () => {
    const result = csv(
      "date,title,amount\n2025-06-22,A,100abc\n2025-06-22,A,\n2025-06-22,A,0.00\n2025-06-22,A,-12.34\n",
    );
    expect(result.occurrences.map((x) => x.amountCents)).toEqual([
      null,
      null,
      0,
      -1234,
    ]);
    expect(result.occurrences.every((x) => x.amountMeaning === "UNKNOWN")).toBe(
      true,
    );
    expect(
      csv("data;descricao;valor\n22/06/2025;A;R$ 1.234,56", "CSV_ITAU")
        .occurrences[0].amountCents,
    ).toBe(123456);
  });

  it.each(["2026-10-08T01:00:00Z", "2027-01-01T01:00:00Z"])(
    "invalid_or_missing_date_never_reads_current_year at %s",
    (now) => {
      jest.setSystemTime(new Date(now));
      const result = csv(
        "data;descricao;valor\n31/02/2026;A;1\n;A;1\n22/06;A;1\n22/06/2025;A;1\n29/02/2024;A;1\n29/02/2025;A;1",
        "CSV_ITAU",
      );
      expect(result.occurrences.map((x) => x.dateOnly)).toEqual([
        null,
        null,
        null,
        "2025-06-22",
        "2024-02-29",
        null,
      ]);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          { reference: "csv:record:2", code: "INVALID_CALENDAR_DATE" },
          { reference: "csv:record:3", code: "UNKNOWN_DATE" },
          { reference: "csv:record:4", code: "UNKNOWN_DATE" },
        ]),
      );
      expect(
        ofx(statement(["<DTPOSTED>20250231<TRNAMT>-1<NAME>A"])).occurrences[0]
          .dateOnly,
      ).toBeNull();
    },
  );

  it("keeps installment facts above the creation limit without multiplying", () => {
    const row = csv("date,title,amount\n2025-06-22,LOJA PARC 25/60,100")
      .occurrences[0];
    expect(row).toMatchObject({
      amountCents: 10000,
      installmentCount: 60,
      installmentIndex: 25,
      amountMeaning: "INSTALLMENT_CHARGE",
    });
    expect(
      csv("date,title,amount\n2025-06-22,LOJA PARC 61/100,100").occurrences[0],
    ).toMatchObject({
      amountCents: 10000,
      installmentCount: 100,
      installmentIndex: 61,
      raw: { installment: "PARC 61/100" },
    });
  });

  it("preserves raw absence, emptiness, whitespace and decoded quoting", () => {
    const rows = csv(
      'date,title,amount\n 2025-06-22 ,"  Loja ""A""  ", 0.00 \n2025-06-23,,\n2025-06-24',
    ).occurrences;
    expect(rows.map((x) => x.raw)).toEqual([
      {
        date: " 2025-06-22 ",
        description: '  Loja "A"  ',
        amount: " 0.00 ",
        installment: null,
      },
      { date: "2025-06-23", description: "", amount: "", installment: null },
      {
        date: "2025-06-24",
        description: null,
        amount: null,
        installment: null,
      },
    ]);
    const raw = ofx(statement(["<DTPOSTED> 20250622 <TRNAMT> 0.00 <MEMO>   "]))
      .occurrences[0].raw;
    expect(raw).toEqual({
      date: " 20250622 ",
      description: "   ",
      amount: " 0.00 ",
      installment: null,
    });
  });

  it("keeps long raw text while refusing overlong normalized merchant", () => {
    const description = "A".repeat(1001);
    const result = csv(`date,title,amount\n2025-06-22,${description},1`);
    expect(result.occurrences[0]).toMatchObject({
      merchant: null,
      identityOrdinal: null,
      raw: { description },
    });
    expect(result.diagnostics).toContainEqual({
      reference: "csv:record:2",
      code: "OVERLONG_FIELD",
    });
  });

  it("unsupported_context_or_format_has_no_fallback", () => {
    const input = {
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes: Buffer.from("date,title,amount\n2025-06-22,A,1"),
    };
    for (const delta of [
      { context: "BANK" },
      { context: "RECEIPT" },
      ...["PDF", "XLSX", "PNG", "AUTO"].map((format) => ({ format })),
      { profile: "OFX_CARD" },
      { filename: "a.csv" },
      { version: 2 },
      { bytes: "text" },
      { bytes: new Uint8Array(3) },
    ]) {
      fails(
        () =>
          Reflect.apply(extractCardStatementDocument, null, [
            { ...input, ...delta },
          ]),
        "INVALID_INPUT",
      );
    }
    fails(
      () => ofx("<OFX><BANKMSGSRSV1><STMTRS></STMTRS></BANKMSGSRSV1></OFX>"),
      "UNSUPPORTED_DOCUMENT",
    );
    for (const content of [
      "a,b,c\n1,2,3",
      'date,title,amount\n2025-06-22,"multi\nline",1',
      "date,title,amount\n2025-06-22,A,1,extra",
    ]) {
      fails(() => csv(content), "UNSUPPORTED_DOCUMENT");
    }
  });

  it("enforces literal input and row boundaries", () => {
    fails(() => csv("x".repeat(10485761)), "LIMIT_EXCEEDED");
    const header = "date,title,amount\n";
    const row = "2025-06-22,A,1\n";
    expect(csv(header + row.repeat(1000)).metrics.rows).toBe(1000);
    fails(() => csv(header + row.repeat(1001)), "LIMIT_EXCEEDED");
    const dto = validDto();
    dto.occurrences[0].raw.description = "x".repeat(
      10485760 - Buffer.byteLength(header + "2025-06-22,,1"),
    );
    const acceptedInput =
      header + "2025-06-22," + dto.occurrences[0].raw.description + ",1";
    expect(Buffer.byteLength(acceptedInput)).toBe(10485760);
    fails(() => csv(acceptedInput), "LIMIT_EXCEEDED");
  });

  it("validates_exact_input_and_output_contracts", () => {
    const base = validDto();
    const row = base.occurrences[0];
    for (const bad of [
      { ...base, decision: "CREATE" },
      { ...base, version: 2 },
      { ...base, invoiceDueMonth: undefined },
      { ...base, metrics: { ...base.metrics, rows: 0 } },
      { ...base, metrics: { ...base.metrics, pages: 1 } },
      { ...base, occurrences: [{ ...row, canonicalExpenseId: "x" }] },
      {
        ...base,
        occurrences: [{ ...row, raw: { ...row.raw, confirmed: true } }],
      },
      {
        ...base,
        occurrences: [
          { ...row, raw: { date: null, description: null, amount: null } },
        ],
      },
      { ...base, occurrences: [{ ...row, amountCents: NaN }] },
      { ...base, occurrences: [{ ...row, amountCents: 1.5 }] },
      { ...base, occurrences: [{ ...row, amountCents: 2147483648 }] },
      { ...base, occurrences: [{ ...row, sourceOrdinal: 1 }] },
      { ...base, occurrences: [{ ...row, identityOrdinal: 0 }] },
      {
        ...base,
        occurrences: [
          { ...row, cycle: { invoiceDueMonth: "2025-13", reference: "r" } },
        ],
      },
      {
        ...base,
        occurrences: [
          {
            ...row,
            cycle: { invoiceDueMonth: "2025-06", reference: "r", extra: 1 },
          },
        ],
      },
      {
        ...base,
        diagnostics: [{ reference: "missing", code: "UNKNOWN_DATE" }],
      },
      {
        ...base,
        diagnostics: [{ reference: null, code: "UNREADABLE_ROW", extra: true }],
      },
      {
        ...base,
        metrics: { ...base.metrics, rows: 2 },
        occurrences: [row, { ...row, sourceOrdinal: 1 }],
      },
    ])
      fails(() => validateDocumentExtraction(bad), "INVALID_RESULT");
    const out = validateDocumentExtraction(base);
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
    expect(out.occurrences[0].raw).not.toBe(base.occurrences[0].raw);
    for (const object of [
      out,
      out.metrics,
      out.occurrences,
      out.occurrences[0],
      out.occurrences[0].raw,
      out.diagnostics,
    ])
      expect(Object.isFrozen(object)).toBe(true);
    base.occurrences[0].raw.description = "changed";
    expect(out.occurrences[0].raw.description).toBeNull();
  });

  it("rejects getters, toJSON, cycles, hidden extras and non-JSON structures without callbacks", () => {
    const callback = jest.fn(() => validDto());
    const getter = validDto();
    Object.defineProperty(getter, "metrics", {
      get: callback,
      enumerable: true,
    });
    const rowGetter = validDto();
    Object.defineProperty(rowGetter.occurrences[0].raw, "date", {
      get: callback,
      enumerable: true,
    });
    const arrayGetter = validDto();
    Object.defineProperty(arrayGetter.occurrences, "0", {
      get: callback,
      enumerable: true,
    });
    const symbol = Object.assign(validDto(), { [Symbol("extra")]: true });
    const hidden = Object.defineProperty(validDto(), "hidden", { value: 1 });
    const cyclic = validDto();
    Object.assign(cyclic.occurrences[0], { raw: cyclic });
    for (const invalid of [
      getter,
      rowGetter,
      arrayGetter,
      { ...validDto(), toJSON: callback },
      symbol,
      hidden,
      cyclic,
      new Date(),
      new Map(),
      null,
      [],
    ]) {
      fails(() => validateDocumentExtraction(invalid), "INVALID_RESULT");
    }
    const input = {
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      get bytes() {
        return callback();
      },
    };
    fails(
      () => Reflect.apply(extractCardStatementDocument, null, [input]),
      "INVALID_INPUT",
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    "plain",
    "á😀",
    '"\\\n\u0000',
    "\ud800",
    "x".repeat(4095) + "😀\u2028",
  ])(
    "measures the complete compact UTF-8 envelope at N-1/N/N+1 (case %#)",
    (prefix) => {
      for (const target of [10485759, 10485760, 10485761]) {
        const value = validDto();
        value.occurrences[0].raw.description = prefix;
        const size = Buffer.byteLength(JSON.stringify(value), "utf8");
        value.occurrences[0].raw.description += "x".repeat(target - size);
        expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(target);
        if (target > 10485760)
          fails(() => validateDocumentExtraction(value), "LIMIT_EXCEEDED");
        else expect(validateDocumentExtraction(value)).toEqual(value);
      }
    },
  );

  it("preserves all raw fields and counts each alias appearance", () => {
    for (const raw of [null, "", " \t ", "x".repeat(1001)]) {
      const value = validDto();
      value.occurrences[0].raw = {
        date: raw,
        description: raw,
        amount: raw,
        installment: raw,
      };
      expect(validateDocumentExtraction(value).occurrences[0].raw).toEqual(
        value.occurrences[0].raw,
      );
    }
    const value = validDto();
    value.occurrences[0].raw.description = "x".repeat(5300000);
    value.metrics.rows = 2;
    value.occurrences.push({
      ...value.occurrences[0],
      reference: "csv:record:3",
      sourceOrdinal: 1,
    });
    expect(value.occurrences[0].raw).toBe(value.occurrences[1].raw);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(10485760);
    fails(() => validateDocumentExtraction(value), "LIMIT_EXCEEDED");
  });

  it("invalid shape takes precedence over a large valid raw string", () => {
    const value = validDto();
    value.occurrences[0].raw.description = "x".repeat(10485761);
    fails(
      () => validateDocumentExtraction({ ...value, confirmed: true }),
      "INVALID_RESULT",
    );
  });

  it("validates and deep-freezes explicit cycle objects without inventing one during extraction", () => {
    const value = validDto();
    const candidate = {
      ...value,
      occurrences: [
        {
          ...value.occurrences[0],
          cycle: { invoiceDueMonth: "2025-06", reference: "printed-cycle" },
        },
      ],
    };
    const result = validateDocumentExtraction(candidate);
    expect(result.occurrences[0].cycle).toEqual({
      invoiceDueMonth: "2025-06",
      reference: "printed-cycle",
    });
    expect(Object.isFrozen(result.occurrences[0].cycle)).toBe(true);
    candidate.occurrences[0].cycle.reference = "changed";
    expect(result.occurrences[0].cycle?.reference).toBe("printed-cycle");
  });

  it("keeps physical CSV locators and rejects malformed OFX and non-text bytes", () => {
    const result = csv("date,title,amount\n2025-06-22,A,1\n\n2025-06-22,A,1\n");
    expect(
      result.occurrences.map((x) => [
        x.reference,
        x.sourceOrdinal,
        x.identityOrdinal,
      ]),
    ).toEqual([
      ["csv:record:2", 0, 0],
      ["csv:record:3", 1, null],
      ["csv:record:4", 2, 1],
    ]);
    for (const text of [
      "not ofx",
      "<OFX><STMTTRN><TRNAMT>-1</OFX>",
      "<OFX><STMTTRN><STMTTRN></STMTTRN></OFX>",
    ]) {
      fails(() => ofx(text), "UNSUPPORTED_DOCUMENT");
    }
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from("date,title,amount\n2025-06-22,A\u0000,1"),
    ]) {
      fails(
        () =>
          extractCardStatementDocument({
            version: 1,
            context: "CARD_INVOICE",
            format: "CSV",
            profile: "CSV_NUBANK",
            bytes,
          }),
        "UNSUPPORTED_DOCUMENT",
      );
    }
  });

  it("legacy_entrypoints_keep_frozen_9946_results", () => {
    const cardId = "x1-golden-card";
    const nubank = [
      "date,title,amount,category",
      "2025-06-22,LOJA TESTE PARC 2/3,100.00,Compras",
      ",SEM DATA,abc,",
      "2025-06-22,LOJA TESTE PARC 2/3,100.00,Compras",
      "2025-06-23,ESTORNO,-12.34,Ajuste",
      "2025-06-24,ZERO,0.00,",
      "2026-02-31,ROLLOVER,7.00,",
      "2025-06-25,PARCIAL,100abc,",
      "2025-06-26,SEM VALOR,,",
      '2025-06-27,"LOJA ""A"", B",10.01,',
    ].join("\n");
    const itau = [
      "\uFEFFdata;descricao;valor",
      "22/06/2025;LOJA PARC. 25/60;R$ 1.234,56",
      "23/06/25;CREDITO;-12,34",
      "24/06/2025; ;1,00",
    ].join("\r\n");
    const ofxText = statement([
      "<DTPOSTED>20250622<TRNAMT>-100.00<FITID> fit-1 <MEMO>LOJA PARC 2/3",
      "<DTPOSTED>20250622<TRNAMT>-100.00<MEMO>LOJA PARC 2/3",
      "<DTPOSTED>20250622<TRNAMT>-100.00<MEMO>LOJA PARC 2/3",
      "<DTPOSTED>20250623<TRNAMT>12.34<NAME>ESTORNO",
      "<DTPOSTED>20250231<TRNAMT>-7<NAME>ROLLOVER",
      "<TRNAMT>-1<NAME>SEM DATA",
      "<DTPOSTED>20250624<TRNAMT>0<NAME>ZERO",
      "<DTPOSTED>20250625<NAME>SEM VALOR",
    ]);
    const actual = {
      nubank: parseCsv(nubank, { cardId, source: "CSV_NUBANK" }),
      itau: parseCsv(itau, { cardId, source: "CSV_ITAU" }),
      generic: parseCsv("2025-01-01,GENERICA,1.11\n2025-01-01,GENERICA,1.11", {
        cardId,
        source: "CSV_GENERIC",
      }),
      empty: parseCsv("", { cardId, source: "CSV_GENERIC" }),
      ofx: parseOfx(ofxText, cardId),
      ofxEmpty: parseOfx("", cardId),
    };
    // Full JSON captured from immutable 9946, before edits, under UTC and BRT.
    expect(JSON.parse(JSON.stringify(actual))).toEqual({
      nubank: {
        source: "CSV_NUBANK",
        transactions: [
          {
            externalId: "80b101c67fa9c5edec963a2c83275ca6",
            date: "2025-06-22T00:00:00.000Z",
            merchant: "LOJA TESTE",
            amountCents: 10000,
            rawCategory: "Compras",
            installmentCurrent: 2,
            installmentTotal: 3,
          },
          {
            externalId: "b9df2d89c831fcfcc96654c3512d4639",
            date: "2025-06-22T00:00:00.000Z",
            merchant: "LOJA TESTE",
            amountCents: 10000,
            rawCategory: "Compras",
            installmentCurrent: 2,
            installmentTotal: 3,
          },
          {
            externalId: "cfb8b3daa2a5296e63b1274c8a2ea118",
            date: "2025-06-23T00:00:00.000Z",
            merchant: "ESTORNO",
            amountCents: -1234,
            rawCategory: "Ajuste",
          },
          {
            externalId: "0929009272efdacad3159f173a9d0763",
            date: "2026-03-03T00:00:00.000Z",
            merchant: "ROLLOVER",
            amountCents: 700,
          },
          {
            externalId: "335e778a52359f8baa8d6e5012e83101",
            date: "2025-06-25T00:00:00.000Z",
            merchant: "PARCIAL",
            amountCents: 10000,
          },
          {
            externalId: "89dbc09fd42eb9594fef3ed65e16765a",
            date: "2025-06-27T00:00:00.000Z",
            merchant: 'LOJA "A", B',
            amountCents: 1001,
          },
        ],
        totalAmountCents: 30467,
        periodLabel: "2025-06",
      },
      itau: {
        source: "CSV_ITAU",
        transactions: [
          {
            externalId: "926dc67b2080c955adaa814588fd65e2",
            date: "2025-06-22T00:00:00.000Z",
            merchant: "LOJA",
            amountCents: 123456,
            installmentCurrent: 25,
            installmentTotal: 60,
          },
          {
            externalId: "0e539c0991ecdb227b5485806be4fde4",
            date: "2025-06-23T00:00:00.000Z",
            merchant: "CREDITO",
            amountCents: -1234,
          },
          {
            externalId: "5b6ae2c0b7c4e01a99e0aee443d2018f",
            date: "2025-06-24T00:00:00.000Z",
            merchant: "Lançamento",
            amountCents: 100,
          },
        ],
        totalAmountCents: 122322,
        periodLabel: "2025-06",
      },
      generic: {
        source: "CSV_GENERIC",
        transactions: [
          {
            externalId: "54e5d46f887f2d7321986d88b70c3f89",
            date: "2025-01-01T00:00:00.000Z",
            merchant: "GENERICA",
            amountCents: 111,
          },
          {
            externalId: "6e4e0a6c2e6a0501743c4fd154aaf9d9",
            date: "2025-01-01T00:00:00.000Z",
            merchant: "GENERICA",
            amountCents: 111,
          },
        ],
        totalAmountCents: 222,
        periodLabel: "2025-01",
      },
      empty: { source: "CSV_GENERIC", transactions: [], totalAmountCents: 0 },
      ofx: {
        source: "OFX",
        transactions: [
          {
            externalId: "9974a510dac7c49c7336c0c98e5e6144",
            date: "2025-06-22T00:00:00.000Z",
            merchant: "LOJA",
            amountCents: 10000,
            installmentCurrent: 2,
            installmentTotal: 3,
            fitId: "fit-1",
          },
          {
            externalId: "1d28b3b4dba0247a8cc7a03e771e055a",
            date: "2025-06-22T00:00:00.000Z",
            merchant: "LOJA",
            amountCents: 10000,
            installmentCurrent: 2,
            installmentTotal: 3,
          },
          {
            externalId: "1d28b3b4dba0247a8cc7a03e771e055a",
            date: "2025-06-22T00:00:00.000Z",
            merchant: "LOJA",
            amountCents: 10000,
            installmentCurrent: 2,
            installmentTotal: 3,
          },
          {
            externalId: "cfb8b3daa2a5296e63b1274c8a2ea118",
            date: "2025-06-23T00:00:00.000Z",
            merchant: "ESTORNO",
            amountCents: -1234,
          },
          {
            externalId: "4ecf4023d68b7558ed6cf024d9df3e0b",
            date: "2025-03-03T00:00:00.000Z",
            merchant: "ROLLOVER",
            amountCents: 700,
          },
        ],
        totalAmountCents: 29466,
        periodLabel: "2025-06",
      },
      ofxEmpty: { source: "OFX", transactions: [], totalAmountCents: 0 },
    });
  });
});
