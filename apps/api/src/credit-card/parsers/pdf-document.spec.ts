import { extractPdfDocument } from "./pdf-document";

function pdf(
  lines: readonly string[],
  image = false,
  pages = 1,
  mode:
    | "normal"
    | "nested"
    | "inline"
    | "corrupt"
    | "corrupt-inline" = "normal",
): Buffer {
  const body =
    lines
      .map(
        (line, index) =>
          `BT /F1 12 Tf 50 ${750 - index * 20} Td (${line}) Tj ET`,
      )
      .join("\n") +
    (image
      ? mode === "inline" || mode === "corrupt-inline"
        ? `\nq 120 0 0 120 50 500 cm BI ${mode === "inline" ? "/W 1 /H 1" : ""} /CS /G /BPC 8 ID X EI Q`
        : "\nq 120 0 0 120 50 500 cm /Im1 Do Q"
      : "");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${6 + i} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
    mode === "nested"
      ? "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Nested 36 0 R >> >> /Length 10 >>\nstream\n/Nested Do\nendstream"
      : `<< /Type /XObject /Subtype /Image ${mode === "corrupt" ? "" : "/Width 1 /Height 1"} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream`,
    ...Array.from(
      { length: pages },
      () =>
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    ),
  ];
  if (mode === "nested") {
    while (objects.length < 35) objects.push("null");
    objects.push(
      "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream",
    );
  }
  let result = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(result));
    result += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

describe("local textual PDF document", () => {
  it("preserves identical occurrences, cents, and complete-set ordinals", async () => {
    const result = await extractPdfDocument(
      pdf([
        "Fatura",
        "01/02/2026 STORE 10,01",
        "01/02/2026 STORE 10,01",
        "31/02/2026 INVALID 10,01",
        "01/02 NOYEAR 10,01",
      ]),
    );
    expect(result.parserVersion).toBe("card-local-pdf-v1");
    expect(result.occurrences.map((o) => o.amountCents)).toEqual([
      1001, 1001, 1001, 1001,
    ]);
    expect(result.occurrences.map((o) => o.identityOrdinal)).toEqual([
      0,
      1,
      null,
      null,
    ]);
    expect(result.occurrences.slice(2).map((o) => o.dateOnly)).toEqual([
      null,
      null,
    ]);
    expect(result.occurrences[0].reference).toBe("pdf:page:1:line:2");
  });
  it("rejects same-page images including logos, never partial text", async () => {
    await expect(
      extractPdfDocument(pdf(["Fatura", "01/02/2026 STORE 10,01"], true)),
    ).rejects.toMatchObject({ code: "OCR_REQUIRED" });
  });
  it.each(["nested", "inline"] as const)(
    "rejects %s body-image content rather than publishing partial text",
    async (mode) => {
      await expect(
        extractPdfDocument(
          pdf(["Fatura", "01/02/2026 STORE 10,01"], true, 1, mode),
        ),
      ).rejects.toMatchObject({ code: "OCR_REQUIRED" });
    },
  );
  it("rejects missing-dimension image diagnostics without retaining text", async () => {
    await expect(
      extractPdfDocument(
        pdf(["Fatura", "01/02/2026 STORE 10,01"], true, 1, "corrupt"),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_UNREADABLE" });
  });
  it("rejects scanned or blank pages", async () => {
    await expect(extractPdfDocument(pdf([]))).rejects.toMatchObject({
      code: "OCR_REQUIRED",
    });
    await expect(extractPdfDocument(pdf([], true))).rejects.toMatchObject({
      code: "OCR_REQUIRED",
    });
  });
  it("rejects malformed inline image without silently publishing text", async () => {
    await expect(
      extractPdfDocument(
        pdf(["Fatura", "01/02/2026 STORE 10,01"], true, 1, "corrupt-inline"),
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_UNREADABLE" });
  });
  it("accepts 30 pages and rejects 31", async () => {
    expect(
      (
        await extractPdfDocument(
          pdf(["Fatura", "01/02/2026 STORE 10,01"], false, 30),
        )
      ).metrics.pages,
    ).toBe(30);
    await expect(
      extractPdfDocument(pdf(["Fatura"], false, 31)),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("terminates on deadline and cancellation", async () => {
    await expect(
      extractPdfDocument(pdf(["Fatura"]), undefined, 1),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const controller = new AbortController();
    const result = extractPdfDocument(pdf(["Fatura"]), controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
  });
});
