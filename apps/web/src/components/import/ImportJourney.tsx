"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDateBR } from "@/lib/utils";
import styles from "./ImportJourney.module.css";
import {
  CategoriaFonteChip,
  type CategoriaFonte,
} from "./ImportClassificationNotice";

export const IMPORT_STEPS = {
  file: "Arquivo e origem",
  review: "Revisão",
  summary: "Resumo",
  result: "Resultado",
} as const;
export type ImportStage = keyof typeof IMPORT_STEPS;
export type ReviewFilter = "all" | "pending" | "excluded";
const FILTERS = {
  all: "Todos",
  pending: "Pendências",
  excluded: "Não importados",
} as const;
export type ReviewStatus =
  | "ready"
  | "pending"
  | "excluded"
  | "duplicate"
  | "forced"
  | "linked"
  | "newTarget";
const STATUS_LABELS: Record<ReviewStatus, string> = {
  ready: "Pronto para importar",
  pending: "Possível duplicata · não será importado",
  excluded: "Não será importado",
  duplicate: "Já importado · será ignorado",
  forced: "Possível duplicata · importar mesmo assim",
  linked: "Associar existente",
  newTarget: "Novo destino · rascunho",
};

export function reviewStatus(
  row: { duplicate?: boolean; ignored?: boolean; possibleDuplicate?: unknown },
  decision?: { action?: string; newTarget?: unknown },
): ReviewStatus {
  if (row.duplicate) return "duplicate";
  if (row.ignored || decision?.action === "skip") return "excluded";
  if (row.possibleDuplicate && decision?.action !== "import") return "pending";
  if (row.possibleDuplicate) return "forced";
  if (decision?.newTarget) return "newTarget";
  return decision?.action === "link" ? "linked" : "ready";
}

export function matchesReviewFilter(
  status: ReviewStatus,
  filter: ReviewFilter,
) {
  return (
    filter === "all" ||
    (filter === "pending"
      ? status === "pending"
      : status === "excluded" || status === "duplicate" || status === "pending")
  );
}

export function useImportJourney<T>() {
  const [stage, setStage] = useState<ImportStage>("file");
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [editor, setEditor] = useState<{
    id: string;
    initial: T;
    draft: T;
  } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const returnRow = useRef<string | null>(null);
  // A ref locks same-tick double clicks, before React renders disabled controls.
  const sending = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const editorId = editor?.id;

  useEffect(() => {
    if (returnRow.current && !editorId) {
      (rows.current.get(returnRow.current) ?? headingRef.current)?.focus();
      returnRow.current = null;
    } else {
      headingRef.current?.focus();
    }
  }, [stage, editorId]);

  function finishEditor() {
    returnRow.current = editor?.id ?? null;
    setEditor(null);
  }
  function cancelEditor() {
    if (
      editor &&
      JSON.stringify(editor.initial) !== JSON.stringify(editor.draft) &&
      !window.confirm(
        "Descartar as alterações desta linha? A revisão do lote será preservada.",
      )
    )
      return;
    finishEditor();
  }
  function requestClose(hasDraft: boolean, onClose: () => void) {
    if (sending.current || stage === "result") return;
    if (editor) {
      cancelEditor();
      return;
    }
    if (
      hasDraft &&
      !window.confirm(
        "Descartar esta revisão? Os arquivos e rascunhos não serão guardados.",
      )
    )
      return;
    onClose();
  }
  return {
    stage,
    setStage,
    filter,
    setFilter,
    editor,
    headingRef,
    rows,
    sending,
    uncertain,
    setUncertain,
    openEditor: (id: string, draft: T) =>
      setEditor({ id, initial: draft, draft }),
    updateDraft: (draft: T) =>
      setEditor((current) => (current ? { ...current, draft } : current)),
    finishEditor,
    cancelEditor,
    requestClose,
  };
}

