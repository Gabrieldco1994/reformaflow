"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { usePageInert } from "@/components/ui/use-page-inert";
import { useOverlayLock } from "@/components/ui/use-overlay-lock";
import { formatCurrency, formatDateBR } from "@/lib/utils";
import {
  CategoriaFonteChip,
  ImportClassificationNotice,
  type CategoriaFonte,
  type ImportClassificationStatus,
} from "@/components/import/ImportClassificationNotice";
import {
  PossibleDuplicateNotice,
  type PossibleDuplicateInfo,
} from "@/components/import/PossibleDuplicateNotice";
import { DEBIT_CATEGORIES, categoryLabel } from "../_lib/import-categories";
import { Button } from "@/components/ui/button";
import {
  ImportJourney,
  ImportFilters,
  ImportReviewRow,
  ImportFooter,
  ImportWarnings,
  useImportJourney,
  reviewStatus,
  matchesReviewFilter,
  importFailureMessage,
  importWasRejected,
  IMPORT_STEPS,
  isImportResultRecord,
  isImportCount,
  UNKNOWN_IMPORT_RESULT,
} from "@/components/import/ImportJourney";

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
  possibleDuplicate?: PossibleDuplicateInfo | null;
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
  possibleDuplicate: PossibleDuplicateInfo | null;
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
  postCommitWarnings?: Array<{ code: string; message: string }>;
  error?: string;
  inserted?: number;
  count?: number;
  expensesInserted?: number;
  receiptsInserted?: number;
  failed?: number;
  skipped?: number;
  duplicated?: number;
  possibleDuplicates?: PossibleDuplicateInfo[];
  rulesLearned?: number;
  rulesSkippedNoMapping?: number;
  rulesLearnFailed?: number;
}

function isWalletCommitResult(value: unknown): value is ApiCommitResult {
  const counts = ["inserted", "count", "expensesInserted", "receiptsInserted"];
  return (
    isImportResultRecord(value) &&
    counts.some((key) => isImportCount(value[key])) &&
    [
      ...counts,
      "failed",
      "skipped",
      "duplicated",
      "rulesLearned",
      "rulesSkippedNoMapping",
      "rulesLearnFailed",
    ].every((key) => value[key] === undefined || isImportCount(value[key]))
  );
}

