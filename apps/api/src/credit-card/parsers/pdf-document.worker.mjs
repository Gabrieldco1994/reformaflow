import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
// Dedicated worker only. Retain no diagnostic payload and emit no private text.
let diagnostic = false;
console.warn = console.error = () => {
  diagnostic = true;
};
console.log = console.info = () => {
  diagnostic = true;
};
const { getDocument, OPS, AnnotationMode } =
  await import("pdfjs-dist/legacy/build/pdf.mjs");
const standardFontDataUrl =
  join(
    dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
    "standard_fonts",
  ) + "/";

// No rendering/getImage/OCR, network source or private PDF.js API.
// Operator-list evaluation can allocate/decode internally before returning.
const raster = new Set([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintSolidColorImageMask,
]);
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
let task;
let parser;
let outcome;
let coverage = false;
try {
  const data = new Uint8Array(workerData.bytes);
  task = getDocument({
    data: data.slice(),
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
  const doc = await task.promise;
  if (doc.isPureXfa) fail("OCR_REQUIRED");
  if (doc.numPages > workerData.maxPages) fail("LIMIT_EXCEEDED");
  coverage = true;
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const operators = await page.getOperatorList({
      intent: "any",
      annotationMode: AnnotationMode.ENABLE,
    });
    if (operators.fnArray.length > workerData.maxOperators)
      fail("LIMIT_EXCEEDED");
    if (operators.fnArray.some((op) => raster.has(op))) fail("OCR_REQUIRED");
    const content = await page.getTextContent();
    if (!content.items.some((item) => "str" in item && item.str.trim()))
      fail("OCR_REQUIRED");
    page.cleanup();
  }
  coverage = false;
  const { PDFParse } = await import("pdf-parse");
  parser = new PDFParse({
    data: data.slice(),
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
  const text = await parser.getText({
    pageJoiner: "",
    disableNormalization: true,
  });
  if (
    info.total !== doc.numPages ||
    text.total !== doc.numPages ||
    text.pages.length !== doc.numPages
  )
    fail("OCR_REQUIRED");
  if (
    text.pages.reduce(
      (size, page) => size + Buffer.byteLength(page.text, "utf8"),
      0,
    ) > workerData.maxOutputBytes
  )
    fail("LIMIT_EXCEEDED");
  outcome = { pages: text.pages };
} catch (error) {
  outcome = {
    code:
      error?.code === "LIMIT_EXCEEDED" || error?.code === "OCR_REQUIRED"
        ? error.code
        : error?.name === "PasswordException"
          ? "PDF_PASSWORD_REQUIRED"
          : coverage
            ? "OCR_REQUIRED"
            : "DOCUMENT_UNREADABLE",
  };
} finally {
  try {
    if (parser) await parser.destroy();
    if (task) await task.destroy();
  } catch {
    outcome = { code: "OCR_REQUIRED" };
  }
}
if (diagnostic) outcome = { code: "DOCUMENT_UNREADABLE" };
parentPort.postMessage(outcome);
parentPort.close();
