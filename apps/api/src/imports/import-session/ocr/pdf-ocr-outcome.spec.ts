import { ImportSessionErrorCode } from "@reformaflow/domain";
import { PDF_OCR_USAGE_OUTCOME } from "./pdf-ocr-budget";
import { pdfOcrTerminalCodeForLedgerOutcome } from "./pdf-ocr-outcome";

describe("pdfOcrTerminalCodeForLedgerOutcome", () => {
  it.each([
    [PDF_OCR_USAGE_OUTCOME.SAFETY, ImportSessionErrorCode.OCR_SAFETY_BLOCKED],
    [
      PDF_OCR_USAGE_OUTCOME.MALFORMED_RESPONSE,
      ImportSessionErrorCode.OCR_MALFORMED_RESPONSE,
    ],
    [
      PDF_OCR_USAGE_OUTCOME.LIMIT_EXCEEDED,
      ImportSessionErrorCode.LIMIT_EXCEEDED,
    ],
    [
      PDF_OCR_USAGE_OUTCOME.DOCUMENT_UNREADABLE,
      ImportSessionErrorCode.DOCUMENT_UNREADABLE,
    ],
    [PDF_OCR_USAGE_OUTCOME.AUTH, ImportSessionErrorCode.OCR_UNAVAILABLE],
    [
      PDF_OCR_USAGE_OUTCOME.NOT_DISPATCHED,
      ImportSessionErrorCode.OCR_UNAVAILABLE,
    ],
    [
      PDF_OCR_USAGE_OUTCOME.ATTEMPTED,
      ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN,
    ],
    [PDF_OCR_USAGE_OUTCOME.UNKNOWN, ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN],
    [
      PDF_OCR_USAGE_OUTCOME.RATE_LIMITED,
      ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN,
    ],
    [
      PDF_OCR_USAGE_OUTCOME.UPSTREAM,
      ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN,
    ],
    ["UNRECOGNIZED", ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN],
    [PDF_OCR_USAGE_OUTCOME.SUCCEEDED, null],
  ] as const)("maps private ledger outcome %s to %s", (outcome, expected) => {
    expect(pdfOcrTerminalCodeForLedgerOutcome(outcome)).toBe(expected);
  });
});
