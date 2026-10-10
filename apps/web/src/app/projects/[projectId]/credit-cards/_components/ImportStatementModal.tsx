"use client";

import { useId, useMemo, useState } from "react";
import { api, ApiResponseError } from "@/lib/api";
import {
  CARD_IMPORT_LINE_OUTCOME,
  CARD_IMPORT_SELECTED_ROWS_CHANGED,
  type CardImportLineOutcome,
  type CardImportReviewItem,
} from "@reformaflow/domain";
import { formatCurrency, formatDateBR } from "@/lib/utils";
import {
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import type {
  CardRow,
  PreviewResult,
  CommitResult,
  PreviewTx,
} from "../_types";
import { PreviewTxRow } from "./PreviewTxRow";
import { AttemptsHistory, PendingSummary } from "./ImportAttemptsPanel";
import {
  SELECTED_ROWS_CHANGED_COPY,
  hasReviewConsent,
  isBlockedReview,
  isFinalOutcome,
  isLineResultList,
  type ImportAttempt,
} from "../_lib/import-review";
import { ImportClassificationNotice } from "@/components/import/ImportClassificationNotice";
import { tipoLabel } from "@/lib/expense-options";
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
  isStatementCommitResult,
  isImportCount,
  UNKNOWN_IMPORT_RESULT,
} from "@/components/import/ImportJourney";

interface Props {
  projectId: string;
  card: CardRow;
  onClose: () => void;
  onCommitted: () => void;
}

export interface ImportDecision {
  externalId: string;
  // 'import' (#659) força uma linha marcada `possibleDuplicate` (Tier B) a ser criada.
  action?: "create" | "skip" | "link" | "import";
  linkToExpenseId?: string;
  /** #714: consentimento de REVIEW, válido só com `action:'import'` e o fingerprint que o usuário viu. */
  reviewFingerprint?: string;
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;
  };
}

export interface TxState {
  decision?: ImportDecision;
}

function isSelectedRowsChanged(error: unknown) {
  return (
    error instanceof ApiResponseError &&
    error.status === 409 &&
    typeof error.body === "object" &&
    error.body !== null &&
    (error.body as { code?: unknown }).code === CARD_IMPORT_SELECTED_ROWS_CHANGED
  );
}

