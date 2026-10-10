"use client";

import { useId, useRef, useState } from "react";
import {
  IMPORT_SESSION_LIMITS,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { Button } from "@/components/ui/button";
import journeyStyles from "@/components/import/ImportJourney.module.css";
import { useIntentFocus } from "../_hooks/useIntentFocus";
import {
  IMPORT_FORMAT_EXTENSIONS,
  importFormatLabel,
} from "../_lib/import-format";
import type { SupportedImportFormat } from "../_lib/import-entry-action";

export function ImportLocalDocuments({
  onConsent,
  pending = false,
  disabled = false,
  view,
  onAnalyze,
  onRecover,
  remoteError,
  formats,
  attempted,
}: {
  /** Local consent event only; the owner must supply any future transport and its outcome. */
  onConsent?: (files: readonly File[]) => void;
  pending?: boolean;
  disabled?: boolean;
  view?: Pick<ImportSessionViewV1, "attachments" | "actions">;
  onAnalyze?: (attachmentId?: string) => void;
  onRecover?: () => void;
  remoteError?: string | null;
  formats?: readonly SupportedImportFormat[];
  attempted?: boolean;
}) {
  const id = useId();
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const sent = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const { scope, request } = useIntentFocus<HTMLFormElement>();
  const consentLocked = attempted ?? consented;
  // Fail closed without a capability list; parser formats are not entry authority.
  const supportedFormats = formats ?? [];
  const blocked =
    pending || disabled || consentLocked || supportedFormats.length === 0;
  const accept = supportedFormats
    .map((format) => IMPORT_FORMAT_EXTENSIONS[format])
    .join(",");
  const formatLabel = importFormatLabel(supportedFormats);

  function selectFiles(selected: File[]) {
    if (blocked || sent.current || selected.length === 0) return;
    if (
      files.length + selected.length >
      IMPORT_SESSION_LIMITS.filesPerRequest
    ) {
      setError(
        `Selecione até ${IMPORT_SESSION_LIMITS.filesPerRequest} arquivos por vez. A seleção anterior foi mantida.`,
      );
      return;
    }
    for (const file of selected) {
      const extension = file.name
        .slice(file.name.lastIndexOf("."))
        .toLowerCase();
      if (!accept.split(",").includes(extension)) {
        setError(
          `Formato não suportado para seleção: ${file.name}. Use ${formatLabel}.`,
        );
        return;
      }
      if (file.size < 1 || file.size > IMPORT_SESSION_LIMITS.bytesPerFile) {
        setError(
          `O arquivo ${file.name} deve ter entre 1 e ${IMPORT_SESSION_LIMITS.bytesPerFile} bytes. A seleção anterior foi mantida.`,
        );
        return;
      }
    }
    setFiles((current) => [...current, ...selected]);
    setError(null);
  }

  function removeFile(index: number) {
    if (blocked || sent.current) return;
    request([
      files.length > 1
        ? `remove:${Math.min(index, files.length - 2)}`
        : "picker",
    ]);
    setFiles((current) => current.filter((_, position) => position !== index));
    setError(null);
  }

  if (view)
    return (
      <section
        aria-label="Documentos desta importação"
        aria-busy={pending}
        className="min-w-0 space-y-3 rounded-xl border border-darc-linen p-3 text-sm"
      >
        <h3 className="font-semibold">Documentos desta importação</h3>
        <p>Esta análise documental não cria despesas, pagamentos ou rateios.</p>
        {view.attachments.length === 0 && (
          <p>Nenhum documento nesta importação.</p>
        )}
        <ul className="space-y-3">
          {view.attachments.map((attachment) => (
            <li key={attachment.id} className="min-w-0 space-y-2 break-words">
              <p className="font-medium">{attachment.fileName}</p>
              <p>
                {attachment.materializedInSession
                  ? "Análise documental guardada nesta importação. Isso não confirma lançamentos."
                  : attachment.canAnalyze
                    ? "Documento pronto para análise documental."
                    : "Análise indisponível para este documento no recorte atual."}
              </p>
              {attachment.canAnalyze &&
                view.actions.includes("ANALYZE") &&
                onAnalyze && (
                  <button
                    type="button"
                    disabled={pending || disabled || Boolean(remoteError)}
                    aria-label={`Analisar documento: ${attachment.fileName}`}
                    onClick={() => onAnalyze(attachment.id)}
                    className="min-h-11 rounded-xl border px-3 focus-visible:outline focus-visible:outline-2"
                  >
                    Analisar documento
                  </button>
                )}
            </li>
          ))}
        </ul>
        {view.actions.includes("ANALYZE") &&
          view.attachments.filter((a) => a.canAnalyze).length > 1 &&
          onAnalyze && (
            <button
              type="button"
              disabled={pending || disabled || Boolean(remoteError)}
              onClick={() => onAnalyze()}
              className="min-h-11 rounded-xl border px-3"
            >
              Analisar documentos disponíveis
            </button>
          )}
        {remoteError && (
          <div role="alert" className="space-y-2 text-darc-red">
            <p>{remoteError}</p>
            {onRecover && (
              <button
                type="button"
                disabled={pending || disabled}
                onClick={onRecover}
                className="min-h-11 rounded-xl border px-3"
              >
                Consultar estado dos documentos
              </button>
            )}
          </div>
        )}
      </section>
    );

  return (
    <form
      ref={scope}
      aria-label="Documentos para análise"
      aria-busy={pending}
      className={`${journeyStyles.journey} space-y-4 rounded-xl border border-darc-linen bg-white p-4`}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || sent.current || !onConsent || files.length === 0) return;
        // Like ImportJourney, lock before React can render disabled controls.
        sent.current = true;
        setConsented(true);
        onConsent(files);
      }}
    >
      <h3 className="text-base font-semibold text-darc-velvet">
        Documentos para análise
      </h3>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-darc-velvet"
      >
        Selecionar arquivos
      </label>
      <input
        id={id}
        ref={input}
        data-focus-key="picker"
        type="file"
        multiple
        accept={accept}
        disabled={blocked}
        aria-describedby={`${id}-formats`}
        className="block w-full min-w-0 text-sm file:mr-2 file:min-h-11 file:rounded-lg file:border-0 file:bg-darc-linen file:px-3 file:text-darc-velvet"
        onChange={(event) => {
          selectFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <p id={`${id}-formats`} className="text-sm text-gray-600">
        {formatLabel}. Até {IMPORT_SESSION_LIMITS.filesPerRequest} arquivos,{" "}
        {IMPORT_SESSION_LIMITS.bytesPerFile} bytes por arquivo. A seleção não
        valida o conteúdo; a análise depende dos formatos habilitados.
      </p>
      {supportedFormats.includes("PDF") && (
        <p className="text-sm text-gray-600">
          PDF textual sem imagens; documentos com imagens podem exigir OCR,
          ainda indisponível. Isso inclui imagens como logotipos de bancos. Use
          um arquivo com texto e sem imagens ou cancele; nenhum lançamento será
          confirmado.
        </p>
      )}
      {files.length > 0 && (
        <ul aria-label="Arquivos selecionados" className="space-y-2">
          {files.map((file, index) => (
            <li key={index} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 break-words text-sm text-darc-velvet">
                {file.name}
              </span>
              <Button
                type="button"
                variant="ghost"
                data-focus-key={`remove:${index}`}
                aria-label={`Remover arquivo ${index + 1}: ${file.name}`}
                disabled={blocked}
                onClick={() => removeFile(index)}
              >
                Remover
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p role="status" className="text-sm text-darc-velvet">
        {consentLocked
          ? "Consentimento encaminhado. Isso não confirma que o rascunho foi guardado."
          : pending
            ? "Aguarde a etapa em andamento."
            : files.length > 0
              ? "Arquivo selecionado. Nada foi enviado."
              : "Nenhum arquivo selecionado."}
      </p>
      <p className="text-sm text-gray-600">
        Ao escolher Analisar e guardar rascunho, você autoriza o envio e
        processamento dos documentos para análise e armazenamento privado do
        rascunho. O conteúdo necessário poderá ser enviado ao modelo para
        análise. OCR não está disponível nesta importação. Não cria despesas,
        pagamentos ou rateios. O rascunho pendente e sua referência ao original
        expiram após 7 dias sem edição sua; consultas não renovam esse prazo.
      </p>
      {error && (
        <p role="alert" className="text-sm text-darc-red">
          {error}
        </p>
      )}
      {remoteError && (
        <div role="alert" className="space-y-2 text-sm text-darc-red">
          <p>{remoteError}</p>
          {onRecover && (
            <button
              type="button"
              disabled={pending}
              onClick={onRecover}
              className="min-h-11 rounded-xl border px-3"
            >
              Consultar estado dos documentos
            </button>
          )}
        </div>
      )}
      {!onConsent && (
        <p className="text-sm text-gray-600">
          Análise indisponível nesta etapa. A seleção permanece local.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={blocked || files.length === 0}
          onClick={() => {
            if (blocked || sent.current) return;
            request(["picker"]);
            setFiles([]);
            setError(null);
            if (input.current) input.current.value = "";
          }}
        >
          Cancelar seleção
        </Button>
        <Button
          type="submit"
          className="min-h-11"
          disabled={blocked || !onConsent || files.length === 0}
        >
          Analisar e guardar rascunho
        </Button>
      </div>
    </form>
  );
}