interface ImportDecision {
  externalId: string;
  // 'import' (#659) força criar uma linha marcada `possibleDuplicate` (Tier B).
  action?: "import";
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
    const possibleDuplicate = row.possibleDuplicate ?? null;
    return {
      externalId: row.externalId,
      date,
      description,
      amountCents: amount,
      type: rowType(row.type ?? row.tipo, documentType, amount),
      status: rowStatus(row.status, documentType, amount),
      duplicate: row.duplicate === true,
      possibleDuplicate,
      // `willImport === false` cobre Tier A e Tier B; só é "Ignorado" o que não
      // for nenhum dos dois (linha que o servidor descarta por outro motivo).
      ignored:
        row.ignored === true ||
        (row.willImport === false &&
          row.duplicate !== true &&
          !possibleDuplicate),
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
  const flow = useImportJourney<{ category?: string; optedIn: boolean }>();
  const titleId = useId();
  const inputId = useId();
  const passwordId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const committedNotifiedRef = useRef(false);
  const [documentType, setDocumentType] = useState<DocumentType>("bank");
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [categoryOverrides, setCategoryOverrides] = useState<
    Record<string, string>
  >({});
  // #659 Tier B: linhas "possível duplicata" que o usuário marcou "importar
  // mesmo assim". Zerado sempre que a prévia é descartada (novo arquivo, troca
  // de tipo, senha) — nunca reaproveitado entre prévias.
  const [duplicateOptIn, setDuplicateOptIn] = useState<Record<string, boolean>>(
    {},
  );
  const [commitResult, setCommitResult] = useState<ApiCommitResult | null>(
    null,
  );
  const [committedCount, setCommittedCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // #659 F3: portaliza para <body> e isola o fundo. Portal (vs inline) porque o
  // modal é montado dentro do launcher/picker — inertizar um ancestral que
  // contém o próprio dialog é proibido; como sibling de <body> podemos inertizar
  // todos os outros filhos de <body> sem tocar num ancestral do dialog.
  const [portalEl] = useState<HTMLDivElement | null>(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );
  useEffect(() => {
    if (!portalEl) return;
    portalEl.setAttribute("data-carteira-import-portal", "");
    document.body.appendChild(portalEl);
    return () => {
      document.body.removeChild(portalEl);
    };
  }, [portalEl]);
  usePageInert(true, portalEl);
  // #659: este modal nunca passava pelo contador compartilhado de
  // useOverlayLock (usado por Modal/VoiceAssistantOverlay) — o painel da
  // jornada (`data-journey-panel`, z-[70]) não tinha como saber que um
  // overlay de tela cheia estava aberto e ficava flutuando por cima do
  // importador. `data-overlay-open` no <body> é o sinal que o CSS já espera.
  useOverlayLock(true);

  const restorePreviousFocus = useCallback(() => {
    previousFocusRef.current?.focus();
  }, []);

  const notifyCommitted = useCallback(() => {
    if (committedNotifiedRef.current) return;
    committedNotifiedRef.current = true;
    onCommitted();
  }, [onCommitted]);

  const handleClose = useCallback(() => {
    if (loading) return;
    flow.requestClose(!!preview, () => {
      restorePreviousFocus();
      onClose();
    });
  }, [flow, preview, loading, onClose, restorePreviousFocus]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButtonRef.current?.focus();

    return () => {
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
      setDuplicateOptIn({});
      setCommitResult(null);
    }
  }, [preview]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!loading) {
          // #659 F3: impede que um handler de Escape "de fora" (ex.: o
          // AppShell fecha o overlay de lançamento inteiro no mobile) dispare
          // junto — Escape aqui fecha só este modal e volta ao seletor.
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
    const byId = new Map<string, ImportDecision>();
    for (const [externalId, category] of Object.entries(categoryOverrides)) {
      if (category)
        byId.set(externalId, { externalId, overrides: { category } });
    }
    // #659 Tier B: só a escolha explícita ("importar mesmo assim") manda
    // `action:'import'` — sem ela o servidor não cria a linha.
    for (const [externalId, on] of Object.entries(duplicateOptIn)) {
      if (!on) continue;
      byId.set(externalId, {
        ...byId.get(externalId),
        externalId,
        action: "import",
      });
    }
    const decisions = [...byId.values()];
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
    if (flow.sending.current) return;
    if (preview) {
      flow.setStage("review");
      return;
    }
    if (!files.length) {
      setError("Selecione ao menos um arquivo para importar.");
      return;
    }
    flow.sending.current = true;
    setError(null);
    setPreview(null);
    setLoading(true);
    try {
      const result = await api.upload<ApiPreviewResult>(
        url("preview"),
        formData(),
      );
      setPreview(normalizePreview(result, documentType));
      flow.setStage("review");
      setNeedsPassword(false);
    } catch (caught) {
      showImportError(caught, "Não foi possível ler os arquivos.");
    } finally {
      flow.sending.current = false;
      setLoading(false);
    }
  }

  async function handleCommit() {
    if (
      !files.length ||
      !preview ||
      flow.sending.current ||
      flow.uncertain ||
      flow.stage !== "summary"
    )
      return;
    flow.sending.current = true;
    setError(null);
    setLoading(true);
    try {
      const result = await api.upload<ApiCommitResult>(
        url("commit"),
        commitFormData(),
      );
      if (!isWalletCommitResult(result)) throw new Error(UNKNOWN_IMPORT_RESULT);
      if (result.error) throw new Error(result.error);
      setCommitResult(result);
      const inserted =
        result.inserted ??
        result.count ??
        (result.expensesInserted ?? 0) + (result.receiptsInserted ?? 0);
      const failed = result.failed ?? 0;
      if (failed > 0) {
        setError(
          `Importação parcial: ${inserted} lançamento(s) importado(s) e ${failed} com falha. Confira os lançamentos antes de importar os pendentes em outro lote.`,
        );
      }

      setCommittedCount(inserted);
      flow.setStage("result");
    } catch (caught) {
      const rejected = importWasRejected(caught);
      flow.setUncertain(!rejected);
      setError(importFailureMessage(caught));
    } finally {
      flow.sending.current = false;
      setLoading(false);
    }
  }

  function handleFilesChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    setPreview(null);
    setCommittedCount(null);
    committedNotifiedRef.current = false;
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
    if (value === documentType) return;
    if (
      preview &&
      !window.confirm("Trocar o documento descarta a revisão atual. Continuar?")
    )
      return;
    setDocumentType(value);
    setPreview(null);
    setCommittedCount(null);
    committedNotifiedRef.current = false;
    setPassword("");
    setNeedsPassword(false);
    setError(null);
  }

