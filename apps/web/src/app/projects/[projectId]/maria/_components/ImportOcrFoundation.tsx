"use client";

import { useId, useRef, useState } from "react";
import type { OcrTerminalUiState, OcrUiScope, OcrUiState } from "../_types";

const TERMINAL_COPY: Record<OcrTerminalUiState, string> = {
  OCR_UNAVAILABLE:
    "A falha aconteceu antes de o PDF ser enviado. Use entrada manual, substitua o documento ou cancele a importação.",
  OCR_SAFETY_BLOCKED:
    "O provedor bloqueou a leitura deste documento por segurança. Nenhum lançamento foi criado; use entrada manual, substitua o documento ou cancele a importação.",
  OCR_MALFORMED_RESPONSE:
    "O provedor devolveu uma leitura inválida. Nenhum lançamento foi criado; use entrada manual, substitua o documento ou cancele a importação.",
  OCR_ATTEMPT_UNKNOWN:
    "O envio começou ou pode ter ocorrido, e o PDF pode ter sido enviado ao Google Cloud Vertex AI, mas não foi possível confirmar o resultado do OCR. Esta tentativa não pode ser repetida. Nenhum lançamento foi criado; use entrada manual, substitua o documento ou cancele a importação.",
  OCR_BUDGET_EXHAUSTED:
    "O limite diário de OCR foi atingido antes do envio. Use entrada manual, substitua o documento ou cancele a importação.",
  LIMIT_EXCEEDED:
    "A leitura excedeu um limite permitido e não pode continuar para este documento. Nenhum lançamento foi criado; use entrada manual, substitua o documento ou cancele a importação.",
  DOCUMENT_UNREADABLE:
    "Não foi possível ler este documento. Substitua por um arquivo legível ou cancele a importação.",
  PDF_PASSWORD_REQUIRED:
    "Este PDF está protegido por senha. Substitua por uma cópia sem senha ou cancele a importação. Não envie sua senha à Maria.",
  UNSUPPORTED_DOCUMENT: "Um dos documentos desta importação não é suportado.",
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
      <p className="break-words">Arquivo para análise: “{scope.fileName}”.</p>
      <div className="min-w-0 space-y-2 break-words">
        <p>
          Se este arquivo for um PDF totalmente digitalizado, formado apenas por
          imagens e sem texto pesquisável, ele poderá usar leitura externa nesta
          primeira versão. PDFs textuais continuam locais; PDFs mistos ou
          pesquisáveis não são enviados nesta versão.
        </p>
        <p>
          Se você autorizar, o <strong>PDF original completo</strong>, incluindo
          seus <strong>metadados</strong> e qualquer conteúdo potencialmente não
          visível ou incorporado, será enviado ao{" "}
          <strong>Google Cloud Vertex AI</strong>, modelo{" "}
          <strong>Gemini 2.5 Flash</strong>, na região{" "}
          <strong>southamerica-east1</strong>, exclusivamente para a transcrição
          das linhas do documento para revisão humana, não para classificação
          financeira. Todo esse conteúdo enviado externamente, assim como o
          resultado e a evidência da leitura externa, fica retido externamente
          por no máximo sete dias corridos contados da tentativa,
          independentemente de edições ou prorrogações da sessão. Esta versão
          não cria uma derivada raster local para substituir esse envio.
        </p>
        <p>
          Separadamente, o PDF original privado armazenado no ReformaFlow segue
          a política de retenção local da sessão e do cofre privado (vault): ele
          pode ser liberado antes ao concluir ou cancelar, quando não houver
          outra referência autorizada. Essa retenção local não reinicia nem
          estende o prazo máximo de sete dias da retenção externa. A auditoria
          mínima de consentimento e provedor permanece conforme a política
          aplicável.
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
            Autorizo o envio do PDF original completo, incluindo metadados e
            conteúdo potencialmente não visível ou incorporado, para o
            processamento externo descrito acima
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
    state.kind !== "CONSENT_REQUIRED" &&
    state.kind !== "CONSENTED_READY" &&
    state.kind !== "REQUESTING"
      ? TERMINAL_COPY[state.kind]
      : null;

  return (
    <section
      aria-label="Leitura externa do documento"
      className="min-w-0 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-lifeone-ink"
    >
      <h3 className="font-semibold">Leitura externa do PDF</h3>
      {state.kind !== "CONSENT_REQUIRED" && (
        <p className="break-words">Arquivo: “{scope.fileName}”.</p>
      )}
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
      {state.kind === "CONSENTED_READY" && (
        <>
          <p>
            A autorização deste documento já foi guardada. A leitura externa só
            continuará quando você solicitar.
          </p>
          <button
            type="button"
            onClick={onConsent}
            className="min-h-11 w-full rounded-xl border border-darc-linen bg-white px-3 font-semibold"
          >
            Continuar leitura externa
          </button>
        </>
      )}
      {terminal && <p role="alert">{terminal}</p>}
      {state.kind !== "REQUESTING" && state.kind !== "CONSENTED_READY" && (
        <FallbackChoices />
      )}
    </section>
  );
}
