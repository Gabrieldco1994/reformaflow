import groundTruth from "./ground-truth.json";
import type { OcrEvalCase, OcrEvalDataset } from "./types";

export const OCR_SYNTH_DATASET = groundTruth as OcrEvalDataset;

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