export default function ImportStatementModal({
  projectId,
  card,
  onClose,
  onCommitted,
}: Props) {
  const flow = useImportJourney<TxState>();
  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState("AUTO");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStates, setTxStates] = useState<Record<string, TxState>>({});
  // Snapshot da auto-detecção do backend (match único de cross-project) no
  // momento em que a prévia carregou. Usado por `clearDecision` para "limpar
  // decisão" voltar à sugestão automática em vez de apagar tudo (issue #572).
  const [autoTxStates, setAutoTxStates] = useState<Record<string, TxState>>({});
  const [showFuture, setShowFuture] = useState(false);
  // #714: resumos por tentativa (nunca somados) e estado por linha vindo de `lineResults`.
  const [attempts, setAttempts] = useState<ImportAttempt[]>([]);
  const [lineStates, setLineStates] = useState<
    Record<string, { outcome: CardImportLineOutcome; linked?: true }>
  >({});
  const [reviewOverrides, setReviewOverrides] = useState<
    Record<string, CardImportReviewItem>
  >({});
  const [staleDocument, setStaleDocument] = useState(false);

  const isPdf = files.some(
    (f) =>
      f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf",
  );

  const lines = useMemo(
    () =>
      (preview?.preview ?? []).map((tx) =>
        reviewOverrides[tx.externalId]
          ? { ...tx, review: reviewOverrides[tx.externalId] }
          : tx,
      ),
    [preview, reviewOverrides],
  );
  const finalIds = (id: string) => isFinalOutcome(lineStates[id]?.outcome);

  function resetLineWork() {
    setTxStates({});
    setAutoTxStates({});
    setLineStates({});
    setReviewOverrides({});
  }

  function buildUrl(mode: "preview" | "commit") {
    const params = new URLSearchParams({ source, mode });
    if (password) params.set("password", password);
    return `/projects/${projectId}/credit-cards/${card.id}/import-statement?${params.toString()}`;
  }

  async function handlePreview() {
    if (flow.sending.current) return;
    if (preview) {
      flow.setStage("review");
      return;
    }
    if (files.length === 0) {
      setError("Selecione um arquivo");
      return;
    }
    flow.sending.current = true;
    setError(null);
    setLoading(true);
    setPreview(null);
    resetLineWork();
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const res = await api.upload<PreviewResult>(buildUrl("preview"), fd);
      setPreview(res);
      flow.setStage("review");
      // Auto-marca matches únicos como "linked" por padrão (quando houver exatamente 1 match com delta=0)
      const auto: Record<string, TxState> = {};
      for (const tx of res.preview ?? []) {
        // Tier B (#659): nunca auto-vincular uma linha que o servidor marcou
        // como possível duplicata — auto-link cria + quita planejado, e fazer
        // isso em silêncio numa linha talvez-já-existente é o risco de dobra.
        // Pagamento de fatura (`ignored`) nunca é auto-vinculado nem importado.
        if (tx.duplicate || tx.ignored || tx.possibleDuplicate || tx.review) continue;
        const matches = tx.crossProjectMatches ?? [];
        if (matches.length === 1 && Math.abs(matches[0].deltaCents) < 100) {
          auto[tx.externalId] = {
            decision: {
              externalId: tx.externalId,
              action: "link",
              linkToExpenseId: matches[0].expenseId,
            },
          };
        }
      }
      setTxStates(auto);
      setAutoTxStates(auto);
      setNeedsPassword(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro no preview";
      if (/pdf_wrong_password|incorreta/i.test(msg)) {
        setNeedsPassword(true);
        setError("Senha incorreta. Tente novamente.");
      } else if (/pdf_password_required|senha/i.test(msg)) {
        setNeedsPassword(true);
        setError("Este PDF está protegido. Informe a senha e tente novamente.");
      } else {
        setError(msg);
      }
    } finally {
      flow.sending.current = false;
      setLoading(false);
    }
  }

  async function handleCommit() {
    if (
      files.length === 0 ||
      !preview ||
      flow.sending.current ||
      flow.uncertain ||
      flow.stage !== "summary"
    )
      return;
    const selection = buildSelection();
    if (selection.ids.length === 0) return;
    flow.sending.current = true;
    setLoading(true);
    setError(null);
    setStaleDocument(false);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      fd.append("decisions", JSON.stringify(selection.decisions));
      // Toda tentativa diz explicitamente o que o usuário confirmou; o
      // servidor não completa a seleção por conta própria.
      fd.append("selectedExternalIds", JSON.stringify(selection.ids));
      const res = await api.upload<CommitResult>(buildUrl("commit"), fd);
      if (
        !isStatementCommitResult(res) ||
        !isImportCount(res.settled) ||
        (res.lineResults !== undefined && !isLineResultList(res.lineResults))
      ) {
        throw new Error(UNKNOWN_IMPORT_RESULT);
      }
      absorbCommit(res);
      setCommitResult(res);
      flow.setStage("result");
    } catch (e) {
      if (isSelectedRowsChanged(e)) {
        // 409 com zero efeitos: exige nova prévia manual, sem reextrair sozinho.
        flow.setUncertain(false);
        setStaleDocument(true);
        setError(SELECTED_ROWS_CHANGED_COPY);
      } else {
        const rejected = importWasRejected(e);
        flow.setUncertain(!rejected);
        setError(importFailureMessage(e));
      }
    } finally {
      flow.sending.current = false;
      setLoading(false);
    }
  }

  /** Só entra na tentativa o que está pronto ou foi confirmado/excluído de forma explícita. */
  function buildSelection() {
    const ids: string[] = [];
    for (const tx of lines) {
      // `ignored` antes do Tier B: a marca de "importar mesmo assim" não o resgata.
      if (tx.duplicate || tx.ignored || finalIds(tx.externalId)) continue;
      const d = txStates[tx.externalId]?.decision;
      const skipped = d?.action === "skip";
      const ok = tx.review
        ? skipped ||
          (!isBlockedReview(tx.review) && hasReviewConsent(tx.review, d))
        : tx.possibleDuplicate
          ? skipped || d?.action === "import"
          : true;
      if (ok) ids.push(tx.externalId);
    }
    const chosen = new Set(ids);
    const decisions = Object.values(txStates)
      .map((s) => s.decision)
      .filter(
        (d): d is ImportDecision =>
          !!d && chosen.has(d.externalId) && (!!d.action || !!d.overrides),
      );
    return { ids, decisions };
  }

  function absorbCommit(res: CommitResult) {
    const results = isLineResultList(res.lineResults) ? res.lineResults : [];
    const byId = new Map(lines.map((tx) => [tx.externalId, tx]));
    setLineStates((prev) => {
      const next = { ...prev };
      for (const r of results) {
        const cur = next[r.externalId];
        if (isFinalOutcome(cur?.outcome)) continue;
        if (r.outcome === CARD_IMPORT_LINE_OUTCOME.NOT_SELECTED && cur) continue;
        next[r.externalId] = {
          outcome: r.outcome,
          ...(r.linked ? { linked: true as const } : {}),
        };
      }
      return next;
    });
    const items = res.reviewRequired ?? [];
    if (items.length > 0) {
      // O consentimento é validado contra o fingerprint atual (`hasReviewConsent`):
      // o aceite dado a outro fingerprint deixa de valer sem precisar apagá-lo.
      setReviewOverrides((prev) => ({
        ...prev,
        ...Object.fromEntries(items.map((i) => [i.externalId, i])),
      }));
    }
    setAttempts((prev) => [
      ...prev,
      {
        number: prev.length + 1,
        importId: res.importId,
        periodLabel: res.periodLabel,
        inserted: res.inserted,
        settled: res.settled,
        duplicated: res.duplicated,
        skipped: res.skipped ?? 0,
        linked: res.linked ?? 0,
        notSelected: res.notSelected ?? 0,
        lines: results
          .filter((r) => r.outcome !== CARD_IMPORT_LINE_OUTCOME.NOT_SELECTED)
          .map((r) => {
            const tx = byId.get(r.externalId);
            const o = txStates[r.externalId]?.decision?.overrides;
            return {
              externalId: r.externalId,
              title: o?.titulo ?? tx?.merchant ?? r.externalId,
              amountCents: o?.valorCents ?? tx?.amountCents ?? 0,
              outcome: r.outcome,
              ...(r.linked ? { linked: true as const } : {}),
            };
          }),
      },
    ]);
  }

  // Pendência = linha que ainda não teve desfecho final e que o usuário pode
  // resolver; bloqueada não entra (nenhuma decisão a libera). Sem `lineResults`
  // não há como saber o que ficou pendente, então nada é oferecido.
  const knowsLines = attempts.some((a) => a.lines.length > 0);
  const pendingLines = useMemo(
    () =>
      knowsLines
        ? lines.filter(
            (tx) =>
              !tx.duplicate &&
              !tx.ignored &&
              !isFinalOutcome(lineStates[tx.externalId]?.outcome) &&
              !isBlockedReview(tx.review),
          )
        : [],
    [knowsLines, lines, lineStates],
  );
  const toPendingLine = (tx: PreviewTx) => {
    const o = txStates[tx.externalId]?.decision?.overrides;
    return {
      externalId: tx.externalId,
      title: o?.titulo ?? tx.merchant,
      amountCents: o?.valorCents ?? tx.amountCents,
      outcome:
        lineStates[tx.externalId]?.outcome ?? CARD_IMPORT_LINE_OUTCOME.NOT_SELECTED,
    };
  };
  const blockedLines = knowsLines
    ? lines.filter(
        (tx) => !tx.duplicate && !tx.ignored && isBlockedReview(tx.review),
      )
    : [];

  function reviewPendingLines() {
    setCommitResult(null);
    setError(null);
    flow.setFilter("pending");
    flow.setStage("review");
  }

  function newPreview() {
    setPreview(null);
    resetLineWork();
    setStaleDocument(false);
    setError(null);
    flow.setStage("file");
  }

  function updateTx(externalId: string, patch: Partial<TxState>) {
    setTxStates((s) => ({ ...s, [externalId]: patch }));
  }

  const counts = useMemo(() => {
    let willCreate = 0,
      willLink = 0,
      willSkip = 0,
      possibleDup = 0,
      reviewPending = 0,
      blocked = 0,
      ignoredPayments = 0,
      totalCents = 0;
    for (const tx of lines) {
      const d = txStates[tx.externalId]?.decision;
      if (tx.duplicate || finalIds(tx.externalId)) continue;
      // Antes de review/Tier B: pagamento fica fora de novas, soma e pendências.
      if (tx.ignored) {
        ignoredPayments++;
        continue;
      }
      if (d?.action === "skip") {
        willSkip++;
        continue;
      }
      if (tx.review) {
        if (isBlockedReview(tx.review)) blocked++;
        else if (!hasReviewConsent(tx.review, d)) reviewPending++;
        else {
          willCreate++;
          totalCents += d?.overrides?.valorCents ?? tx.amountCents;
        }
        continue;
      }
      // Tier B (#659): só "importar mesmo assim" (`action:'import'`) cria a
      // linha — o commit descarta Tier B antes de processar `link`, então
      // vincular não resolve e a linha não conta como nova nem no somatório.
      if (tx.possibleDuplicate && d?.action !== "import") {
        possibleDup++;
        continue;
      }
      if (d?.action === "link") willLink++;
      else willCreate++;
      totalCents += d?.overrides?.valorCents ?? tx.amountCents;
    }
    return {
      willCreate,
      willLink,
      willSkip,
      possibleDup,
      reviewPending,
      blocked,
      ignoredPayments,
      totalCents,
    };
  }, [lines, txStates, lineStates]);
  // Só quando nada é selecionável nem está pendente; independe de haver só pagamentos.
  const noPurchasesToImport =
    counts.ignoredPayments > 0 &&
    counts.willCreate + counts.willLink === 0 &&
    counts.reviewPending === 0 &&
    counts.possibleDup === 0;

  const visibleLines = lines.filter((tx) => !finalIds(tx.externalId));
  const statusOf = (tx: PreviewTx) =>
    lineStates[tx.externalId]?.outcome === CARD_IMPORT_LINE_OUTCOME.ERROR
      ? ("retry" as const)
      : reviewStatus(
          { ...tx, ignored: !!tx.ignored },
          txStates[tx.externalId]?.decision,
        );
  const editingTx = lines.find(
    (tx) => tx.externalId === flow.editor?.id,
  );
  // Tentativa anterior já gravou efeitos: fechar precisa atualizar a lista.
  const hadEffects = attempts.some((a) => a.inserted + a.settled > 0);
  const close = () =>
    flow.requestClose(!!preview, hadEffects ? onCommitted : onClose);
  const footer = commitResult ? (
    <ImportFooter>
      {pendingLines.length > 0 ? (
        <>
          <Button variant="secondary" onClick={onCommitted}>
            Concluir mesmo assim
          </Button>
          <Button onClick={reviewPendingLines}>
            Revisar pendências ({pendingLines.length})
          </Button>
        </>
      ) : (
        <Button onClick={onCommitted}>Concluir</Button>
      )}
    </ImportFooter>
  ) : editingTx && flow.editor ? (
    <ImportFooter>
      {editingTx.ignored ? (
        // Pagamento não tem nada a aplicar: só volta à lista.
        <Button variant="secondary" onClick={flow.cancelEditor}>
          Voltar à revisão
        </Button>
      ) : (
        <>
          <Button variant="secondary" onClick={flow.cancelEditor}>
            Cancelar edição
          </Button>
          <Button
            onClick={() => {
              updateTx(editingTx.externalId, flow.editor!.draft);
              flow.finishEditor();
            }}
          >
            Aplicar à revisão
          </Button>
        </>
      )}
    </ImportFooter>
  ) : preview && flow.stage !== "file" ? (
    <ImportFooter>
      <Button
        variant="ghost"
        disabled={loading}
        onClick={() =>
          flow.setStage(flow.stage === "summary" ? "review" : "file")
        }
      >
        Voltar
      </Button>
      <Button variant="secondary" disabled={loading} onClick={close}>
        Cancelar
      </Button>
      <Button
        onClick={
          flow.stage === "summary"
            ? handleCommit
            : () => flow.setStage("summary")
        }
        disabled={
          loading || flow.uncertain || counts.willCreate + counts.willLink === 0
        }
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" /> Importando…
          </>
        ) : flow.stage === "summary" ? (
          <>
            <Upload className="w-4 h-4" /> Confirmar importação
          </>
        ) : (
          "Ver resumo"
        )}
      </Button>
    </ImportFooter>
  ) : undefined;

  return (
    <Modal
      open
      onClose={close}
      title={`Importar fatura — ${card.nickname ?? `${card.brand} ****${card.last4}`} · ${IMPORT_STEPS[flow.stage]}`}
      size="xl"
      variant="center"
      trapFocus
      closeDisabled={loading || !!commitResult}
      bounded
      footer={footer}
    >
      <ImportJourney
        stage={flow.stage}
        origin={card.nickname ?? `${card.brand} ****${card.last4}`}
        files={files}
      >
        <h3
          ref={flow.headingRef}
          tabIndex={-1}
          className="text-lg font-medium text-darc-velvet mb-3"
        >
          {flow.editor
            ? "Revisão · editar lançamento"
            : IMPORT_STEPS[flow.stage]}
        </h3>
        {commitResult ? (
          <>
            <CommittedView
              result={commitResult}
              partial={pendingLines.length > 0}
            />
            <PendingSummary
              pending={pendingLines.map(toPendingLine)}
              blocked={blockedLines.map(toPendingLine)}
            />
            <AttemptsHistory attempts={attempts} />
          </>
        ) : (
          <>
            <AttemptsHistory attempts={attempts} />
            {flow.stage === "file" && (
              <UploadStep
                files={files}
                setFiles={(f) => {
                  setFiles(f);
                  setPreview(null);
                  setNeedsPassword(false);
                  setPassword("");
                  resetLineWork();
                }}
                source={source}
                setSource={setSource}
                password={password}
                setPassword={setPassword}
                isPdf={isPdf}
                needsPassword={needsPassword}
                loading={loading}
                onPreview={handlePreview}
                hasPreview={!!preview}
              />
            )}

            {error && (
              <div
                role="alert"
                className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg flex gap-2 mt-3"
              >
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {staleDocument && (
              <Button className="mt-2" onClick={newPreview}>
                Gerar nova prévia
              </Button>
            )}

            <p role="status" aria-live="polite" className="sr-only">
              {loading
                ? preview
                  ? "Importando lançamentos"
                  : "Processando arquivos"
                : ""}
            </p>
            {editingTx && flow.editor ? (
              <>
                <PreviewTxRow
                  tx={editingTx}
                  state={flow.editor.draft}
                  onChange={(patch) =>
                    flow.updateDraft({ ...flow.editor!.draft, ...patch })
                  }
                  onClearDecision={() =>
                    flow.updateDraft(autoTxStates[editingTx.externalId] ?? {})
                  }
                />
                {!editingTx.ignored && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      flow.updateDraft(autoTxStates[editingTx.externalId] ?? {})
                    }
                  >
                    Restaurar dados originais e sugestões
                  </Button>
                )}
              </>
            ) : (
              preview &&
              flow.stage !== "file" && (
                <div className="mt-4">
                  <ImportClassificationNotice
                    status={preview.classificationStatus}
                  />
                  <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 mb-3 text-sm">
                    <div>
                      <strong>{preview.total}</strong> transações no arquivo
                      · <strong>{counts.willCreate + counts.willLink}</strong>{" "}
                      selecionada(s) ·{" "}
                      {counts.ignoredPayments > 0 && (
                        <>
                          <strong>{counts.ignoredPayments}</strong> pagamento(s)
                          de fatura ignorado(s) ·{" "}
                        </>
                      )}
                      <strong>{preview.duplicated}</strong> já existentes ·
                      Total do arquivo{" "}
                      <strong>
                        {formatCurrency((preview.totalAmountCents ?? 0) / 100)}
                      </strong>{" "}
                      · formato detectado: <strong>{preview.source}</strong>
                    </div>
                    <div className="mt-1 text-xs text-blue-700">
                      Após confirmar: <strong>{counts.willCreate}</strong> novas
                      ·<strong> {counts.willLink}</strong> vinculadas a
                      planejado ·<strong> {counts.willSkip}</strong> ignoradas ·
                      {counts.possibleDup > 0 && (
                        <>
                          <strong> {counts.possibleDup}</strong> possível(is)
                          duplicata(s) ·
                        </>
                      )}
                      {counts.reviewPending > 0 && (
                        <>
                          <strong> {counts.reviewPending}</strong> aguardando
                          decisão ·
                        </>
                      )}
                      {counts.blocked > 0 && (
                        <>
                          <strong> {counts.blocked}</strong> bloqueada(s) ·
                        </>
                      )}
                      soma:{" "}
                      <strong>{formatCurrency(counts.totalCents / 100)}</strong>
                    </div>
                    {noPurchasesToImport && (
                      <p className="mt-1 text-sm text-blue-900">
                        Não há compras a importar nesta revisão.
                      </p>
                    )}
                  </div>

                  {flow.stage === "review" ? (
                    <>
                      <ImportFilters
                        statuses={visibleLines.map(statusOf)}
                        value={flow.filter}
                        onChange={flow.setFilter}
                      />
                      {visibleLines
                        .filter((tx) =>
                          matchesReviewFilter(statusOf(tx), flow.filter),
                        )
                        .map((tx) => {
                          const state = txStates[tx.externalId] ?? {};
                          const decision = state.decision;
                          const match = tx.crossProjectMatches?.find(
                            (m) => m.expenseId === decision?.linkToExpenseId,
                          );
                          return (
                            <ImportReviewRow
                              key={tx.externalId}
                              title={decision?.overrides?.titulo ?? tx.merchant}
                              fonte={
                                decision?.overrides?.category === undefined
                                  ? tx.categoriaFonte
                                  : null
                              }
                              date={tx.date}
                              amountCents={
                                decision?.overrides?.valorCents ??
                                tx.amountCents
                              }
                              purpose={
                                match?.projectName ??
                                tipoLabel(
                                  decision?.overrides?.category ??
                                    tx.suggestedCategory ??
                                    "OUTROS",
                                )
                              }
                              status={statusOf(tx)}
                              onEdit={() =>
                                flow.openEditor(tx.externalId, state)
                              }
                              buttonRef={(node) => {
                                if (node)
                                  flow.rows.current.set(tx.externalId, node);
                                else flow.rows.current.delete(tx.externalId);
                              }}
                            />
                          );
                        })}
                    </>
                  ) : (
                    <p className="text-sm text-gray-600">
                      Os valores pertencem à fatura deste cartão, não são uma
                      saída imediata da conta. Confira também as parcelas
                      futuras.
                    </p>
                  )}

                  {(preview.futureInstallments ?? []).length > 0 && (
                    <FutureInstallmentsSection
                      items={preview.futureInstallments!}
                      expanded={showFuture}
                      onToggle={() => setShowFuture((v) => !v)}
                    />
                  )}
                </div>
              )
            )}
          </>
        )}
      </ImportJourney>
    </Modal>
  );
}

