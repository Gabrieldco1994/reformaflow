import type { ImportOcrReviewEvidenceV1 } from "@reformaflow/domain";

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
        <strong>Origem:</strong> PDF original · {evidence.origin} ·{" "}
        {evidence.model} · {evidence.region}.
      </p>
      <p>Revise no documento original antes de atestar ou selecionar.</p>
    </aside>
  );
}
