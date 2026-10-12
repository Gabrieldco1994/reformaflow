/**
 * Synthetic, uncompressed PDF fixtures. No private documents, binary files,
 * filesystem writes, clock dependence, OCR service, or database access.
 *
 * The image page is a minimal raster stand-in, NOT a realistic bank scan or
 * an OCR-accuracy fixture. It deliberately has no hidden searchable text.
 */
export const PDF_QA_CARD_ID = "synthetic-pdf-qa-card";

export const PDF_QA_INVOICE_LINES = [
  "Fatura CARTAO SINTETICO",
  "Vencimento 10/10/2026",
  "01/09 MERCADO SINTETICO R$ 206,96",
  "02/09 CAFE TESTE R$ 0,01",
  "03/09 LIVRARIA FICTICIA R$ 1.500,00",
  "04/09 OFICINA DEMO R$ 20.696,00",
  "05/09 FARMACIA TESTE R$ 87,43",
  "06/09 PAGAMENTO DE FATURA - 22.490,40",
] as const;

export const PDF_QA_PURCHASES = [
  {
    date: "2026-09-01T00:00:00.000Z",
    merchant: "MERCADO SINTETICO",
    amountCents: 20696,
  },
  {
    date: "2026-09-02T00:00:00.000Z",
    merchant: "CAFE TESTE",
    amountCents: 1,
  },
  {
    date: "2026-09-03T00:00:00.000Z",
    merchant: "LIVRARIA FICTICIA",
    amountCents: 150000,
  },
  {
    date: "2026-09-04T00:00:00.000Z",
    merchant: "OFICINA DEMO",
    amountCents: 2069600,
  },
  {
    date: "2026-09-05T00:00:00.000Z",
    merchant: "FARMACIA TESTE",
    amountCents: 8743,
  },
] as const;

export const PDF_QA_PURCHASE_TOTAL_CENTS = 2249040;
export const PDF_QA_PAYMENT = {
  date: "2026-09-06T00:00:00.000Z",
  merchant: "PAGAMENTO DE FATURA",
  amountCents: -2249040,
} as const;

type Page = { kind: "text"; lines: readonly string[] } | { kind: "image" };

function stream(dictionary: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}

function literal(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    throw new Error("PDF QA text must be printable ASCII");
  }
  return value.replace(/[\\()]/g, "\\$&");
}

function buildPdf(pages: readonly Page[]): Buffer {
  // IDs 1/2/3 are catalog, page tree, and a standard built-in font.
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.alloc(0),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const pageIds: number[] = [];
  for (const page of pages) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    if (page.kind === "text") {
      const commands = [
        "BT /F1 12 Tf 18 TL 40 780 Td",
        ...page.lines.flatMap((line, index) => [
          ...(index ? ["T*"] : []),
          `(${literal(line)}) Tj`,
        ]),
        "ET",
      ].join("\n");
      objects.push(
        Buffer.from(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] ` +
            `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
        stream("", Buffer.from(commands)),
      );
    } else {
      const imageId = contentId + 1;
      objects.push(
        Buffer.from(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] ` +
            `/Resources << /XObject << /Scan ${imageId} 0 R >> >> ` +
            `/Contents ${contentId} 0 R >>`,
        ),
        stream("", Buffer.from("q 500 0 0 700 40 40 cm /Scan Do Q")),
        stream(
          "/Type /XObject /Subtype /Image /Width 8 /Height 8 " +
            "/ColorSpace /DeviceGray /BitsPerComponent 1",
          Buffer.from([0xff, 0x81, 0xbd, 0xa5, 0xa5, 0xbd, 0x81, 0xff]),
        ),
      );
    }
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] ` +
      `/Count ${pageIds.length} >>`,
  );

  const chunks = [Buffer.from("%PDF-1.4\n%synthetic-qa\n")];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    position += chunk.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f `,
    ...offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref\n${position}\n%%EOF\n`,
  ].join("\n");
  return Buffer.concat([...chunks, Buffer.from(xref)]);
}

export function generateTextInvoicePdf(): Buffer {
  return buildPdf([{ kind: "text", lines: PDF_QA_INVOICE_LINES }]);
}

export function generateScannedOnlyPdf(): Buffer {
  return buildPdf([{ kind: "image" }]);
}

export function generateMixedInvoicePdf(): Buffer {
  return buildPdf([
    { kind: "text", lines: PDF_QA_INVOICE_LINES },
    { kind: "image" },
  ]);
}

export function generateInvalidPdf(): Buffer {
  return Buffer.from("%PDF-1.4\nnot a document: no catalog, pages, or xref\n");
}
