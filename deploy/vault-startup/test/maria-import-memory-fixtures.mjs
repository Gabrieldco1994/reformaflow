import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { AnnotationMode, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFParse } from "pdf-parse";

const require = createRequire(import.meta.url);
const standardFontDataUrl =
  join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") +
  "/";

export const PDF_LIMITS = Object.freeze({
  fileBytes: 10_485_760,
  pages: 30,
  operatorsPerPage: 200_000,
  outputUtf8Bytes: 10_485_760,
});

const PURCHASE_LINE = "2026-09-01 SYNTHETIC_PURCHASE 1.00";

function pageContent(
  pageIndex,
  { fillerBytes = 0, operatorPairs = 0, extraOperator = false } = {},
) {
  const marker = `BENCHMARK_PAGE_${pageIndex + 1}`;
  const filler = pageIndex === 0 ? "X".repeat(fillerBytes) : "";
  const fillerCommands = [];
  if (filler.length > 0) {
    fillerCommands.push("BT", "/F1 1 Tf");
    for (let start = 0; start < filler.length; start += 512) {
      const chunk = filler.slice(start, start + 512);
      fillerCommands.push(`1 0 0 1 24 700 Tm`, `(${chunk}) Tj`);
    }
    fillerCommands.push("ET");
  }
  return Buffer.from(
    [
      "BT",
      "/F1 8 Tf",
      "24 760 Td",
      pageIndex === 0 ? `(${PURCHASE_LINE}) Tj` : `(${marker}) Tj`,
      "0 -12 Td",
      pageIndex === 0 ? `(${marker}) Tj` : "(X) Tj",
      "ET",
      ...fillerCommands,
      ...(extraOperator ? ["0.5 w"] : []),
      "q Q\n".repeat(operatorPairs),
      "",
    ].join("\n"),
    "ascii",
  );
}

