"use client";

import { useId, useRef, useState } from "react";
import type { OcrTerminalUiState, OcrUiScope, OcrUiState } from "../_types";

const TERMINAL_COPY: Record<OcrTerminalUiState, string> = {
  PRE_CALL_UNAVAILABLE:
    "Leitura externa indisponível antes do envio. O PDF não foi enviado ao provedor.",
  DOCUMENT_UNSAFE:
    "Este documento não é seguro ou legível para a leitura externa desta versão.",
  SAFETY_OR_MALFORMED:
    "A resposta foi bloqueada por segurança ou veio fora do formato seguro. Nenhum candidato foi aceito.",
  BUDGET_OR_RATE_LIMIT:
    "A leitura externa parou por limite de uso ou orçamento. Nenhum candidato foi aceito.",
  ATTEMPT_UNKNOWN:
    "A chamada externa foi iniciada, mas o resultado é desconhecido. Para evitar processamento duplicado, não faremos outra chamada externa para este documento.",
};

function FallbackChoices() {
  return (
    <div className="space-y-2 rounded-xl border border-darc-linen bg-white p-3">
      <p className="font-semibold">Opções sem leitura externa</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Entrada manual:</strong> cancele esta importação e registre a
          compra pela tela Despesas.
        </li>
        <li>
          <strong>Substituir o arquivo:</strong> cancele e inicie outra
          importação com PDF textual ou CSV.
        </li>
        <li>
          <strong>Cancelar:</strong> encerre esta sessão sem confirmar
          lançamentos.
        </li>
      </ul>
      <p>
        <strong>Zero registros financeiros foram criados.</strong> Qualquer
        lançamento exige revisão humana e a confirmação financeira separada.
      </p>
    </div>
  );
}

function ConsentDisclosure({
  scope,
  onConsent,
}: {
  scope: OcrUiScope;
  onConsent: () => void;
}) {
  const consentId = useId();
  const [consented, setConsented] = useState(false);
  const submitted = useRef(false);

  return (
    <>
      <p className="break-words">
        O arquivo “{scope.fileName}” foi identificado como um PDF totalmente
        digitalizado, sem texto pesquisável.
      </p>
      <div className="min-w-0 space-y-2 break-words">
        <p>
          Nesta primeira versão, somente PDFs totalmente digitalizados, formados
          apenas por imagens, podem usar leitura externa. PDFs textuais
          continuam locais; PDFs mistos ou pesquisáveis não são enviados nesta
          versão.
        </p>
        <p>
          Se você autorizar, o <strong>PDF original completo</strong> será
          enviado ao <strong>Google Cloud Vertex AI</strong>, modelo{" "}
          <strong>Gemini 2.5 Flash</strong>, na região{" "}
          <strong>southamerica-east1</strong>, exclusivamente para extrair
          transações para este rascunho.
        </p>
        <p>
          O resultado e sua evidência ficam no rascunho privado por até sete
          dias sem edição. O original privado segue a mesma retenção enquanto a
          sessão estiver pendente e é liberado ao concluir ou cancelar quando
          não houver outra referência autorizada. O registro mínimo de
          consentimento e provedor segue a política de auditoria.
        </p>
        <p>
          Todo candidato exige revisão humana. A leitura e a correção do
          rascunho não criam registros financeiros: nenhum registro financeiro
          existe antes da confirmação separada do lote.
        </p>
      </div>
      <form
        className="min-w-0 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!consented || submitted.current) return;
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
            disabled={submitted.current}
            onChange={(event) => setConsented(event.currentTarget.checked)}
            className="h-5 w-5 shrink-0"
          />
          <span className="min-w-0 break-words">
            Autorizo o envio do PDF original completo para o processamento
            externo descrito acima
          </span>
        </label>
        <button
          type="submit"
          disabled={!consented || submitted.current}
          className="min-h-11 w-full rounded-xl border border-darc-linen bg-white px-3 font-semibold disabled:opacity-50"
        >
          Autorizar leitura externa
        </button>
      </form>
    </>
  );
}

export function ImportOcrFoundation({
  state,
  scope,
  onConsent,
}: {
  state: OcrUiState | null;
  scope: OcrUiScope;
  onConsent: () => void;
}) {
  if (!state) return null;
  const terminal =
    state.kind !== "CONSENT_REQUIRED" && state.kind !== "REQUESTING"
      ? TERMINAL_COPY[state.kind]
      : null;

  return (
    <section
      aria-label="Leitura externa do documento"
      className="min-w-0 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-lifeone-ink"
    >
      <h3 className="font-semibold">Leitura externa do PDF</h3>
      {state.kind === "CONSENT_REQUIRED" && (
        <ConsentDisclosure
          key={scope.key}
          scope={scope}
          onConsent={onConsent}
        />
      )}
      {state.kind === "REQUESTING" && (
        <p role="status">
          Leitura externa solicitada. Aguarde; esta tela não iniciará outra
          chamada para o documento.
        </p>
      )}
      {terminal && <p role="alert">{terminal}</p>}
      {state.kind !== "REQUESTING" && <FallbackChoices />}
    </section>
  );
}