function UploadStep({
  files,
  setFiles,
  source,
  setSource,
  password,
  setPassword,
  isPdf,
  needsPassword,
  loading,
  onPreview,
  hasPreview,
}: {
  files: File[];
  setFiles: (f: File[]) => void;
  source: string;
  setSource: (s: string) => void;
  password: string;
  setPassword: (s: string) => void;
  isPdf: boolean;
  needsPassword: boolean;
  loading: boolean;
  onPreview: () => void;
  hasPreview: boolean;
}) {
  const fileId = useId();
  const formatId = useId();
  const passwordId = useId();
  return (
    <div className="space-y-3 mb-4">
      <div>
        <label htmlFor={fileId} className="text-sm text-gray-600">
          Arquivos (OFX, CSV, TXT, PDF, XLSX/XLS ou 📷 até 5 prints/fotos, máx
          10MB cada)
        </label>
        <input
          id={fileId}
          type="file"
          disabled={loading}
          onClick={(event) => {
            if (
              hasPreview &&
              !window.confirm(
                "Trocar arquivos descarta a revisão atual. Continuar?",
              )
            )
              event.preventDefault();
          }}
          multiple
          accept=".ofx,.csv,.txt,.pdf,.xlsx,.xls,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic"
          onChange={(e) =>
            setFiles(Array.from(e.target.files ?? []).slice(0, 5))
          }
          className="w-full border rounded-lg p-2"
        />
        {files.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-xs text-gray-500">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-1.5 truncate">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-400 shrink-0" />
                {f.name}
              </li>
            ))}
            {files.length >= 5 && (
              <li className="text-amber-600">Máximo de 5 arquivos por lote.</li>
            )}
          </ul>
        )}
      </div>
      <div>
        <label htmlFor={formatId} className="text-sm text-gray-600">
          Formato
        </label>
        <select
          id={formatId}
          value={source}
          disabled={hasPreview || loading}
          onChange={(e) => setSource(e.target.value)}
          className="w-full border rounded-lg p-2"
        >
          <option value="AUTO">Auto-detectar</option>
          <option value="OFX">OFX</option>
          <option value="CSV_NUBANK">CSV Nubank</option>
          <option value="CSV_ITAU">CSV Itaú</option>
          <option value="CSV_GENERIC">CSV genérico</option>
          <option value="PDF">PDF</option>
        </select>
      </div>
      {(isPdf || needsPassword) && (
        <div>
          <label htmlFor={passwordId} className="text-sm text-gray-600">
            Senha do PDF{" "}
            {!needsPassword && (
              <span className="text-gray-400">(se houver)</span>
            )}
          </label>
          <input
            id={passwordId}
            type="password"
            disabled={hasPreview || loading}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Senha (ex: 6 últimos do CPF ou data nasc DDMMAAAA)"
            className="w-full border rounded-lg p-2"
            autoComplete="off"
          />
        </div>
      )}
      <Button
        onClick={onPreview}
        disabled={files.length === 0 || loading}
        className="w-full"
        variant="secondary"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {loading
          ? "Processando…"
          : hasPreview
            ? "Continuar revisão"
            : "Conferir arquivos"}
      </Button>
      {/* Voltar ao arquivo mantém a revisão; continuar não reprocessa. */}
      {hasPreview && (
        <p className="text-xs text-gray-500 -mt-1">
          Prévia já carregada. Para reprocessar, escolha o(s) arquivo(s)
          novamente acima.
        </p>
      )}
    </div>
  );
}

