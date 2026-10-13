import type {
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PdfOcrHumanAttestationV2,
  PdfOcrManifestV2,
} from "@reformaflow/domain";

export interface FixedPdfOcrProviderRequest {
  readonly manifest: PdfOcrManifestV2;
  readonly pdfBytes: Buffer;
}

/** One qualified provider/model only; no selector, factory, fallback, or registration. */
export interface FixedPdfOcrProviderPort {
  readonly provider: typeof PDF_OCR_PROVIDER_ID;
  readonly model: typeof PDF_OCR_MODEL_ID;
  extractPdf(request: FixedPdfOcrProviderRequest): Promise<unknown>;
}

/** Human evidence decision seam; it does not select or prepare a financial line. */
export interface PdfOcrHumanAttestationPort {
  attest(attestation: PdfOcrHumanAttestationV2): Promise<void>;
}
