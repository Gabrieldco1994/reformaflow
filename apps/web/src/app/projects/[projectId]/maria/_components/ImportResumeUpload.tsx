"use client";

import type { ImportSessionViewV1 } from "@reformaflow/domain";
import type { ImportDocumentFlow } from "../_hooks/useImportDocumentFlow";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { importFormatLabel } from "../_lib/import-format";

/**
 * Retomada de UPLOAD após reload: o arquivo local se perdeu, mas o servidor
 * ainda autoriza `UPLOAD`. Reusa o formulário local de seleção + consentimento;
 * sem a ação `UPLOAD` no estado do servidor nada é oferecido.
 */
export function ImportResumeUpload({
  view,
  documents,
  disabled = false,
}: {
  view: ImportSessionViewV1;
  documents: Pick<
    ImportDocumentFlow,
    "canResume" | "hasAttempt" | "busy" | "error" | "resume"
  > &
    Partial<Pick<ImportDocumentFlow, "supportedFormats">>;
  disabled?: boolean;
}) {
  if (
    !view.actions.includes("UPLOAD") ||
    ["APPLIED", "CANCELLED", "EXPIRED"].includes(view.state) ||
    !documents.canResume ||
    documents.hasAttempt ||
    documents.error
  )
    return null;
  const formats = documents.supportedFormats ?? ["CSV"];
  if (!formats.length) return null;
  const label = importFormatLabel(formats);
  return (
    <section
      aria-label={`Reenviar arquivo (${label})`}
      className="min-w-0 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <h3 className="font-semibold">Reenviar arquivo ({label})</h3>
      <p>
        O arquivo deste envio não está mais neste dispositivo. Selecione {label}
        novamente e autorize a análise para continuar. Isso não confirma
        lançamentos.
      </p>
      <ImportLocalDocuments
        formats={formats}
        pending={documents.busy}
        disabled={disabled}
        onConsent={(files) => void documents.resume(files, formats)}
      />
    </section>
  );
}