function FutureInstallmentsSection({
  items,
  expanded,
  onToggle,
}: {
  items: PreviewTx[];
  expanded: boolean;
  onToggle: () => void;
}) {
  // Fato do arquivo: sem identidade da compra-mãe, portanto sem soma nem promessa.
  return (
    <div
      role="group"
      aria-label="Parcelas futuras informadas na fatura"
      className="mt-3 border border-amber-200 bg-amber-50 rounded-lg"
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full px-3 py-2 min-h-11 flex items-center gap-2 text-sm text-left"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0" />
        )}
        <span className="font-medium text-amber-900">
          Parcelas futuras informadas na fatura ({items.length})
        </span>
      </button>
      <p className="px-3 pb-2 text-xs text-amber-800">
        Informação do arquivo: esta lista não é o cronograma nem o total desta
        tentativa. Apenas as compras confirmadas serão processadas.
      </p>
      {expanded && (
        <div className="border-t border-amber-200 text-xs">
          {items.map((t) => (
            <div
              key={t.externalId}
              className="px-3 py-1.5 flex justify-between gap-3 border-b border-amber-100 last:border-0"
            >
              <span>
                {t.merchant}
                {t.installmentCurrent && t.installmentTotal
                  ? ` (${t.installmentCurrent}/${t.installmentTotal})`
                  : ""}
              </span>
              <span className="font-mono whitespace-nowrap">
                {formatCurrency(t.amountCents / 100)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommittedView({
  result,
  partial,
}: {
  result: CommitResult;
  partial: boolean;
}) {
  return (
    <div className="text-center py-8">
      <ImportWarnings warnings={result.postCommitWarnings} />
      {partial ? (
        <AlertCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
      ) : (
        <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
      )}
      <h3 className="text-xl font-semibold mb-2">
        {partial ? "Importação parcial" : "Importação concluída"}
      </h3>
      <div className="text-gray-700 space-y-1">
        <p>
          <strong>{result.inserted}</strong> novas transações
        </p>
        <p>
          <strong>{result.duplicated}</strong> ignoradas (duplicadas)
        </p>
        {!!result.duplicatedItems?.length && (
          <details className="text-left mt-1 mx-auto max-w-md">
            <summary className="text-sm text-gray-500 cursor-pointer select-none">
              Ver linhas ignoradas como duplicadas
            </summary>
            <ul className="mt-2 divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
              {result.duplicatedItems.map((it) => (
                <li
                  key={it.externalId}
                  className="flex items-baseline justify-between gap-3 px-3 py-1.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-700">
                      {it.description}
                    </span>
                    <span className="block text-xs text-gray-400">
                      {formatDateBR(it.date)}
                    </span>
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-gray-600">
                    {formatCurrency(Math.abs(it.amountCents) / 100)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {!!result.possibleDuplicates?.length && (
          <p className="text-orange-700">
            <strong>{result.possibleDuplicates.length}</strong> possível(is)
            duplicata(s) não importada(s) — marque “Importar mesmo assim” para
            incluí-las.
          </p>
        )}
        <p>
          <strong>{result.settled}</strong> reaproveitada(s), sem pagamento
        </p>
        {!!result.linked && (
          <p>
            <strong>{result.linked}</strong> vinculadas a despesas planejadas em
            outros projetos
          </p>
        )}
        {!!result.rulesLearned && (
          <p>
            <strong>{result.rulesLearned}</strong> correção(ões) viraram regra
            para o futuro
          </p>
        )}
        {!!result.rulesSkippedNoMapping && (
          <p className="text-gray-500">
            <strong>{result.rulesSkippedNoMapping}</strong> correção(ões) foram
            aplicadas à linha, mas não viraram regra: esse tipo não tem
            categoria equivalente.
          </p>
        )}
        {!!result.rulesLearnFailed && (
          <p className="text-amber-700">
            A importação foi concluída, mas não foi possível salvar{" "}
            <strong>{result.rulesLearnFailed}</strong> regra(s). Recategorize
            essas linhas para tentar de novo — a importação em si não falhou.
          </p>
        )}
        <p className="text-sm text-gray-500 mt-2">
          Período: {result.periodLabel}
        </p>
      </div>
    </div>
  );
}
