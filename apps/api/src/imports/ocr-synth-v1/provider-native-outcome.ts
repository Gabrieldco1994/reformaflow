import type { PdfOcrDocumentV2 } from "@reformaflow/domain";
import type { OcrProviderNativeOutcome, OcrProviderSign } from "./types";

export function signFromCents(value: string | null): OcrProviderSign {
  if (value === null) return "UNKNOWN";
  const cents = BigInt(value);
  if (cents < 0n) return "NEGATIVE";
  if (cents > 0n) return "POSITIVE";
  return "ZERO";
}

/** Project only adapter-returned fields. Oracle annotations never enter evidence. */
export function providerNativeOutcome(
  document: PdfOcrDocumentV2,
): OcrProviderNativeOutcome {
  return {
    kind: "SUCCESS",
    candidates: document.candidates.map((candidate) => ({
      pageNumber: candidate.pageNumber,
      pageOccurrenceIndex: candidate.pageOccurrenceIndex,
      description: candidate.description,
      amountCents: candidate.amountCents,
      sign: signFromCents(candidate.amountCents),
      amountMeaning: candidate.amountMeaning,
      dateText: candidate.dateText,
      normalizedDate: candidate.normalizedDate,
      dateExplicitness: candidate.dateExplicitness,
      installment: candidate.installment
        ? {
            index: candidate.installment.index,
            total: candidate.installment.total,
          }
        : null,
      evidenceText: candidate.evidence.text,
      selected: false,
      verificationStatus: "UNVERIFIED",
      candidateDisposition: "RAW_UNCLASSIFIED",
    })),
  };
}
