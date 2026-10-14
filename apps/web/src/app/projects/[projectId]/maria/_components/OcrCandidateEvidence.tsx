import type { ImportOcrReviewEvidenceV1 } from "@reformaflow/domain";

const AUTH_TRACE_LABELS: Record<
  ImportOcrReviewEvidenceV1["authTrace"],
  string
> = {
  LOCAL_ADC: "credenciais padrão locais",
  SERVICE_ACCOUNT_FILE_ADC: "arquivo de conta de serviço",
};

export function OcrCandidateEvidence({
  evidence,
}: {
  evidence: ImportOcrReviewEvidenceV1;
}) {
  return (
    <aside
      role="note"
      aria-label="Evidência da extração externa"
      className="min-w-0 space-y-1 rounded-xl border border-darc-linen bg-white p-3 text-sm"
    >
      <p className="break-words">
        <strong>Texto extraído para conferência:</strong> {evidence.text}
      </p>
      <p className="break-words">
        <strong>Origem:</strong> PDF original · {evidence.origin}
      </p>
      <p className="break-words">
        <strong>Modelo configurado:</strong> {evidence.model}
      </p>
      <p className="break-words">
        <strong>Versão informada pelo provedor:</strong> {evidence.modelVersion}
      </p>
      <p className="break-words">
        <strong>Região:</strong> {evidence.region}
      </p>
      <p className="break-words">
        <strong>Rastro de autenticação:</strong> {evidence.authTrace} ·{" "}
        {AUTH_TRACE_LABELS[evidence.authTrace]}
      </p>
      <p>Revise no documento original antes de atestar ou selecionar.</p>
    </aside>
  );
}
