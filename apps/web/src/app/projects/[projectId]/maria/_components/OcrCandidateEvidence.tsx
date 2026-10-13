export function OcrCandidateEvidence({ text }: { text: string }) {
  return (
    <aside
      role="note"
      aria-label="Evidência da extração externa"
      className="min-w-0 space-y-1 rounded-xl border border-darc-linen bg-white p-3 text-sm"
    >
      <p className="break-words">
        <strong>Texto extraído para conferência:</strong> {text}
      </p>
      <p className="break-words">
        <strong>Origem:</strong> PDF original · Google Cloud Vertex AI · Gemini
        2.5 Flash · southamerica-east1.
      </p>
      <p>Revise no documento original antes de atestar ou selecionar.</p>
    </aside>
  );
}
