import { describe, expect, it } from "vitest";
import {
  ImportWorkflowResponseError,
  readImportWorkflowView,
} from "./import-session-workflow-read";

const COMPLETE_CAPABILITY = {
  status: "AVAILABLE",
  consentPolicyVersion: 1,
  provider: "GOOGLE_VERTEX_AI",
  purpose: "DOCUMENT_LINE_TRANSCRIPTION_FOR_HUMAN_REVIEW",
  region: "southamerica-east1",
  retentionDays: 7,
  sendsFullOriginal: true,
  includesMetadataAndEmbeddedContent: true,
  includesPotentiallyNonVisibleContent: true,
  attachments: [],
  terminalOutcomes: [],
};

const line = (index: number) => ({
  id: `ocr-line-${index}`,
  observationIds: [`ocr-observation-${index}`],
  titulo: `Linha OCR ${index}`,
  fornecedor: null,
  tipoDespesa: null,
  categoriaMaoDeObra: null,
  amountMeaning: "UNKNOWN",
  amountCents: index === 0 ? -20_696 : index === 1 ? 0 : index === 2 ? null : 1,
  installmentCount: null,
  dataCompra: null,
  firstDueDate: null,
  targets: null,
  decision: { kind: "UNRESOLVED" },
  ocrEvidence: {
    origin: "GOOGLE_VERTEX_AI",
    model: "gemini-2.5-flash",
    modelVersion: "provider-build-20261013",
    region: "southamerica-east1",
    authTrace: index % 2 === 0 ? "LOCAL_ADC" : "SERVICE_ACCOUNT_FILE_ADC",
    attachmentId: "scan-attachment",
    artifactFingerprint: "a".repeat(64),
    candidateFingerprint: index.toString(16).padStart(64, "0"),
    pageNumber: (index % 10) + 1,
    text: `evidencia visivel ${index}`,
  },
});

const response = (ocrCapability: Record<string, unknown>) => ({
  version: 1,
  analysisOutcome: null,
  id: "private-session-id",
  ownerProjectId: "private-project-id",
  cardId: "private-card-id",
  state: "DRAFT",
  revision: 3,
  expiresAt: "2026-10-20T20:00:00.000Z",
  attachments: [
    {
      id: "scan-attachment",
      fileName: "fatura.pdf",
      declaredBytes: 1_024,
      state: "ATTACHED",
      materializedInSession: true,
      canAnalyze: false,
    },
  ],
  lines: Array.from({ length: 24 }, (_, index) => line(index)),
  selectedLineIds: [],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  ocrCapability,
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["RESOLVE", "CANCEL"],
});

describe("final #719 strict browser OCR envelope", () => {
  it("accepts the complete capability and preserves all 24 typed candidates", () => {
    const parsed = readImportWorkflowView(response(COMPLETE_CAPABILITY));

    expect(parsed.ocrCapability).toEqual(COMPLETE_CAPABILITY);
    expect(parsed.lines).toHaveLength(24);
    expect(
      parsed.lines.slice(0, 2).map((candidate) => ({
        modelVersion: candidate.ocrEvidence?.modelVersion,
        authTrace: candidate.ocrEvidence?.authTrace,
      })),
    ).toEqual([
      {
        modelVersion: "provider-build-20261013",
        authTrace: "LOCAL_ADC",
      },
      {
        modelVersion: "provider-build-20261013",
        authTrace: "SERVICE_ACCOUNT_FILE_ADC",
      },
    ]);
    expect(
      parsed.lines.slice(0, 3).map(({ amountMeaning, amountCents }) => ({
        amountMeaning,
        amountCents,
      })),
    ).toEqual([
      { amountMeaning: "UNKNOWN", amountCents: -20_696 },
      { amountMeaning: "UNKNOWN", amountCents: 0 },
      { amountMeaning: "UNKNOWN", amountCents: null },
    ]);
    expect(parsed.selectedLineIds).toEqual([]);
  });

  it.each([
    [
      "missing non-visible-content disclosure",
      (({ includesPotentiallyNonVisibleContent: _omitted, ...rest }) => rest)(
        COMPLETE_CAPABILITY,
      ),
    ],
    [
      "false non-visible-content disclosure",
      {
        ...COMPLETE_CAPABILITY,
        includesPotentiallyNonVisibleContent: false,
      },
    ],
    [
      "extra future disclosure",
      { ...COMPLETE_CAPABILITY, providerMayTrain: false },
    ],
  ])(
    "rejects %s instead of weakening the wire contract",
    (_label, envelope) => {
      expect(() => readImportWorkflowView(response(envelope))).toThrow(
        ImportWorkflowResponseError,
      );
    },
  );
});
