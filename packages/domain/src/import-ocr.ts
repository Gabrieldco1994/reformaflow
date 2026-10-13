import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  type ImportSessionDateOnly,
  type ImportSessionHash,
  type ImportSessionId,
  type ImportSessionInstant,
} from "./import-session";

export const PDF_OCR_VERSION = 2 as const;
export const PDF_OCR_PROVIDER_ID = "GOOGLE_VERTEX_AI" as const;
export const PDF_OCR_MODEL_ID = "gemini-2.5-flash" as const;

export const PDF_OCR_LIMITS = Object.freeze({
  pagesPerFile: IMPORT_SESSION_LIMITS.pdfPagesPerFile,
  candidatesPerFile: IMPORT_SESSION_LIMITS.parsedRowsPerFile,
  installmentsPerPurchase: IMPORT_SESSION_LIMITS.installmentsPerPurchase,
  pixelsPerPage: IMPORT_SESSION_LIMITS.imagePixels,
  descriptionLength: IMPORT_SESSION_PRIMITIVES.maxObservationTextLength,
  providerRequestIdLength: IMPORT_SESSION_PRIMITIVES.maxReferenceLength,
  providerLatencyMs: IMPORT_SESSION_LIMITS.parserDeadlineSeconds * 1000,
});

export const PdfOcrRegionStatus = {
  COMPLETE: "COMPLETE",
  FAILED: "FAILED",
} as const;
export type PdfOcrRegionStatus =
  (typeof PdfOcrRegionStatus)[keyof typeof PdfOcrRegionStatus];

export const PdfOcrVerificationStatus = {
  UNVERIFIED: "UNVERIFIED",
} as const;
export type PdfOcrVerificationStatus =
  (typeof PdfOcrVerificationStatus)[keyof typeof PdfOcrVerificationStatus];

export const PdfOcrDiagnostic = {
  MISSING_YEAR: "MISSING_YEAR",
} as const;
export type PdfOcrDiagnostic =
  (typeof PdfOcrDiagnostic)[keyof typeof PdfOcrDiagnostic];

export interface PdfOcrBoundsV2 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfOcrRequestProvenanceV2 {
  readonly provider: typeof PDF_OCR_PROVIDER_ID;
  readonly model: typeof PDF_OCR_MODEL_ID;
  readonly region: string;
  readonly requestId: string;
}

export interface PdfOcrManifestRegionV2 {
  readonly regionIndex: number;
  readonly regionSha256: ImportSessionHash;
  readonly bounds: PdfOcrBoundsV2;
}

export interface PdfOcrManifestPageV2 {
  readonly pageNumber: number;
  readonly pageSha256: ImportSessionHash;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly regions: readonly PdfOcrManifestRegionV2[];
}

/**
 * Server-produced inventory of the rendered PDF. Pages without OCR regions stay
 * present so a mixed document cannot disappear from result accounting.
 */
export interface PdfOcrManifestV2 {
  readonly version: typeof PDF_OCR_VERSION;
  readonly artifactSha256: ImportSessionHash;
  readonly pageCount: number;
  readonly request: PdfOcrRequestProvenanceV2;
  readonly pages: readonly PdfOcrManifestPageV2[];
}

export interface PdfOcrUsageV2 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface PdfOcrProviderProvenanceV2 extends PdfOcrRequestProvenanceV2 {
  readonly usage: PdfOcrUsageV2;
  readonly latencyMs: number;
}

export interface PdfOcrInstallmentV2 {
  readonly index: number;
  readonly total: number;
}

export interface PdfOcrRawEvidenceV2 {
  readonly pageNumber: number;
  readonly regionIndex: number;
  readonly regionSha256: ImportSessionHash;
  readonly text: string;
  readonly textSha256: ImportSessionHash;
}

export interface PdfOcrRawCandidateV2 {
  readonly description: string;
  /** Canonical signed base-10 integer, still a string at this trust boundary. */
  readonly amountCents: string;
  readonly dateText: string | null;
  readonly installment: PdfOcrInstallmentV2 | null;
  readonly evidence: PdfOcrRawEvidenceV2;
}

export interface PdfOcrEnvelopeRegionV2 {
  readonly regionIndex: number;
  readonly regionSha256: ImportSessionHash;
  readonly status: PdfOcrRegionStatus;
  readonly candidates: readonly PdfOcrRawCandidateV2[];
}

export interface PdfOcrEnvelopePageV2 {
  readonly pageNumber: number;
  readonly pageSha256: ImportSessionHash;
  readonly regions: readonly PdfOcrEnvelopeRegionV2[];
}

/** Untrusted provider response shape; runtime acceptance always goes through the parser. */
export interface PdfOcrEnvelopeV2 {
  readonly version: typeof PDF_OCR_VERSION;
  readonly artifactSha256: ImportSessionHash;
  readonly provenance: PdfOcrProviderProvenanceV2;
  readonly pages: readonly PdfOcrEnvelopePageV2[];
}

export interface PdfOcrEvidenceV2 extends PdfOcrRawEvidenceV2 {
  readonly artifactSha256: ImportSessionHash;
  readonly pageSha256: ImportSessionHash;
  readonly bounds: PdfOcrBoundsV2;
}

export interface PdfOcrCandidateV2 {
  readonly description: string;
  readonly amountCents: string;
  readonly dateText: string | null;
  readonly date: ImportSessionDateOnly | null;
  readonly diagnostics: readonly PdfOcrDiagnostic[];
  readonly installment: PdfOcrInstallmentV2 | null;
  readonly verificationStatus: typeof PdfOcrVerificationStatus.UNVERIFIED;
  readonly selected: false;
  readonly evidence: PdfOcrEvidenceV2;
}

export interface PdfOcrParsedRegionV2 {
  readonly regionIndex: number;
  readonly regionSha256: ImportSessionHash;
  readonly bounds: PdfOcrBoundsV2;
  readonly candidates: readonly PdfOcrCandidateV2[];
}

export interface PdfOcrParsedPageV2 {
  readonly pageNumber: number;
  readonly pageSha256: ImportSessionHash;
  readonly regions: readonly PdfOcrParsedRegionV2[];
}

export interface PdfOcrDocumentV2 {
  readonly version: typeof PDF_OCR_VERSION;
  readonly artifactSha256: ImportSessionHash;
  readonly provenance: PdfOcrProviderProvenanceV2;
  readonly accounting: Readonly<{
    pageCount: number;
    regionCount: number;
    candidateCount: number;
  }>;
  readonly pages: readonly PdfOcrParsedPageV2[];
}

export const PdfOcrAttestationDecision = {
  ACCEPT: "ACCEPT",
  REJECT: "REJECT",
} as const;
export type PdfOcrAttestationDecision =
  (typeof PdfOcrAttestationDecision)[keyof typeof PdfOcrAttestationDecision];

/** Port input only; it grants no financial authority and is not provider-controlled. */
export interface PdfOcrHumanAttestationV2 {
  readonly version: typeof PDF_OCR_VERSION;
  readonly tenantId: ImportSessionId;
  readonly sessionId: ImportSessionId;
  readonly actorId: ImportSessionId;
  readonly artifactSha256: ImportSessionHash;
  /** The complete still-UNVERIFIED candidate whose evidence the human saw. */
  readonly candidate: PdfOcrCandidateV2;
  readonly decision: PdfOcrAttestationDecision;
  readonly attestedAt: ImportSessionInstant;
}
