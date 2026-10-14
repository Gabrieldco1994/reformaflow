import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ImportOcrReviewEvidenceV1 } from "@reformaflow/domain";
import { describe, expect, it } from "vitest";
import { OcrCandidateEvidence } from "./OcrCandidateEvidence";

const evidence = (authTrace: ImportOcrReviewEvidenceV1["authTrace"]) => {
  const serverEvidence: ImportOcrReviewEvidenceV1 = {
    origin: "GOOGLE_VERTEX_AI",
    model: "gemini-2.5-flash",
    modelVersion: "provider-build-20261013",
    region: "southamerica-east1",
    authTrace,
    attachmentId: "attachment",
    artifactFingerprint: "a".repeat(64),
    candidateFingerprint: "b".repeat(64),
    pageNumber: 1,
    text: "MERCADO ORIGINAL",
  };
  return {
    ...serverEvidence,
    requestId: "request-must-not-render",
    responseId: "response-must-not-render",
    serviceAccountIdentity: "service-account-must-not-render",
    serviceAccountEmail: "identity-must-not-render@example.invalid",
    credentialPath: "/credentials/must-not-render.json",
    credentialEmail: "credential-email-must-not-render@example.invalid",
    credentialKey: "key-must-not-render",
    accessToken: "token-must-not-render",
  };
};

describe("OcrCandidateEvidence", () => {
  it.each([
    ["LOCAL_ADC", "credenciais padrão locais"],
    ["SERVICE_ACCOUNT_FILE_ADC", "arquivo de conta de serviço"],
  ] as const)(
    "renders server provenance for the %s authentication trace",
    (authTrace, authLabel) => {
      render(<OcrCandidateEvidence evidence={evidence(authTrace)} />);

      const note = screen.getByRole("note", {
        name: "Evidência da extração externa",
      });
      expect(note).toHaveTextContent(
        "Texto extraído para conferência: MERCADO ORIGINAL",
      );
      expect(note).toHaveTextContent("Origem: PDF original · GOOGLE_VERTEX_AI");
      expect(note).toHaveTextContent("Modelo configurado: gemini-2.5-flash");
      expect(note).toHaveTextContent(
        "Versão informada pelo provedor: provider-build-20261013",
      );
      expect(note).toHaveTextContent("Região: southamerica-east1");
      expect(note).toHaveTextContent(
        `Rastro de autenticação: ${authTrace} · ${authLabel}`,
      );
      expect(note).not.toHaveTextContent("request-must-not-render");
      expect(note).not.toHaveTextContent("response-must-not-render");
      expect(note).not.toHaveTextContent("service-account-must-not-render");
      expect(note).not.toHaveTextContent("identity-must-not-render");
      expect(note).not.toHaveTextContent("credentials/must-not-render");
      expect(note).not.toHaveTextContent("credential-email-must-not-render");
      expect(note).not.toHaveTextContent("key-must-not-render");
      expect(note).not.toHaveTextContent("token-must-not-render");
    },
  );
});