function encodePdf(pageCount, options = {}) {
  const objects = new Map();
  const pageIds = [];
  let nextId = 4;
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    const content = deflateSync(pageContent(index, index === 0 ? options : {}));
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.set(
      contentId,
      Buffer.concat([
        Buffer.from(
          `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`,
          "ascii",
        ),
        content,
        Buffer.from("\nendstream", "ascii"),
      ]),
    );
  }

  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  );
  objects.set(
    3,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

  const chunks = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = new Array(nextId).fill(0);
  let offset = chunks[0].length;
  for (let id = 1; id < nextId; id += 1) {
    const body = objects.get(id);
    assert.ok(body, `missing synthetic PDF object ${id}`);
    const object = Buffer.isBuffer(body)
      ? Buffer.concat([
          Buffer.from(`${id} 0 obj\n`, "ascii"),
          body,
          Buffer.from("\nendobj\n", "ascii"),
        ])
      : Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, "ascii");
    offsets[id] = offset;
    chunks.push(object);
    offset += object.length;
  }
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${nextId}\n`,
    "0000000000 65535 f \n",
    ...offsets
      .slice(1)
      .map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

function padToFileBytes(bytes, targetBytes) {
  if (targetBytes === undefined) return bytes;
  assert.ok(
    bytes.length <= targetBytes,
    "PDF fixture content exceeds its byte target",
  );
  const paddingBytes = targetBytes - bytes.length;
  if (paddingBytes === 0) return bytes;
  const padding =
    paddingBytes === 1
      ? Buffer.from("%", "ascii")
      : Buffer.from(`%${"x".repeat(paddingBytes - 1)}`, "ascii");
  return Buffer.concat([bytes, padding]);
}

async function inspectPdf(bytes) {
  const documentTask = getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    maxImageSize: -1,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWasm: false,
    enableXfa: false,
    verbosity: 1,
    standardFontDataUrl,
  });
  let parser;
  try {
    const document = await documentTask.promise;
    const operatorCounts = [];
    let textPagesWithText = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const operators = await page.getOperatorList({
        intent: "any",
        annotationMode: AnnotationMode.ENABLE,
      });
      operatorCounts.push(operators.fnArray.length);
      const content = await page.getTextContent();
      if (
        content.items.some(
          (item) => "str" in item && item.str.trim().length > 0,
        )
      )
        textPagesWithText += 1;
      page.cleanup();
    }

    parser = new PDFParse({
      data: new Uint8Array(bytes),
      stopAtErrors: true,
      maxImageSize: 0,
      isEvalSupported: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      useWasm: false,
      enableXfa: false,
      verbosity: 1,
      standardFontDataUrl,
    });
    const info = await parser.getInfo({ parsePageInfo: true });
    const extracted = await parser.getText({
      pageJoiner: "",
      disableNormalization: true,
    });
    assert.equal(info.total, document.numPages);
    assert.equal(extracted.total, document.numPages);
    assert.equal(extracted.pages.length, document.numPages);
    const outputUtf8Bytes = extracted.pages.reduce(
      (total, page) => total + Buffer.byteLength(page.text, "utf8"),
      0,
    );
    const visibleText = extracted.pages.map((page) => page.text).join("\n");
    const purchaseCount = visibleText.split(PURCHASE_LINE).length - 1;
    return {
      pages: document.numPages,
      operatorsOnBoundaryPage: operatorCounts[0] ?? 0,
      textPagesWithText,
      outputUtf8Bytes,
      purchaseCount,
    };
  } finally {
    if (parser) await parser.destroy();
    await documentTask.destroy();
  }
}

async function buildPdf({
  pageCount = 1,
  operatorTarget,
  outputTargetBytes,
  fileTargetBytes,
}) {
  let operatorPairs = 0;
  let extraOperator = false;
  let fillerBytes = 0;

  if (outputTargetBytes !== undefined) {
    const base = encodePdf(pageCount, { operatorPairs, extraOperator });
    const baseStats = await inspectPdf(base);
    fillerBytes = outputTargetBytes - baseStats.outputUtf8Bytes;
    assert.ok(fillerBytes >= 0, "base content already exceeds output target");
    let fitted = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const textStats = await inspectPdf(encodePdf(pageCount, { fillerBytes }));
      const difference = outputTargetBytes - textStats.outputUtf8Bytes;
      if (difference === 0) {
        fitted = true;
        break;
      }
      fillerBytes += difference;
      assert.ok(fillerBytes >= 0, "PDF output calibration fell below its base");
    }
    assert.ok(
      fitted,
      "PDF parser output could not be calibrated to the exact limit",
    );
  }

  if (operatorTarget !== undefined) {
    const baseStats = await inspectPdf(encodePdf(pageCount, { fillerBytes }));
    const onePairStats = await inspectPdf(
      encodePdf(pageCount, { fillerBytes, operatorPairs: 1 }),
    );
    const operatorsPerPair =
      onePairStats.operatorsOnBoundaryPage - baseStats.operatorsOnBoundaryPage;
    assert.ok(
      operatorsPerPair > 0,
      "PDF parser did not expose the operator calibration",
    );
    const operatorDelta = operatorTarget - baseStats.operatorsOnBoundaryPage;
    assert.ok(
      operatorDelta >= 0,
      "base content already exceeds operator target",
    );
    operatorPairs = Math.floor(operatorDelta / operatorsPerPair);
    const remainder = operatorDelta - operatorPairs * operatorsPerPair;
    if (remainder !== 0) {
      assert.equal(remainder, 1, "operator target cannot be formed exactly");
      extraOperator = true;
    }
    const operatorStats = await inspectPdf(
      encodePdf(pageCount, { fillerBytes, operatorPairs, extraOperator }),
    );
    assert.equal(
      operatorStats.operatorsOnBoundaryPage,
      operatorTarget,
      "synthetic PDF failed the exact operator target",
    );
  }

  const content = encodePdf(pageCount, {
    operatorPairs,
    extraOperator,
    fillerBytes,
  });
  const bytes = padToFileBytes(content, fileTargetBytes);
  const stats = await inspectPdf(bytes);
  if (operatorTarget !== undefined)
    assert.equal(stats.operatorsOnBoundaryPage, operatorTarget);
  if (outputTargetBytes !== undefined)
    assert.equal(stats.outputUtf8Bytes, outputTargetBytes);
  if (fileTargetBytes !== undefined)
    assert.equal(bytes.length, fileTargetBytes);
  return { bytes, stats };
}

export function validateBoundaryStats(stats) {
  const expected = {
    nearFileBytes: PDF_LIMITS.fileBytes - 1,
    maxFileBytes: PDF_LIMITS.fileBytes,
    pages: PDF_LIMITS.pages,
    operatorsOnBoundaryPage: PDF_LIMITS.operatorsPerPage,
    textPagesWithText: PDF_LIMITS.pages,
    outputUtf8Bytes: PDF_LIMITS.outputUtf8Bytes,
    purchaseCount: 1,
  };
  assert.deepEqual(
    stats,
    expected,
    "PDF fixture did not meet all exact parser limits",
  );
  return expected;
}

let fixturePromise;

async function createBenchmarkFixtures() {
  const maxAccepted = await buildPdf({
    pageCount: PDF_LIMITS.pages,
    operatorTarget: PDF_LIMITS.operatorsPerPage,
    outputTargetBytes: PDF_LIMITS.outputUtf8Bytes,
    fileTargetBytes: PDF_LIMITS.fileBytes,
  });
  const nearSize = await buildPdf({
    pageCount: 1,
    fileTargetBytes: PDF_LIMITS.fileBytes - 1,
  });
  const pagesOver = await buildPdf({ pageCount: PDF_LIMITS.pages + 1 });
  const operatorsOver = await buildPdf({
    operatorTarget: PDF_LIMITS.operatorsPerPage + 1,
  });
  const textOver = await buildPdf({
    outputTargetBytes: PDF_LIMITS.outputUtf8Bytes + 1,
  });
  const overStats = {
    pages: pagesOver.stats.pages,
    operatorsOnBoundaryPage: operatorsOver.stats.operatorsOnBoundaryPage,
    outputUtf8Bytes: textOver.stats.outputUtf8Bytes,
  };
  validateBoundaryStats({
    nearFileBytes: nearSize.bytes.length,
    maxFileBytes: maxAccepted.bytes.length,
    pages: maxAccepted.stats.pages,
    operatorsOnBoundaryPage: maxAccepted.stats.operatorsOnBoundaryPage,
    textPagesWithText: maxAccepted.stats.textPagesWithText,
    outputUtf8Bytes: maxAccepted.stats.outputUtf8Bytes,
    purchaseCount: maxAccepted.stats.purchaseCount,
  });
  assert.deepEqual(overStats, {
    pages: PDF_LIMITS.pages + 1,
    operatorsOnBoundaryPage: PDF_LIMITS.operatorsPerPage + 1,
    outputUtf8Bytes: PDF_LIMITS.outputUtf8Bytes + 1,
  });
  return {
    maxAccepted,
    nearSize,
    pagesOver,
    operatorsOver,
    textOver,
  };
}

export function buildBenchmarkFixtures() {
  fixturePromise ??= createBenchmarkFixtures();
  return fixturePromise;
}
