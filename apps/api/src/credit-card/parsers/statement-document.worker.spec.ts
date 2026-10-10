import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { runX2Worker } from "./statement-document.worker";
import { extractCardStatementBinaryDocument } from "./statement-document";
import { BinaryDocumentExtractionError } from "./types";
import * as XLSX from "xlsx";

jest.mock("./statement-document", () => ({
  extractCardStatementBinaryDocument: jest.fn(),
  validateDocumentExtraction: jest.fn(),
}));

function frame(kind: number, payload = Buffer.alloc(0), profile = 1): Buffer {
  const h = Buffer.from("58324e310001000000000000", "hex");
  h[4] = kind;
  h[5] = profile;
  h.writeUInt32BE(payload.length, 8);
  return Buffer.concat([h, payload]);
}
describe("X2 worker framing", () => {
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => jest.clearAllMocks());
  it("emits READY, but does not parse until exact DOCUMENT plus EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const running = runX2Worker(input, output);
    input.write(frame(9));
    input.write(frame(4, Buffer.from("synthetic")));
    expect(Buffer.concat(chunks)).toEqual(frame(10));
    expect(extractCardStatementBinaryDocument).not.toHaveBeenCalled();
    jest
      .mocked(extractCardStatementBinaryDocument)
      .mockRejectedValueOnce(new Error("private detail"));
    input.end();
    await running;
    expect(extractCardStatementBinaryDocument).toHaveBeenCalledWith({
      version: 1,
      context: "CARD_INVOICE",
      format: "PDF",
      profile: "PDF_TEXT_CARD",
      bytes: Buffer.from("synthetic"),
    });
    expect(Buffer.concat(chunks).subarray(12)).toEqual(
      frame(7, Buffer.from("001800000000000000000000", "hex")),
    );
  });
  it("never parses an extra frame", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runX2Worker(input, output);
    input.end(Buffer.concat([frame(9), frame(4, Buffer.from("x")), frame(4)]));
    await running;
    expect(extractCardStatementBinaryDocument).not.toHaveBeenCalled();
  });
  it("does not allocate a DOCUMENT body before INIT", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runX2Worker(input, output);
    const header = frame(4);
    header.writeUInt32BE(10485760, 8);
    const allocation = jest.spyOn(Buffer, "alloc");
    input.end(header);
    await running;
    const allocated = allocation.mock.calls.some(([size]) => size === 10485760);
    allocation.mockRestore();
    expect(allocated).toBe(false);
    expect(extractCardStatementBinaryDocument).not.toHaveBeenCalled();
  });
  it.each(["input", "parser"])(
    "writes one terminal frame when %s fails first after EOF",
    async (first) => {
      let rejectExtraction: (error: Error) => void = () => {
        throw new Error("Parser not started");
      };
      jest.mocked(extractCardStatementBinaryDocument).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectExtraction = reject;
          }),
      );
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk));
      const end = jest.spyOn(output, "end");
      const running = runX2Worker(input, output);
      input.end(Buffer.concat([frame(9), frame(4, Buffer.from("synthetic"))]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(extractCardStatementBinaryDocument).toHaveBeenCalledTimes(1);
      if (first === "input") {
        input.emit("error", new Error("Synthetic input failure"));
        await running;
        rejectExtraction(new Error("Synthetic parser failure"));
      } else {
        rejectExtraction(new Error("Synthetic parser failure"));
        await running;
        input.emit("error", new Error("Synthetic input failure"));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(end).toHaveBeenCalledTimes(1);
      expect(Buffer.concat(chunks)).toEqual(
        Buffer.concat([
          frame(10),
          frame(7, Buffer.from("001800000000000000000000", "hex")),
        ]),
      );
    },
  );
  it("does not allocate a second DOCUMENT body after the first one", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runX2Worker(input, output);
    input.write(Buffer.concat([frame(9), frame(4, Buffer.from("first"))]));
    const header = frame(4);
    header.writeUInt32BE(10485760, 8);
    const allocation = jest.spyOn(Buffer, "alloc");
    input.end(header);
    await running;
    const allocated = allocation.mock.calls.some(([size]) => size === 10485760);
    allocation.mockRestore();
    expect(allocated).toBe(false);
    expect(extractCardStatementBinaryDocument).not.toHaveBeenCalled();
  });
  it("maps a documentary refusal to the literal internal ERROR without cleanup authority", async () => {
    jest
      .mocked(extractCardStatementBinaryDocument)
      .mockRejectedValueOnce(
        new BinaryDocumentExtractionError("NO_TEXT_LAYER"),
      );
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const running = runX2Worker(input, output);
    input.end(Buffer.concat([frame(9), frame(4, Buffer.from("synthetic"))]));
    await running;
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.concat([
        frame(10),
        frame(7, Buffer.from("000a00000002000200000000", "hex")),
      ]),
    );
  });
  it.each(["XLS", "XLSX"] as const)(
    "uses the real accepted X2 parser for a synthetic %s document",
    async (format) => {
      const actual = jest.requireActual<typeof import("./statement-document")>(
        "./statement-document",
      );
      jest
        .mocked(extractCardStatementBinaryDocument)
        .mockImplementationOnce(actual.extractCardStatementBinaryDocument);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ["Fatura de cartao"],
          ["Vencimento 10/11/2025"],
          ["Lancamentos desta fatura"],
          ["Data", "Descricao", "Valor"],
          ["23/10/2025", "LOJA SINTETICA", "12,34"],
        ]),
        "Fatura",
      );
      const bytes = Buffer.from(
        XLSX.write(workbook, {
          type: "buffer",
          bookType: format === "XLS" ? "biff8" : "xlsx",
        }),
      );
      const profile = format === "XLS" ? 2 : 3;
      const input = new PassThrough();
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk));
      const running = runX2Worker(input, output);
      input.end(
        Buffer.concat([
          frame(9, Buffer.alloc(0), profile),
          frame(4, bytes, profile),
        ]),
      );
      await running;
      const response = Buffer.concat(chunks);
      expect(response.subarray(0, 12)).toEqual(
        frame(10, Buffer.alloc(0), profile),
      );
      expect(response[16]).toBe(5);
      const result = actual.validateDocumentExtraction(
        JSON.parse(response.subarray(24).toString("utf8")),
      );
      expect(result.parserVersion).toBe(
        format === "XLS" ? "card-local-xls-v1" : "card-local-xlsx-v1",
      );
      expect(result.occurrences).toHaveLength(1);
      expect(result.occurrences[0].amountCents).toBe(1234);
    },
  );
  it("runs the worker entrypoint with its own TS loader on a synthetic PDF (not isolation)", () => {
    const lines = [
      "Fatura de cartao",
      "Vencimento 10/11/2025",
      "Lancamentos desta fatura",
      "Data Descricao Valor",
      "23/10/2025 LOJA SINTETICA 12,34",
    ];
    const stream = lines
      .map(
        (line, index) =>
          `BT /F1 10 Tf 1 0 0 1 36 ${800 - index * 16} Tm (${line}) Tj ET`,
      )
      .join("\n");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = objects.map((object, index) => {
      const offset = Buffer.byteLength(pdf);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      return offset;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const root = resolve(__dirname, "../../../../..");
    const child = spawnSync(
      process.execPath,
      [
        "--require",
        resolve(root, "scripts/test-db-env.cjs"),
        "--require",
        require.resolve("ts-node/register"),
        resolve(
          root,
          "apps/api/src/credit-card/parsers/statement-document.worker.ts",
        ),
      ],
      {
        cwd: root,
        env: {
          TEST_DATABASE_URL: `file:${resolve(root, "prisma/x2-unit-unused.db")}`,
          TS_NODE_PROJECT: resolve(root, "apps/api/tsconfig.json"),
        },
        input: Buffer.concat([frame(9), frame(4, Buffer.from(pdf))]),
        timeout: 10000,
        maxBuffer: 1048576,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout.subarray(0, 12)).toEqual(frame(10));
    expect(child.stdout[16]).toBe(5);
    expect(child.stdout.length).toBe(24 + child.stdout.readUInt32BE(20));
    const actual = jest.requireActual<typeof import("./statement-document")>(
      "./statement-document",
    );
    const result = actual.validateDocumentExtraction(
      JSON.parse(child.stdout.subarray(24).toString("utf8")),
    );
    expect(result.parserVersion).toBe("card-local-pdf-v1");
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].amountCents).toBe(1234);
  });
});