export function ImportJourney({
  stage,
  origin,
  files,
  children,
}: {
  stage: ImportStage;
  origin: string;
  files: File[];
  children: ReactNode;
}) {
  return (
    <div className={styles.journey}>
      <div className={styles.context}>
        <p className="text-sm font-medium text-darc-velvet break-words">
          Origem: {origin}
        </p>
        {files.length > 0 && (
          <p className="text-xs text-gray-500 break-words">
            {files.map((file) => file.name).join(" · ")}
          </p>
        )}
        <ol
          aria-label="Etapas da importação"
          className="grid grid-cols-4 gap-2 mt-3 text-xs"
        >
          {(Object.entries(IMPORT_STEPS) as [ImportStage, string][]).map(
            ([key, label], index) => (
              <li
                key={key}
                aria-current={stage === key ? "step" : undefined}
                className={
                  stage === key
                    ? "font-semibold text-darc-red"
                    : "text-gray-500"
                }
              >
                {index + 1}. {label}
              </li>
            ),
          )}
        </ol>
      </div>
      {children}
    </div>
  );
}

export function ImportFilters({
  statuses,
  value,
  onChange,
}: {
  statuses: ReviewStatus[];
  value: ReviewFilter;
  onChange: (value: ReviewFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 my-3" aria-label="Filtrar revisão">
      {(Object.entries(FILTERS) as [ReviewFilter, string][]).map(
        ([filter, label]) => (
          <Button
            key={filter}
            variant={filter === value ? "secondary" : "ghost"}
            aria-pressed={filter === value}
            onClick={() => onChange(filter)}
          >
            {label} (
            {
              statuses.filter((status) => matchesReviewFilter(status, filter))
                .length
            }
            )
          </Button>
        ),
      )}
    </div>
  );
}

/** MovimentacaoRow anatomy, without inventing persisted account-view IDs/actions for drafts. */
export function ImportReviewRow({
  title,
  date,
  amountCents,
  purpose,
  status,
  onEdit,
  buttonRef,
  fonte,
}: {
  title: string;
  date: string;
  amountCents: number;
  purpose: string;
  status: ReviewStatus;
  onEdit: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
  fonte?: CategoriaFonte | null;
}) {
  return (
    <div className={styles.row}>
      <div className="min-w-0">
        <p className="font-medium text-darc-velvet break-words">{title}</p>
        <p className="text-xs text-gray-500">
          {formatDateBR(date)} · {STATUS_LABELS[status]}
        </p>
        <p className="text-sm text-gray-600 break-words">
          Finalidade: {purpose}
        </p>
        <CategoriaFonteChip fonte={fonte} />
      </div>
      <strong className={styles.money}>
        {formatCurrency(amountCents / 100)}
      </strong>
      <Button
        ref={buttonRef}
        variant="ghost"
        onClick={onEdit}
        aria-label={`Revisar ${title}`}
      >
        Revisar
      </Button>
    </div>
  );
}

export function ImportFooter({ children }: { children: ReactNode }) {
  return <footer className={styles.footer}>{children}</footer>;
}

export function ImportWarnings({
  warnings,
}: {
  warnings?: { code: string; message: string }[];
}) {
  if (!warnings?.length) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="font-medium">Importação concluída com avisos</p>
      <ul>
        {warnings.map((warning, i) => (
          <li key={`${warning.code}-${i}`}>{warning.message}</li>
        ))}
      </ul>
    </div>
  );
}

export const UNKNOWN_IMPORT_RESULT =
  "Não foi possível confirmar o resultado com o servidor. A importação pode ter sido concluída. Confira os lançamentos e o histórico disponível antes de iniciar outra importação; não reenvie este lote agora.";

export function importWasRejected(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ApiResponseError" &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
  );
}

export function importFailureMessage(error: unknown): string {
  if (!importWasRejected(error)) return UNKNOWN_IMPORT_RESULT;
  const message = (error as Error).message;
  return message === "INLINE_TARGET_INVALID"
    ? "Revise o projeto, a categoria e o valor integral do destino antes de confirmar novamente."
    : message;
}
