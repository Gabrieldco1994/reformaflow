"use client";

import { useId, useRef, useState } from "react";
import type { ImportWireErrorCode } from "../_lib/import-session-errors";
import type { OcrUiScope } from "../_types";

function OcrRequiredFoundation({
  scope,
  pending,
  attempted,
  errorMessage,
  onConsent,
}: {
  scope: OcrUiScope;
  pending: boolean;
  attempted: boolean;
  errorMessage?: string | null;
  onConsent: () => void;
}) {
  const consentId = useId();
  const [consented, setConsented] = useState(false);
  const submitted = useRef(false);

  return (
    <section
      aria-label="Leitura externa do documento"
      className="min-w-0 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-lifeone-ink"
    >
      <h3 className="font-semibold">Leitura externa opcional</h3>
      <p className="break-words">
        O arquivo “{scope.fileName}” precisa de leitura externa para continuar.
      </p>
      <div className="min-w-0 space-y-2 break-words">
        <p>
          Para ler este PDF, precisamos enviá-lo ao{" "}
          <strong>Google Cloud Vertex AI</strong>. O serviço externo será usado
          para extrair compras deste documento para sua revisão.
        </p>
        <p>
          Esta autorização de processamento externo v2 vale somente para este
          documento. Nenhum lançamento será criado ou confirmado por esta
          leitura.
        </p>
      </div>
      {!attempted && (
        <form
          className="min-w-0 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!consented || pending || submitted.current || !onConsent)
              return;
            submitted.current = true;
            onConsent();
          }}
        >
          <label
            htmlFor={consentId}
            className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-amber-400 bg-white p-3"
          >
            <input
              id={consentId}
              type="checkbox"
              checked={consented}
              disabled={pending || submitted.current}
              onChange={(event) => setConsented(event.currentTarget.checked)}
              className="h-5 w-5 shrink-0"
            />
            <span className="min-w-0 break-words">
              Autorizo o envio deste documento para processamento externo
            </span>
          </label>
          <button
            type="submit"
            disabled={!consented || pending || submitted.current}
            className="min-h-11 w-full rounded-xl border border-darc-linen bg-white px-3 font-semibold disabled:opacity-50"
          >
            {pending
              ? "Solicitando leitura externa…"
              : "Autorizar leitura externa"}
          </button>
        </form>
      )}
      {attempted && (
        <p role={errorMessage ? "alert" : "status"}>
          {errorMessage ??
            "A solicitação de leitura externa foi encerrada. Esta tela não fará uma segunda chamada para este documento."}
        </p>
      )}
      <p>
        Se a leitura externa não estiver disponível ou não terminar, use um PDF
        textual ou CSV, conforme os formatos oferecidos, ou cancele a
        importação. Não há nova tentativa de processamento externo nesta sessão.
      </p>
    </section>
  );
}

export function ImportOcrFoundation({
  triggerCode,
  scope,
  pending = false,
  attempted = false,
  errorMessage,
  onConsent,
}: {
  triggerCode: ImportWireErrorCode | null | undefined;
  scope: OcrUiScope;
  pending?: boolean;
  attempted?: boolean;
  errorMessage?: string | null;
  onConsent: () => void;
}) {
  if (triggerCode !== "OCR_REQUIRED") return null;
  return (
    <OcrRequiredFoundation
      key={scope.key}
      scope={scope}
      pending={pending}
      attempted={attempted}
      errorMessage={errorMessage}
      onConsent={onConsent}
    />
  );
}
