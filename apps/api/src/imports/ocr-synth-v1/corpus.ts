import groundTruth from "./ground-truth.json";
import type { OcrEvalCase, OcrEvalDataset } from "./types";

export const OCR_SYNTH_DATASET = groundTruth as OcrEvalDataset;

export const OCR_SYNTH_SCANNED_RELEASE_CASES = OCR_SYNTH_DATASET.cases.filter(
  (item) => item.partition === "SCANNED_PDF",
);

export const OCR_SYNTH_ROUTING_CASES = OCR_SYNTH_DATASET.cases.filter(
  (item) => item.partition === "MIXED_PDF",
);

export const OCR_SYNTH_FUTURE_IMAGE_CASES = OCR_SYNTH_DATASET.cases.filter(
  (item) => item.partition === "IMAGE",
);

export function getOcrSynthCase(caseId: string): OcrEvalCase {
  const found = OCR_SYNTH_DATASET.cases.find((item) => item.id === caseId);
  if (!found) throw new Error(`Unknown ocr-synth-v1 case: ${caseId}`);
  return found;
}

export function successfulRows(testCase: OcrEvalCase) {
  return testCase.expected.kind === "SUCCESS"
    ? testCase.expected.regions.flatMap((region) => region.rows)
    : [];
}
