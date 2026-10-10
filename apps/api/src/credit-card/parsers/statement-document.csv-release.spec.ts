import {
  DocumentExtractionError,
  extractCardStatementDocument,
} from "./statement-document";

const csv = (
  text: string | Buffer,
  profile: "CSV_NUBANK" | "CSV_ITAU" = "CSV_NUBANK",
) =>
  extractCardStatementDocument({
    version: 1,
    context: "CARD_INVOICE",
    format: "CSV",
    profile,
    bytes: Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8"),
  });

const errorCode = (work: () => unknown): string | null => {
  try {
    work();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentExtractionError);
    return (error as DocumentExtractionError).code;
  }
};

describe("strict real-byte CSV release parser", () => {
  it.each([
    {
      label: "UTF-8 BOM plus comma",
      profile: "CSV_NUBANK" as const,
      bytes: Buffer.from(
        "\uFEFFdate,title,amount\n2026-10-05,MERCADO,100.01\n",
      ),
      title: "MERCADO",
      cents: 10_001,
    },
    {
      label: "semicolon",
      profile: "CSV_ITAU" as const,
      bytes: Buffer.from(
        "data;descricao;valor\n05/10/2026;MERCADO;R$ 100,01\n",
      ),
      title: "MERCADO",
      cents: 10_001,
    },
    {
      label: "quoted delimiter",
      profile: "CSV_NUBANK" as const,
      bytes: Buffer.from(
        'date,title,amount\n2026-10-05,"MERCADO, BAIRRO",100.01\n',
      ),
      title: "MERCADO, BAIRRO",
      cents: 10_001,
    },
  ])(
    "accepts_UTF8_BOM_and_exactly_one_comma_or_semicolon_profile: $label",
    ({ profile, bytes, title, cents }) => {
      const result = csv(bytes, profile);
      expect(result.parserVersion).toBe("card-local-text-v1");
      expect(result.metrics.rows).toBe(1);
      expect(result.occurrences).toEqual([
        expect.objectContaining({
          reference: "csv:record:2",
          sourceOrdinal: 0,
          merchant: title,
          dateOnly: "2026-10-05",
          amountCents: cents,
        }),
      ]);
    },
  );

  it("keeps_two_equal_records_as_two_distinct_occurrences", () => {
    const row = "2026-10-05,MERCADO,100.01";
    const result = csv(`date,title,amount\n${row}\n${row}\n`);

    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences.map((item) => item.reference)).toEqual([
      "csv:record:2",
      "csv:record:3",
    ]);
    expect(result.occurrences.map((item) => item.sourceOrdinal)).toEqual([
      0, 1,
    ]);
    expect(result.occurrences[0]).toMatchObject({
      merchant: result.occurrences[1]?.merchant,
      amountCents: result.occurrences[1]?.amountCents,
      dateOnly: result.occurrences[1]?.dateOnly,
    });
  });

  it("keeps_semantically_uncertain_but_framed_rows_visible", () => {
    const result = csv("date,title,amount\nnot-a-date,LINHA INCERTA,abc\n");

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({
      reference: "csv:record:2",
      raw: {
        date: "not-a-date",
        description: "LINHA INCERTA",
        amount: "abc",
      },
      dateOnly: null,
      merchant: "LINHA INCERTA",
      amountCents: null,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reference: "csv:record:2" }),
      ]),
    );
  });

  it.each([
    ["empty document", Buffer.alloc(0), "CSV_NUBANK", "UNSUPPORTED_DOCUMENT"],
    [
      "headers only",
      Buffer.from("date,title,amount\n"),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "invalid UTF-8",
      Buffer.from([0x64, 0x61, 0x74, 0x65, 0x0a, 0xff]),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "NUL",
      Buffer.from("date,title,amount\n2026-10-05,A,\0\n"),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "PDF magic",
      Buffer.from("%PDF-1.7\ndate,title,amount\n"),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "ZIP magic",
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from("date,title,amount\n"),
      ]),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "OLE magic",
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.from("date,title,amount\n"),
      ]),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "HTML",
      Buffer.from("<html>date,title,amount\n2026-10-05,A,1.00</html>\n"),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "XML",
      Buffer.from(
        '<?xml version="1.0"?><x>date,title,amount\n2026-10-05,A,1.00</x>',
      ),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "SVG script polyglot",
      Buffer.from(
        "<svg><script>alert(1)</script></svg>\ndate,title,amount\n2026-10-05,A,1.00\n",
      ),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "conflicting delimiters",
      Buffer.from(
        "date,title,amount;data;descricao;valor\n2026-10-05,A,1.00;05/10/2026;B;1,00\n",
      ),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "unclosed quote",
      Buffer.from('date,title,amount\n2026-10-05,"A,1.00\n'),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "inconsistent columns",
      Buffer.from("date,title,amount\n2026-10-05,A,1.00,EXTRA\n"),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "duplicate required header",
      Buffer.from("date,date,title,amount\n2026-10-05,2026-10-05,A,1.00\n"),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "missing required header",
      Buffer.from("date,title,other\n2026-10-05,A,1.00\n"),
      "CSV_NUBANK",
      "UNSUPPORTED_DOCUMENT",
    ],
    [
      "65 columns",
      Buffer.from(
        `${["date", "title", "amount", ...Array.from({ length: 62 }, (_, i) => `x${i}`)].join(",")}\n` +
          `${["2026-10-05", "A", "1.00", ...Array(62).fill("x")].join(",")}\n`,
      ),
      "CSV_NUBANK",
      "LIMIT_EXCEEDED",
    ],
    [
      "field over 1,000 UTF-8 bytes",
      Buffer.from(`date,title,amount\n2026-10-05,${"á".repeat(501)},1.00\n`),
      "CSV_NUBANK",
      "LIMIT_EXCEEDED",
    ],
  ])(
    "rejects_unsupported_or_ambiguous_content_before_extraction: %s",
    (_label, bytes, profile, expected) => {
      expect(
        errorCode(() =>
          csv(bytes as Buffer, profile as "CSV_NUBANK" | "CSV_ITAU"),
        ),
      ).toBe(expected);
    },
  );

  it.each([1, 1_000])(
    "enforces_row_boundaries_at_1000_and_1001: accepts %i",
    (rows) => {
      const body = Array.from(
        { length: rows },
        (_, index) => `2026-10-05,COMPRA ${index},1.00`,
      ).join("\n");
      expect(csv(`date,title,amount\n${body}\n`).occurrences).toHaveLength(
        rows,
      );
    },
  );

  it("enforces_row_boundaries_at_1000_and_1001: rejects 1001", () => {
    const body = Array.from(
      { length: 1_001 },
      (_, index) => `2026-10-05,COMPRA ${index},1.00`,
    ).join("\n");
    expect(errorCode(() => csv(`date,title,amount\n${body}\n`))).toBe(
      "LIMIT_EXCEEDED",
    );
  });
});
