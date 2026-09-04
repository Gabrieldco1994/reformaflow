"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { formatCurrency, formatDateBR } from "@/lib/utils";
import {
  CategoriaFonteChip,
  ImportClassificationNotice,
  type CategoriaFonte,
  type ImportClassificationStatus,
} from "@/components/import/ImportClassificationNotice";
import {
  DEBIT_CATEGORIES,
  categoryLabel,
} from "../_lib/import-categories";

interface Props {
  projectId: string;
  onClose: () => void;
  onCommitted: () => void;
}

type DocumentType = "bank" | "card";
type RowType = "DESPESA" | "RECEBIMENTO";
type RowStatus = "PAGO" | "PLANEJADO" | "EM_CAIXA" | "PREVISTO";

interface ApiPreviewRow {
  externalId: string;
  date?: string;
  data?: string;
  description?: string;
  descricao?: string;
  amountCents?: number;
  valorCents?: number;
  type?: string;
  tipo?: string;
  status?: string;
  duplicate?: boolean;
  ignored?: boolean;
  willImport?: boolean;
  categoriaFonte?: CategoriaFonte | null;
  suggestedCategory?: string | null;
}

interface ApiPreviewResult {
  error?: string;
  total?: number;
  totalAmountCents?: number;
  duplicated?: number;
  rows?: ApiPreviewRow[];
  preview?: ApiPreviewRow[];
  classificationStatus?: ImportClassificationStatus;
}

interface PreviewRow {
  externalId: string;
  date: string;
  description: string;
  amountCents: number;
  type: RowType;
  status: RowStatus;
  duplicate: boolean;
  ignored: boolean;
  categoriaFonte: CategoriaFonte | null;
  suggestedCategory: string | null;
}

interface PreviewResult {
  total: number;
  totalAmountCents: number;
  duplicated: number;
  rows: PreviewRow[];
  classificationStatus?: ImportClassificationStatus;
}

interface ApiCommitResult {
  error?: string;
  inserted?: number;
  count?: number;
  expensesInserted?: number;
  receiptsInserted?: number;
  failed?: number;
  skipped?: number;
  duplicated?: number;
  rulesLearned?: number;
  rulesSkippedNoMapping?: number;
  rulesLearnFailed?: number;
}

interface ImportDecision {
  externalId: string;
  overrides?: { category?: string };
}

const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_FILES =
  ".ofx,.csv,.txt,.pdf,.xlsx,.xls,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic";
const TYPE_LABELS: Record<RowType, string> = {
  DESPESA: "Despesa",
  RECEBIMENTO: "Recebimento",
};
const STATUS_LABELS: Record<RowStatus, string> = {
  PAGO: "Pago",
  PLANEJADO: "Planejado",
  EM_CAIXA: "Em caixa",
  PREVISTO: "Previsto",
};

function rowType(
  value: string | undefined,
  documentType: DocumentType,
  amount: number,
): RowType {
  const normalized = value?.toUpperCase();
  if (
    ["RECEBIMENTO", "RECEIPT", "CREDIT", "ENTRADA"].includes(normalized ?? "")
  ) {
    return "RECEBIMENTO";
  }
  if (["DESPESA", "EXPENSE", "DEBIT", "SAIDA"].includes(normalized ?? "")) {
    return "DESPESA";
  }
  return documentType === "bank" && amount < 0 ? "RECEBIMENTO" : "DESPESA";
}

function rowStatus(
  value: string | undefined,
  documentType: DocumentType,
  amount: number,
): RowStatus {
  const normalized = value?.toUpperCase() as RowStatus | undefined;
  if (normalized && normalized in STATUS_LABELS) return normalized;
  if (documentType === "card") return amount < 0 ? "PAGO" : "PLANEJADO";
  return amount < 0 ? "EM_CAIXA" : "PAGO";
}

function normalizePreview(
  result: ApiPreviewResult,
  documentType: DocumentType,
): PreviewResult {
  if (result.error) throw new Error(result.error);
  const sourceRows = result.rows ?? result.preview;
  if (!Array.isArray(sourceRows)) {
    throw new Error(
      "O servidor não retornou uma prévia válida. Tente novamente.",
    );
  }

  const rows = sourceRows.map((row): PreviewRow => {
    const date = row.date ?? row.data;
    const description = row.description ?? row.descricao;
    const amount = row.amountCents ?? row.valorCents;
    if (
      !row.externalId ||
      !date ||
      !description ||
      typeof amount !== "number" ||
      !Number.isFinite(amount)
    ) {
      throw new Error(
        "A prévia contém um lançamento incompleto. Tente outro arquivo.",
      );
    }
    return {
      externalId: row.externalId,
      date,
      description,
      amountCents: amount,
      type: rowType(row.type ?? row.tipo, documentType, amount),
      status: rowStatus(row.status, documentType, amount),
      duplicate: row.duplicate === true,
      ignored: row.ignored === true || row.willImport === false,
      categoriaFonte: row.categoriaFonte ?? null,
      suggestedCategory: row.suggestedCategory ?? null,
    };
  });

  if (rows.length === 0) {
    throw new Error(
      "Nenhum lançamento foi encontrado nos arquivos selecionados.",
    );
  }
  return {
    total: result.total ?? rows.length,
    totalAmountCents:
      result.totalAmountCents ??
      rows.reduce((sum, row) => sum + row.amountCents, 0),
    duplicated: result.duplicated ?? rows.filter((row) => row.duplicate).length,
    rows,
    classificationStatus: result.classificationStatus,
  };
}

