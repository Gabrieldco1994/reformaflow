import {
  ignoredImportObservation,
  type StoredImportObservationEvidenceV1,
} from "../import-session.observation";

const PAYMENT_TEXT = "PAGAMENTO DE FATURA CARTAO FINAL 0719";

function evidence(origin: "LOCAL" | "OCR"): StoredImportObservationEvidenceV1 {
  return {
    sourceDescription: PAYMENT_TEXT,
    version: 1,
    reference:
      origin === "OCR" ? "ocr:page:1:candidate:2" : "local:page:1:line:2",
    text: PAYMENT_TEXT,
    amountMeaning: "UNKNOWN",
    amountCents: -20_696,
    installmentCount: null,
    installmentIndex: null,
    dataCompra: "2026-10-13",
    identity: {
      merchant: PAYMENT_TEXT,
      externalId: null,
      fitId: null,
      ordinal: 0,
      fileContentHash: "a".repeat(32),
    },
    ...(origin === "OCR"
      ? {
          ocr: {
            provenanceVersion: 2 as const,
            usageId: "00000000-0000-4000-8000-000000000719",
            attachmentId: "10000000-0000-4000-8000-000000000001",
            artifactSha256: "b".repeat(64),
            provider: "GOOGLE_VERTEX_AI" as const,
            model: "gemini-2.5-flash" as const,
            modelVersion: "gemini-2.5-flash-719-release",
            region: "southamerica-east1" as const,
            authTrace: "LOCAL_ADC" as const,
            requestId: "10000000-0000-4000-8000-000000000719",
            responseId: "vertex-response-719",
            candidateFingerprint: "c".repeat(64),
            pageNumber: 1,
          },
        }
      : {}),
  };
}

describe("#719 OCR all-lines release barrier", () => {
  it("defers the exact OCR payment text while local extraction still classifies it", () => {
    expect(ignoredImportObservation(evidence("LOCAL"))).toBe("INVOICE_PAYMENT");
    expect(ignoredImportObservation(evidence("OCR"))).toBeNull();
  });
});
