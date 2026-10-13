"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import type { ImportWireErrorCode } from "../_lib/import-session-errors";
import { useOcrReview, type OcrCandidateLoader } from "../_hooks/useOcrReview";
import type {
  OcrAvailability,
  OcrPreparedCandidate,
  OcrUiScope,
} from "../_types";
import { OcrCandidateReview } from "./OcrCandidateReview";

const OCR_DISABLED_COPY: Record<
  Extract<OcrAvailability, { state: "DISABLED" }>["reason"],
  string
> = {
  FEATURE_OFF:
    "OCR está desativado. Esta tela não enviará o arquivo nem fará novas tentativas.",
  PROVIDER_UNAVAILABLE:
    "O provedor de OCR está indisponível. Esta tela não repetirá a solicitação.",
  CONTRACT_PENDING:
    "A integração segura de OCR ainda não está pronta. Nenhum processamento externo será solicitado.",
};

function OcrRequiredFoundation({
  scope,
  availability,
  loadCandidates,
  onPrepare,
}: {
  scope: OcrUiScope;
  availability: OcrAvailability;
  loadCandidates?: OcrCandidateLoader;
  onPrepare?: (candidates: readonly OcrPreparedCandidate[]) => void;
}) {
  const consentId = useId();
  const ready = availability.state === "READY";
  const [consented, setConsented] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const review = useOcrReview({
    scopeKey: scope.key,
    enabled: ready,
    loadCandidates,
  });
  const previousPending = useRef(false);

  useEffect(() => {
    if (
      previousPending.current &&
      !review.pending &&
      review.candidates.length > 0
    )
      setDialogOpen(true);
    previousPending.current = review.pending;
  }, [review.candidates.length, review.pending]);

  const disabledCopy =
    availability.state === "DISABLED"
      ? OCR_DISABLED_COPY[availability.reason]
      : null;
  const disclosure = useMemo(
    () => (
      <>
        <p>
          Processamento externo: <strong>Google Cloud Vertex AI</strong>.
          Finalidade: extrair candidatos para revisão humana deste documento.
        </p>
        <p>
          Modelo: <strong>Gemini 2.5 Flash</strong>. Região:{" "}
          <strong>southamerica-east1 (São Paulo, Brasil)</strong>.
        </p>
        <p>
          O consentimento v2 vale somente para o documento atual nesta sessão.
          Conta, projeto, ator, sessão, hash do artefato, provedor, modelo,
          região e instante são vinculados e revalidados pelo servidor; esta
          tela não fornece autoridade para esses campos.
        </p>
      </>
    ),
    [],
  );

  return (
    <section
      aria-label="Opção de OCR"
      className="min-w-0 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-lifeone-ink"
    >
      <h3 className="font-semibold">Leitura externa opcional por OCR</h3>
      <p className="break-words">
        O arquivo “{scope.fileName}” precisa de OCR para produzir candidatos.
      </p>
      <div className="min-w-0 space-y-2 break-words">{disclosure}</div>
      <label
        htmlFor={consentId}
        className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-amber-400 bg-white p-3"
      >
        <input
          id={consentId}
          type="checkbox"
          checked={consented}
          disabled={!ready || review.pending}
          onChange={(event) => setConsented(event.currentTarget.checked)}
          className="h-5 w-5 shrink-0"
        />
        <span className="min-w-0 break-words">
          Autorizo o processamento externo deste documento conforme o
          consentimento v2
        </span>
      </label>
      {disabledCopy && <p role="status">{disabledCopy}</p>}
      <p>
        Enquanto o OCR estiver indisponível, use um PDF textual sem imagens ou
        CSV, conforme os formatos oferecidos, ou cancele a importação. Não há
        retry automático nem promessa de capacidade.
      </p>
      {ready && (
        <button
          type="button"
          disabled={
            !consented ||
            review.pending ||
            !loadCandidates ||
            (review.attempted && review.candidates.length === 0)
          }
          onClick={() =>
            review.candidates.length > 0
              ? setDialogOpen(true)
              : void review.start()
          }
          className="min-h-11 w-full rounded-xl border border-darc-linen bg-white px-3 font-semibold disabled:opacity-50"
        >
          {review.pending
            ? "Solicitando leitura por OCR…"
            : review.candidates.length > 0
              ? "Abrir revisão de OCR"
              : review.attempted
                ? "Solicitação de OCR encerrada"
                : "Solicitar leitura por OCR"}
        </button>
      )}
      {review.error && (
        <p role="alert">
          A leitura por OCR não foi concluída. Continue com PDF textual ou CSV,
          ou cancele; esta tela não fará nova tentativa.
        </p>
      )}
      <Modal
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Revisar candidatos de OCR"
        size="lg"
        trapFocus
        bounded
      >
        <OcrCandidateReview
          candidates={review.candidates}
          onPrepare={onPrepare}
        />
      </Modal>
    </section>
  );
}

export function ImportOcrFoundation({
  triggerCode,
  scope,
  availability,
  loadCandidates,
  onPrepare,
}: {
  triggerCode: ImportWireErrorCode | null | undefined;
  scope: OcrUiScope;
  availability: OcrAvailability;
  loadCandidates?: OcrCandidateLoader;
  onPrepare?: (candidates: readonly OcrPreparedCandidate[]) => void;
}) {
  if (triggerCode !== "OCR_REQUIRED") return null;
  return (
    <OcrRequiredFoundation
      key={scope.key}
      scope={scope}
      availability={availability}
      loadCandidates={loadCandidates}
      onPrepare={onPrepare}
    />
  );
}