function signedCurrency(amountCents: number) {
  const value = formatCurrency(Math.abs(amountCents) / 100);
  if (amountCents > 0) return `-${value}`;
  if (amountCents < 0) return `+${value}`;
  return value;
}

export default function ImportWithoutAccountModal({
  projectId,
  onClose,
  onCommitted,
}: Props) {
  const titleId = useId();
  const inputId = useId();
  const passwordId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const committedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedNotifiedRef = useRef(false);
  const [documentType, setDocumentType] = useState<DocumentType>("bank");
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [categoryOverrides, setCategoryOverrides] = useState<
    Record<string, string>
  >({});
  const [commitResult, setCommitResult] = useState<ApiCommitResult | null>(null);
  const [committedCount, setCommittedCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restorePreviousFocus = useCallback(() => {
    previousFocusRef.current?.focus();
  }, []);

  const notifyCommitted = useCallback(() => {
    if (committedNotifiedRef.current) return;
    committedNotifiedRef.current = true;
    if (committedTimerRef.current) {
      clearTimeout(committedTimerRef.current);
      committedTimerRef.current = null;
    }
    onCommitted();
  }, [onCommitted]);

  const handleClose = useCallback(() => {
    if (loading) return;
    restorePreviousFocus();
    if (committedCount !== null) {
      notifyCommitted();
    } else {
      onClose();
    }
  }, [committedCount, loading, notifyCommitted, onClose, restorePreviousFocus]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButtonRef.current?.focus();

    return () => {
      if (committedTimerRef.current) {
        clearTimeout(committedTimerRef.current);
      }
      restorePreviousFocus();
    };
  }, [restorePreviousFocus]);

  useEffect(() => {
    if (committedCount !== null) {
      successHeadingRef.current?.focus();
    }
  }, [committedCount]);

  // Sempre que a prévia é descartada (novo arquivo, troca de tipo, senha),
  // zera as correções de categoria e o último resultado de commit.
  useEffect(() => {
    if (preview === null) {
      setCategoryOverrides({});
      setCommitResult(null);
    }
  }, [preview]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape") {
        if (!loading) {
          event.preventDefault();
          handleClose();
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === first || !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last || !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleClose, loading]);

  const isPdf = files.some(
    (file) =>
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf"),
  );

  function url(mode: "preview" | "commit") {
    const query = new URLSearchParams({
      origin: "none",
      documentType,
      source: "AUTO",
      mode,
    });
    if (password) query.set("password", password);
    return `/projects/${projectId}/receipts/import?${query.toString()}`;
  }

  function formData() {
    const data = new FormData();
    files.forEach((file) => data.append("files", file));
    return data;
  }

  function commitFormData() {
    const data = formData();
    const decisions: ImportDecision[] = Object.entries(categoryOverrides)
      .filter(([, category]) => !!category)
      .map(([externalId, category]) => ({
        externalId,
        overrides: { category },
      }));
    if (decisions.length > 0) {
      data.append("decisions", JSON.stringify(decisions));
    }
    return data;
  }

  function showImportError(caught: unknown, fallback: string) {
    const message = caught instanceof Error ? caught.message : fallback;
    if (
      /pdf_wrong_password|wrong password|senha.{0,30}(incorret|inválid|errad)/i.test(
        message,
      )
    ) {
      setNeedsPassword(true);
      setError("Senha do PDF incorreta. Tente novamente.");
      return;
    }
    if (
      /pdf_password_required|password.{0,20}required|pdf.{0,30}(proteg|senha)|senha/i.test(
        message,
      )
    ) {
      setNeedsPassword(true);
      setError(
        /pdf_password_required/i.test(message)
          ? "Este PDF está protegido. Informe a senha e tente novamente."
          : message,
      );
      return;
    }
    setError(message);
  }

  async function handlePreview() {
    if (!files.length) {
      setError("Selecione ao menos um arquivo para importar.");
      return;
    }
    setError(null);
    setPreview(null);
    setLoading(true);
    try {
      const result = await api.upload<ApiPreviewResult>(
        url("preview"),
        formData(),
      );
      setPreview(normalizePreview(result, documentType));
      setNeedsPassword(false);
    } catch (caught) {
      showImportError(caught, "Não foi possível ler os arquivos.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCommit() {
    if (!files.length || !preview) return;
    setError(null);
    setLoading(true);
    try {
      const result = await api.upload<ApiCommitResult>(
        url("commit"),
        commitFormData(),
      );
      if (result.error) throw new Error(result.error);
      setCommitResult(result);
      const inserted =
        result.inserted ??
        result.count ??
        (result.expensesInserted ?? 0) + (result.receiptsInserted ?? 0);
      const failed = result.failed ?? 0;
      if (failed > 0) {
        setCommittedCount(null);
        setError(
          `Importação parcial: ${inserted} lançamento(s) importado(s) e ${failed} com falha. Tente novamente para concluir os pendentes.`,
        );
        return;
      }

      setCommittedCount(inserted);
      if (!committedNotifiedRef.current && committedTimerRef.current === null) {
        committedTimerRef.current = setTimeout(notifyCommitted, 1500);
      }
    } catch (caught) {
      showImportError(caught, "Não foi possível concluir a importação.");
    } finally {
      setLoading(false);
    }
  }

  function handleFilesChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    setPreview(null);
    setCommittedCount(null);
    committedNotifiedRef.current = false;
    if (committedTimerRef.current) {
      clearTimeout(committedTimerRef.current);
      committedTimerRef.current = null;
    }
    setPassword("");
    setNeedsPassword(false);
    setError(null);
    if (selected.length > MAX_FILES) {
      setFiles([]);
      event.currentTarget.value = "";
      setError(`Selecione no máximo ${MAX_FILES} arquivos por vez.`);
      return;
    }
    const oversized = selected.find((file) => file.size > MAX_FILE_SIZE);
    if (oversized) {
      setFiles([]);
      event.currentTarget.value = "";
      setError(`“${oversized.name}” excede o limite de 10 MiB.`);
      return;
    }
    setFiles(selected);
  }

  function selectDocumentType(value: DocumentType) {
    setDocumentType(value);
    setPreview(null);
    setCommittedCount(null);
    committedNotifiedRef.current = false;
    if (committedTimerRef.current) {
      clearTimeout(committedTimerRef.current);
      committedTimerRef.current = null;
    }
    setPassword("");
    setNeedsPassword(false);
    setError(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={loading}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 sm:p-6">
        {committedCount !== null ? (
          <div className="py-6 text-center" aria-live="polite">
            <h2
              id={titleId}
              ref={successHeadingRef}
              tabIndex={-1}
              className="mb-2 text-lg font-bold text-green-700 outline-none"
            >
              Importação concluída!
            </h2>
            <p className="text-sm text-gray-600">
              {committedCount} lançamento(s) importado(s) sem conta. Você poderá
              vincular uma conta depois.
            </p>
            {!!commitResult?.rulesLearned && (
              <p className="mt-2 text-sm text-gray-600">
                <strong>{commitResult.rulesLearned}</strong> correção(ões)
                viraram regra para o futuro
              </p>
            )}
            {!!commitResult?.rulesSkippedNoMapping && (
              <p className="mt-2 text-sm text-gray-500">
                <strong>{commitResult.rulesSkippedNoMapping}</strong>{" "}
                correção(ões) foram aplicadas à linha, mas não viraram regra:
                esse tipo não tem categoria equivalente.
              </p>
            )}
            {!!commitResult?.rulesLearnFailed && (
              <p className="mt-2 text-sm text-amber-700">
                A importação foi concluída, mas não foi possível salvar{" "}
                <strong>{commitResult.rulesLearnFailed}</strong> regra(s).
                Recategorize essas linhas para tentar de novo — a importação em
                si não falhou.
              </p>
            )}
          </div>
        ) : (
          <>
            <header className="mb-4 flex items-center justify-between gap-3">
              <h2 id={titleId} className="text-lg font-bold">
                Importar sem conta
              </h2>
              <button
                type="button"
                onClick={handleClose}
                disabled={loading}
                aria-label="Fechar"
                ref={closeButtonRef}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <p className="mb-4 text-sm text-gray-600">
              Importe para a Carteira sem vincular uma conta ou cartão agora.
            </p>

            <fieldset className="mb-4">
              <legend className="mb-2 text-sm font-medium text-gray-700">
                Tipo de documento
              </legend>
              <div className="flex gap-2">
                {(
                  [
                    ["bank", "Extrato bancário"],
                    ["card", "Fatura de cartão"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => selectDocumentType(value)}
                    disabled={loading}
                    aria-pressed={documentType === value}
                    className={`min-h-11 flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                      documentType === value
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-gray-300 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="mb-4">
              <label
                htmlFor={inputId}
                className="mb-2 block text-sm font-medium text-gray-700"
              >
                Arquivos
              </label>
              <input
                id={inputId}
                type="file"
                multiple
                accept={ACCEPTED_FILES}
                onChange={handleFilesChange}
                disabled={loading}
                className="min-h-11 w-full rounded-lg border border-gray-300 p-2 text-sm text-gray-700 file:mr-2 file:rounded file:border-0 file:bg-blue-50 file:p-2 file:text-blue-700"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                Até 5 arquivos de 10 MiB cada: OFX, CSV, TXT, PDF, XLSX/XLS ou
                imagem.
              </p>
            </div>

            {(isPdf || needsPassword) && (
              <div className="mb-4">
                <label
                  htmlFor={passwordId}
                  className="mb-2 block text-sm font-medium text-gray-700"
                >
                  Senha do PDF{" "}
                  {!needsPassword && (
                    <span className="font-normal text-gray-500">
                      (se houver)
                    </span>
                  )}
                </label>
                <input
                  id={passwordId}
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.currentTarget.value);
                    setPreview(null);
                    setCommittedCount(null);
                    setError(null);
                  }}
                  disabled={loading}
                  autoComplete="off"
                  className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"
                />
              </div>
            )}

            {preview && (
              <section className="mb-4">
                <h3 className="mb-2 text-sm font-medium text-gray-700">
                  Conferência: {preview.total} lançamento(s) ·{" "}
                  {formatCurrency(preview.totalAmountCents / 100)}
                  {preview.duplicated
                    ? ` · ${preview.duplicated} duplicado(s)`
                    : ""}
                </h3>
                <ImportClassificationNotice
                  status={preview.classificationStatus}
                />
                <ul className="max-h-[42dvh] divide-y overflow-y-auto rounded-lg border">
                  {preview.rows.map((row) => {
                    const isExpense = row.type === "DESPESA";
                    const overridden =
                      categoryOverrides[row.externalId] !== undefined;
                    const suggested = row.suggestedCategory ?? "OUTROS";
                    const selected =
                      categoryOverrides[row.externalId] ?? suggested;
                    const knownValues = new Set(
                      DEBIT_CATEGORIES.map((c) => c.value),
                    );
                    const showDynamicOption =
                      !!selected && !knownValues.has(selected);
                    return (
                      <li
                        key={row.externalId}
                        className="flex items-start justify-between gap-3 px-3 py-3"
                      >
                        <div className="min-w-0">
                          <p
                            className="truncate text-sm font-medium text-gray-800"
                            title={row.description}
                          >
                            {row.description}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            {formatDateBR(row.date)} · {TYPE_LABELS[row.type]} ·{" "}
                            {STATUS_LABELS[row.status]}
                          </p>
                          {(row.duplicate || row.ignored) && (
                            <p className="mt-1 flex gap-2 text-xs font-medium">
                              {row.duplicate && (
                                <span className="text-amber-700">Duplicado</span>
                              )}
                              {row.ignored && (
                                <span className="text-gray-600">Ignorado</span>
                              )}
                            </p>
                          )}
                          {isExpense && !row.ignored && !row.duplicate && (
                            <div className="mt-2 flex flex-col">
                              <select
                                aria-label={`Categoria de ${row.description}`}
                                value={selected}
                                disabled={loading}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  setCategoryOverrides((prev) => ({
                                    ...prev,
                                    [row.externalId]: value,
                                  }));
                                }}
                                className="min-h-11 w-fit max-w-full rounded border border-gray-300 px-2 py-1 text-sm"
                              >
                                {showDynamicOption && (
                                  <option value={selected}>
                                    {categoryLabel(selected)}
                                  </option>
                                )}
                                {DEBIT_CATEGORIES.map((c) => (
                                  <option key={c.value} value={c.value}>
                                    {c.label}
                                  </option>
                                ))}
                              </select>
                              {!overridden && (
                                <CategoriaFonteChip fonte={row.categoriaFonte} />
                              )}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 whitespace-nowrap text-[15px] font-semibold">
                          {signedCurrency(row.amountCents)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {error && (
              <div
                className="mb-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3"
                role="alert"
              >
                <AlertCircle
                  className="h-5 w-5 shrink-0 text-red-600"
                  aria-hidden="true"
                />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
            <p className="sr-only" role="status" aria-live="polite">
              {loading
                ? preview
                  ? "Importando lançamentos."
                  : "Processando arquivos."
                : ""}
            </p>

            <footer className="flex flex-col-reverse gap-2 border-t pt-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={handleClose}
                disabled={loading}
                className="min-h-11 rounded-lg bg-gray-100 px-4 py-2 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={preview ? handleCommit : handlePreview}
                disabled={loading || !files.length}
                className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {loading && (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {loading
                  ? preview
                    ? "Importando…"
                    : "Processando…"
                  : preview
                    ? "Confirmar importação"
                    : "Conferir arquivos"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
