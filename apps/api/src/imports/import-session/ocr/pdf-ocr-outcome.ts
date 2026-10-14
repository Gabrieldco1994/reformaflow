import {
  ImportSessionErrorCode,
  type ImportSessionOcrTerminalCodeV1,
} from "@reformaflow/domain";
import { PDF_OCR_USAGE_OUTCOME } from "./pdf-ocr-budget";

/**
 * The ledger is private and historically contains provider-shaped outcomes.
 * This is the sole conversion to the stable public/import-workflow vocabulary.
 */
export function pdfOcrTerminalCodeForLedgerOutcome(
  outcome: string,
): ImportSessionOcrTerminalCodeV1 | null {
  switch (outcome) {
    case PDF_OCR_USAGE_OUTCOME.SUCCEEDED:
    case "CAPTURE_SPEND_LIMIT":
      return null;
    case PDF_OCR_USAGE_OUTCOME.SAFETY:
      return ImportSessionErrorCode.OCR_SAFETY_BLOCKED;
    case PDF_OCR_USAGE_OUTCOME.MALFORMED_RESPONSE:
      return ImportSessionErrorCode.OCR_MALFORMED_RESPONSE;
    case PDF_OCR_USAGE_OUTCOME.LIMIT_EXCEEDED:
      return ImportSessionErrorCode.LIMIT_EXCEEDED;
    case PDF_OCR_USAGE_OUTCOME.DOCUMENT_UNREADABLE:
      return ImportSessionErrorCode.DOCUMENT_UNREADABLE;
    case PDF_OCR_USAGE_OUTCOME.REQUEST_STALE_AFTER_COUNT:
      return ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN;
    case PDF_OCR_USAGE_OUTCOME.AUTH:
    case PDF_OCR_USAGE_OUTCOME.NOT_DISPATCHED:
      return ImportSessionErrorCode.OCR_UNAVAILABLE;
    case PDF_OCR_USAGE_OUTCOME.ATTEMPTED:
    case PDF_OCR_USAGE_OUTCOME.UNKNOWN:
    case PDF_OCR_USAGE_OUTCOME.RATE_LIMITED:
    case PDF_OCR_USAGE_OUTCOME.UPSTREAM:
    default:
      return ImportSessionErrorCode.OCR_ATTEMPT_UNKNOWN;
  }
}
