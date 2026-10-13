import { randomUUID } from "node:crypto";
import {
  PDF_OCR_CONSENT_POLICY_VERSION,
  PDF_OCR_CONSENT_PURPOSE,
  PDF_OCR_MODEL_ID,
  PDF_OCR_PROVIDER_ID,
  PDF_OCR_REGION,
  PDF_OCR_RETENTION_DAYS,
} from "@reformaflow/domain";
import { parseAnalyzeAttachmentRequest } from "../import-session.extraction.service";
import {
  PDF_OCR_CONSENT_DECISION,
  parseStoredPdfOcrState,
  pdfOcrConsentQuestionId,
  pdfOcrRequestPayloadHash,
  serializePdfOcrState,
  type StoredPdfOcrConsentV2,
} from "./pdf-ocr-state";

const request = {
  version: 2 as const,
  expectedRevision: 3,
  requestId: randomUUID(),
  consentExternalProcessing: true as const,
};
const consent = (): StoredPdfOcrConsentV2 => ({
  attachmentId: randomUUID(),
  artifactSha256: "a".repeat(64),
  requestId: request.requestId,
  requestPayloadHash: pdfOcrRequestPayloadHash(request),
  expectedRevision: request.expectedRevision,
  actorId: randomUUID(),
  consentPolicyVersion: PDF_OCR_CONSENT_POLICY_VERSION,
  consentDecision: PDF_OCR_CONSENT_DECISION,
  consentedAt: "2026-10-01T00:00:00.000Z",
  provider: PDF_OCR_PROVIDER_ID,
  model: PDF_OCR_MODEL_ID,
  purpose: PDF_OCR_CONSENT_PURPOSE,
  region: PDF_OCR_REGION,
  retentionDays: PDF_OCR_RETENTION_DAYS,
  sendsFullOriginal: true,
  includesMetadataAndEmbeddedContent: true,
  includesPotentiallyNonVisibleContent: true,
  usageId: null,
});

describe("OCR v2 request and retained consent state", () => {
  it("accepts only the four-field browser analyze envelope", () => {
    expect(parseAnalyzeAttachmentRequest(request)).toEqual(request);
    for (const body of [
      { ...request, actorId: randomUUID() },
      { ...request, tenantId: randomUUID() },
      { ...request, projectId: randomUUID() },
      { ...request, provider: PDF_OCR_PROVIDER_ID },
      { ...request, model: PDF_OCR_MODEL_ID },
      { ...request, region: PDF_OCR_REGION },
      { ...request, artifactSha256: "a".repeat(64) },
      { ...request, consentExternalProcessing: false },
    ])
      expect(() => parseAnalyzeAttachmentRequest(body)).toThrow();
  });

  it("stores only disclosure consent and an optional canonical ledger reference", () => {
    const declaration = consent();
    const parsed = parseStoredPdfOcrState(
      serializePdfOcrState({ version: 2, consents: [declaration] }),
    );
    expect(parsed.consents).toEqual([declaration]);
    expect(parsed.consents[0]).not.toHaveProperty("status");
    expect(parsed.consents[0]).not.toHaveProperty("usage");
    expect(parsed.consents[0]).not.toHaveProperty("responseId");
    expect(parsed.consents[0]).not.toHaveProperty("contentPurgedAt");
  });

  it("binds the disclosure question to the current artifact and revision", () => {
    const base = {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      revision: 2,
      attachmentId: randomUUID(),
      artifactSha256: "b".repeat(64),
    };
    expect(pdfOcrConsentQuestionId(base)).not.toBe(
      pdfOcrConsentQuestionId({ ...base, revision: 3 }),
    );
    expect(pdfOcrConsentQuestionId(base)).not.toBe(
      pdfOcrConsentQuestionId({ ...base, artifactSha256: "c".repeat(64) }),
    );
  });
});