  const statusOf = (row: PreviewRow) =>
    reviewStatus(
      row,
      duplicateOptIn[row.externalId] ? { action: "import" } : undefined,
    );
  const includedRows =
    preview?.rows.filter(
      (row) => !matchesReviewFilter(statusOf(row), "excluded"),
    ) ?? [];
  const includedTotal = includedRows.reduce(
    (sum, row) => sum + row.amountCents,
    0,
  );

  const dialog = (
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
        <ImportJourney
          stage={flow.stage}
          origin="Carteira · sem conta ou cartão"
          files={files}
        >
          {committedCount !== null ? (
            <div className="py-6 text-center" aria-live="polite">
              <h2
                id={titleId}
                ref={successHeadingRef}
                tabIndex={-1}
                className="mb-2 text-lg font-bold text-green-700 outline-none"
              >
                {commitResult?.failed
                  ? "Importação parcial"
                  : "Importação concluída!"}
              </h2>
              <p className="text-sm text-gray-600">
                {committedCount} lançamento(s) importado(s) sem conta. Você
                poderá vincular uma conta depois.
              </p>
              {error && (
                <p role="alert" className="my-3 text-sm text-amber-800">
                  {error}
                </p>
              )}
              <ImportWarnings warnings={commitResult?.postCommitWarnings} />
              {!!commitResult?.duplicated && (
                <p>{commitResult.duplicated} duplicado(s) não importado(s).</p>
              )}
              {!!commitResult?.skipped && (
                <p>{commitResult.skipped} ignorado(s).</p>
              )}
              {!!commitResult?.possibleDuplicates?.length && (
                <p className="mt-2 text-sm text-orange-700">
                  <strong>{commitResult.possibleDuplicates.length}</strong>{" "}
                  possível(is) duplicata(s) não importada(s) — marque “Importar
                  mesmo assim” para incluí-las.
                </p>
              )}
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
                  Recategorize essas linhas para tentar de novo — a importação
                  em si não falhou.
                </p>
              )}
              <button
                type="button"
                onClick={notifyCommitted}
                className="mt-4 min-h-11 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              >
                Concluir
              </button>
            </div>
          ) : (
            <>
              <header className="sticky top-0 z-10 mb-4 flex items-center justify-between gap-3 bg-white py-2">
                <h2 id={titleId} className="text-lg font-bold">
                  Importar sem conta · {IMPORT_STEPS[flow.stage]}
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
              <h3
                ref={flow.headingRef}
                tabIndex={-1}
                className="mb-3 text-lg font-medium text-darc-velvet"
              >
                {flow.editor
                  ? "Revisão · editar lançamento"
                  : IMPORT_STEPS[flow.stage]}
              </h3>
              {flow.stage === "file" && (
                <>
                  <p className="mb-4 text-sm text-gray-600">
                    Importe para a Carteira sem vincular uma conta ou cartão
                    agora.
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
                      onClick={(event) => {
                        if (
                          preview &&
                          !window.confirm(
                            "Trocar arquivos descarta a revisão atual. Continuar?",
                          )
                        )
                          event.preventDefault();
                      }}
                      multiple
                      accept={ACCEPTED_FILES}
                      onChange={handleFilesChange}
                      disabled={loading}
                      className="min-h-11 w-full rounded-lg border border-gray-300 p-2 text-sm text-gray-700 file:mr-2 file:rounded file:border-0 file:bg-blue-50 file:p-2 file:text-blue-700"
                    />
                    <p className="mt-1.5 text-xs text-gray-500">
                      Até 5 arquivos de 10 MiB cada: OFX, CSV, TXT, PDF,
                      XLSX/XLS ou imagem.
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
                          if (
                            preview &&
                            !window.confirm(
                              "Trocar a senha descarta a revisão atual. Continuar?",
                            )
                          )
                            return;
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
                </>
              )}

              {preview && flow.stage !== "file" && (
                <section className="mb-4">
                  <h3 className="mb-2 text-sm font-medium text-gray-700">
                    Conferência: {includedRows.length} lançamento(s) a importar
                    · <strong>{formatCurrency(includedTotal / 100)}</strong>
                    {preview.duplicated
                      ? ` · ${preview.duplicated} duplicado(s)`
                      : ""}
                    {(() => {
                      const n = preview.rows.filter(
                        (r) => r.possibleDuplicate,
                      ).length;
                      return n ? ` · ${n} possível(is) duplicata(s)` : "";
                    })()}
                  </h3>
                  <ImportClassificationNotice
                    status={preview.classificationStatus}
                  />
                  {flow.stage === "summary" ? (
                    <p className="text-sm text-gray-600">
                      Origem: Carteira.{" "}
                      {preview.rows.length - includedRows.length} lançamento(s)
                      não serão importados. Débitos e créditos acima consideram
                      somente as linhas selecionadas.
                    </p>
                  ) : !flow.editor ? (
                    <>
                      <ImportFilters
                        statuses={preview.rows.map(statusOf)}
                        value={flow.filter}
                        onChange={flow.setFilter}
                      />
                      {preview.rows
                        .filter((row) =>
                          matchesReviewFilter(statusOf(row), flow.filter),
                        )
                        .map((row) => (
                          <ImportReviewRow
                            key={row.externalId}
                            title={row.description}
                            date={row.date}
                            fonte={
                              categoryOverrides[row.externalId] === undefined
                                ? row.categoriaFonte
                                : null
                            }
                            amountCents={-row.amountCents}
                            purpose={categoryLabel(
                              categoryOverrides[row.externalId] ??
                                row.suggestedCategory ??
                                "OUTROS",
                            )}
                            status={statusOf(row)}
                            onEdit={() =>
                              flow.openEditor(row.externalId, {
                                category: categoryOverrides[row.externalId],
                                optedIn:
                                  duplicateOptIn[row.externalId] === true,
                              })
                            }
                            buttonRef={(node) => {
                              if (node)
                                flow.rows.current.set(row.externalId, node);
                              else flow.rows.current.delete(row.externalId);
                            }}
                          />
                        ))}
                    </>
                  ) : (
                    <ul className="max-h-[42dvh] divide-y overflow-y-auto rounded-lg border">
                      {preview.rows
                        .filter((row) => row.externalId === flow.editor?.id)
                        .map((row) => {
                          const isExpense = row.type === "DESPESA";
                          const optedIn = flow.editor!.draft.optedIn;
                          const overridden =
                            flow.editor!.draft.category !== undefined;
                          const suggested = row.suggestedCategory ?? "OUTROS";
                          const selected =
                            flow.editor!.draft.category ?? suggested;
                          const knownValues = new Set(
                            DEBIT_CATEGORIES.map((c) => c.value),
                          );
                          const showDynamicOption =
                            !!selected && !knownValues.has(selected);
                          return (
                            <li
                              key={row.externalId}
                              className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
                            >
                              <div className="min-w-0">
                                <p
                                  className="truncate text-sm font-medium text-gray-800"
                                  title={row.description}
                                >
                                  {row.description}
                                </p>
                                <p className="mt-1 text-xs text-gray-500">
                                  {formatDateBR(row.date)} ·{" "}
                                  {TYPE_LABELS[row.type]} ·{" "}
                                  {STATUS_LABELS[row.status]}
                                </p>
                                {(row.duplicate || row.ignored) && (
                                  <p className="mt-1 flex gap-2 text-xs font-medium">
                                    {row.duplicate && (
                                      <span className="text-amber-700">
                                        Duplicado
                                      </span>
                                    )}
                                    {row.ignored && (
                                      <span className="text-gray-600">
                                        Ignorado
                                      </span>
                                    )}
                                  </p>
                                )}
                                {row.possibleDuplicate &&
                                  !row.duplicate &&
                                  !row.ignored && (
                                    <PossibleDuplicateNotice
                                      info={row.possibleDuplicate}
                                      optedIn={optedIn}
                                      onToggle={(next) =>
                                        flow.updateDraft({
                                          ...flow.editor!.draft,
                                          optedIn: next,
                                        })
                                      }
                                    />
                                  )}
                                {isExpense &&
                                  !row.ignored &&
                                  !row.duplicate &&
                                  (!row.possibleDuplicate || optedIn) && (
                                    <div className="mt-2 flex flex-col">
                                      <select
                                        aria-label={`Categoria de ${row.description}`}
                                        value={selected}
                                        disabled={loading}
                                        onChange={(event) => {
                                          const value =
                                            event.currentTarget.value;
                                          flow.updateDraft({
                                            ...flow.editor!.draft,
                                            category: value,
                                          });
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
                                        <CategoriaFonteChip
                                          fonte={row.categoriaFonte}
                                        />
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
                  )}
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

              <ImportFooter>
                {flow.stage !== "file" && !flow.editor && (
                  <Button
                    variant="ghost"
                    disabled={loading}
                    onClick={() =>
                      flow.setStage(
                        flow.stage === "summary" ? "review" : "file",
                      )
                    }
                  >
                    Voltar
                  </Button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={loading}
                  className="min-h-11 rounded-lg bg-gray-100 px-4 py-2 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                >
                  {flow.editor ? "Cancelar edição" : "Cancelar"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (flow.editor) {
                      const { id, draft } = flow.editor;
                      setCategoryOverrides((current) => {
                        const next = { ...current };
                        if (draft.category === undefined) delete next[id];
                        else next[id] = draft.category;
                        return next;
                      });
                      setDuplicateOptIn((current) => ({
                        ...current,
                        [id]: draft.optedIn,
                      }));
                      flow.finishEditor();
                    } else if (flow.stage === "file") void handlePreview();
                    else if (flow.stage === "summary") void handleCommit();
                    else flow.setStage("summary");
                  }}
                  disabled={
                    loading ||
                    flow.uncertain ||
                    !files.length ||
                    (flow.stage !== "file" &&
                      !flow.editor &&
                      includedRows.length === 0)
                  }
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
                    : flow.editor
                      ? "Aplicar à revisão"
                      : flow.stage === "summary"
                        ? "Confirmar importação"
                        : flow.stage === "review"
                          ? "Ver resumo"
                          : preview
                            ? "Continuar revisão"
                            : "Conferir arquivos"}
                </button>
              </ImportFooter>
            </>
          )}
        </ImportJourney>
      </div>
    </div>
  );

  return portalEl ? createPortal(dialog, portalEl) : dialog;
}
