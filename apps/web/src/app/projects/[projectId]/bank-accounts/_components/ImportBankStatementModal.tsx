"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { formatCurrency, formatDateBR } from "@/lib/utils";
import { Upload, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import type {
  BankAccountRow,
  BankPreviewResult,
  BankCommitResult,
} from "../_types";
import {
  BankImportEditor,
  validTargetDraft,
  type ImportNewTarget,
} from "./BankImportEditor";
import { ImportClassificationNotice } from "@/components/import/ImportClassificationNotice";
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
} from "@/components/import/ImportJourney";
import { categoryLabel } from "../_lib/import-categories";

interface Props {
  projectId: string;
  account: BankAccountRow;
  onClose: () => void;
  onCommitted: () => void;
}

export interface BankImportDecision {
  newTarget?: ImportNewTarget;
  externalId: string;
  // 'import' (#659) força criar uma linha marcada `possibleDuplicate` (Tier B).
  action?: "create" | "skip" | "link" | "import";
  linkToExpenseId?: string;
  linkToReceiptId?: string;
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;
    /** Cartão cuja fatura esta linha quita. */
    cardLast4?: string;
  };
}

export interface BankTxState {
  decision?: BankImportDecision;
  targetReviewedAmount?: number;
}

export default function ImportBankStatementModal({
  projectId,
  account,
  onClose,
  onCommitted,
}: Props) {
  const flow = useImportJourney<BankTxState>();
  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState("AUTO");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<BankPreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<BankCommitResult | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStates, setTxStates] = useState<Record<string, BankTxState>>({});
  // Snapshot da auto-detecção do backend (cartão detectado sem ambiguidade,
  // match único de cross-project) no momento em que a prévia carregou. Usado
  // por `clearDecision` para "limpar decisão" voltar à sugestão automática em
  // vez de apagar tudo — inclusive o cartão que o sistema já tinha achado.
  const [autoTxStates, setAutoTxStates] = useState<Record<string, BankTxState>>(
    {},
  );

  const isPdf = files.some(
    (f) =>
      f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf",
  );

  function buildUrl(mode: "preview" | "commit") {
    const params = new URLSearchParams({ source, mode });
    if (password) params.set("password", password);
    return `/projects/${projectId}/bank-accounts/${account.id}/import-statement?${params.toString()}`;
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
    setTxStates({});
    setAutoTxStates({});
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      const res = await api.upload<BankPreviewResult>(buildUrl("preview"), fd);
      setPreview(res);
      flow.setStage("review");
      const auto: Record<string, BankTxState> = {};
      for (const tx of res.preview ?? []) {
        // Tier B (#659): nunca auto-vincular/auto-preencher uma linha que o
        // servidor marcou como possível duplicata — o opt-in é sempre explícito.
        if (tx.duplicate || tx.possibleDuplicate) continue;
        // Pagamento de fatura com cartão detectado sem ambiguidade já vem
        // pré-selecionado — o usuário só confirma (ou troca) antes de importar.
        if (tx.isCardPayment && tx.suggestedCardLast4) {
          auto[tx.externalId] = {
            decision: {
              externalId: tx.externalId,
              overrides: { cardLast4: tx.suggestedCardLast4 },
            },
          };
        }
        const matches = tx.crossProjectMatches ?? [];
        if (matches.length === 1 && Math.abs(matches[0].deltaCents) < 100) {
          const m = matches[0];
          auto[tx.externalId] = {
            decision: {
              ...auto[tx.externalId]?.decision,
              externalId: tx.externalId,
              action: "link",
              linkToExpenseId: m.kind === "expense" ? m.expenseId : undefined,
              linkToReceiptId: m.kind === "receipt" ? m.receiptId : undefined,
            },
          };
        }
      }
      setTxStates(auto);
      setAutoTxStates(auto);
      setNeedsPassword(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro no preview";
      if (
        /pdf_password_required|senha do pdf necessária|senha necessária/i.test(
          msg,
        )
      ) {
        setNeedsPassword(true);
        setError("Este PDF está protegido. Informe a senha e tente novamente.");
      } else if (/pdf_wrong_password|senha.*incorreta/i.test(msg)) {
        setNeedsPassword(true);
        setError("Senha incorreta. Tente novamente.");
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
    if (
      preview.preview.some(
        (tx) =>
          !validTargetDraft(
            tx,
            txStates[tx.externalId] ?? {},
            preview.inlineTargetProjects,
          ),
      )
    ) {
      setError("Revise os destinos antes de confirmar a importação.");
      flow.setStage("review");
      return;
    }
    flow.sending.current = true;
    setLoading(true);
    setError(null);
    try {
      const decisions: BankImportDecision[] = Object.values(txStates)
        .map((s) => s.decision)
        .filter(
          (d): d is BankImportDecision => !!d && (!!d.action || !!d.overrides),
        );
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      fd.append("decisions", JSON.stringify(decisions));
      const res = await api.upload<BankCommitResult>(buildUrl("commit"), fd);
      setCommitResult(res);
      flow.setStage("result");
    } catch (e) {
      const rejected = importWasRejected(e);
      flow.setUncertain(!rejected);
      setError(importFailureMessage(e));
    } finally {
      flow.sending.current = false;
      setLoading(false);
    }
  }

  function updateTx(externalId: string, patch: Partial<BankTxState>) {
    setTxStates((s) => ({ ...s, [externalId]: patch }));
  }

  const counts = useMemo(() => {
    if (!preview)
      return {
        willCreate: 0,
        willLink: 0,
        willSkip: 0,
        possibleDup: 0,
        debitCents: 0,
        creditCents: 0,
      };
    let willCreate = 0,
      willLink = 0,
      willSkip = 0,
      possibleDup = 0,
      debitCents = 0,
      creditCents = 0;
    for (const tx of preview.preview) {
      const d = txStates[tx.externalId]?.decision;
      if (tx.duplicate) continue;
      if (d?.action === "skip") {
        willSkip++;
        continue;
      }
      // Tier B (#659): só "importar mesmo assim" (`action:'import'`) cria a
      // linha — o commit descarta Tier B antes de processar `link`, então
      // vincular não resolve e a linha não conta como nova nem nos somatórios.
      if (tx.possibleDuplicate && d?.action !== "import") {
        possibleDup++;
        continue;
      }
      if (d?.action === "link") willLink++;
      else willCreate++;
      const v = d?.overrides?.valorCents ?? Math.abs(tx.amountCents);
      if (tx.amountCents < 0) creditCents += v;
      else debitCents += v;
    }
    return {
      willCreate,
      willLink,
      willSkip,
      possibleDup,
      debitCents,
      creditCents,
    };
  }, [preview, txStates]);

  const editingTx = preview?.preview.find(
    (tx) => tx.externalId === flow.editor?.id,
  );
  const close = () => flow.requestClose(!!preview, onClose);
  const origin =
    account.nickname ?? `${account.institution} ****${account.last4}`;

  return (
    <Modal
      open
      onClose={close}
      title={`Importar extrato — ${origin} · ${IMPORT_STEPS[flow.stage]}`}
      size="xl"
      variant="center"
      trapFocus
      closeDisabled={loading || !!commitResult}
    >
      <ImportJourney stage={flow.stage} origin={origin} files={files}>
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
          <CommittedView result={commitResult} onClose={onCommitted} />
        ) : (
          <>
            {flow.stage === "file" && (
              <div className="space-y-3 mb-4">
                <div>
                  <label className="text-sm text-gray-600">
                    Arquivos (OFX, CSV, TXT, PDF, XLSX/XLS ou 📷 até 5
                    prints/fotos, máx 10MB cada)
                  </label>
                  <input
                    type="file"
                    disabled={loading}
                    multiple
                    accept=".ofx,.csv,.txt,.pdf,.xlsx,.xls,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic"
                    onClick={(e) => {
                      if (
                        preview &&
                        !window.confirm(
                          "Trocar arquivos descarta a revisão atual. Continuar?",
                        )
                      )
                        e.preventDefault();
                    }}
                    onChange={(e) => {
                      setFiles(Array.from(e.target.files ?? []).slice(0, 5));
                      setPreview(null);
                      setNeedsPassword(false);
                      setPassword("");
                      setTxStates({});
                      setAutoTxStates({});
                    }}
                    className="w-full border rounded-lg p-2"
                  />
                  {files.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-xs text-gray-500">
                      {files.map((f, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-1.5 truncate"
                        >
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-400 shrink-0" />
                          {f.name}
                        </li>
                      ))}
                      {files.length >= 5 && (
                        <li className="text-amber-600">
                          Máximo de 5 arquivos por lote.
                        </li>
                      )}
                    </ul>
                  )}
                </div>
                <div>
                  <label className="text-sm text-gray-600">Formato</label>
                  <select
                    value={source}
                    disabled={!!preview || loading}
                    onChange={(e) => setSource(e.target.value)}
                    className="w-full border rounded-lg p-2"
                  >
                    <option value="AUTO">Auto-detectar</option>
                    <option value="OFX">OFX</option>
                    <option value="CSV_GENERIC">CSV genérico</option>
                    <option value="PDF">PDF</option>
                  </select>
                </div>
                {(isPdf || needsPassword) && (
                  <div>
                    <label className="text-sm text-gray-600">
                      Senha do PDF{" "}
                      {!needsPassword && (
                        <span className="text-gray-400">(se houver)</span>
                      )}
                    </label>
                    <input
                      type="password"
                      disabled={!!preview || loading}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full border rounded-lg p-2"
                      autoComplete="off"
                    />
                  </div>
                )}
                <Button
                  onClick={handlePreview}
                  disabled={files.length === 0 || loading}
                  className="w-full"
                  variant="secondary"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : null}
                  {loading
                    ? "Processando…"
                    : preview
                      ? "Continuar revisão"
                      : "Conferir arquivos"}
                </Button>
                {/* Voltar ao arquivo mantém a revisão; continuar não reprocessa. */}
                {preview && (
                  <p className="text-xs text-gray-500 -mt-1">
                    Prévia já carregada. Para reprocessar, escolha o(s)
                    arquivo(s) novamente acima.
                  </p>
                )}
              </div>
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

            <p role="status" aria-live="polite" className="sr-only">
              {loading
                ? preview
                  ? "Importando lançamentos"
                  : "Processando arquivos"
                : ""}
            </p>
            {editingTx && flow.editor ? (
              <>
                <BankImportEditor
                  tx={editingTx}
                  state={flow.editor.draft}
                  projects={preview?.inlineTargetProjects}
                  onChange={flow.updateDraft}
                  onRestore={() =>
                    flow.updateDraft(autoTxStates[editingTx.externalId] ?? {})
                  }
                />
                <ImportFooter>
                  <Button variant="secondary" onClick={flow.cancelEditor}>
                    Cancelar edição
                  </Button>
                  <Button
                    disabled={
                      !validTargetDraft(
                        editingTx,
                        flow.editor.draft,
                        preview?.inlineTargetProjects,
                      )
                    }
                    onClick={() => {
                      updateTx(editingTx.externalId, flow.editor!.draft);
                      flow.finishEditor();
                    }}
                  >
                    Aplicar à revisão
                  </Button>
                </ImportFooter>
              </>
            ) : (
              preview &&
              flow.stage !== "file" && (
                <div className="mt-4">
                  {preview.warning && (
                    <div className="rounded-xl bg-amber-50 border border-amber-300 text-amber-800 p-3 mb-3 text-sm flex gap-2">
                      <AlertCircle className="w-5 h-5 flex-shrink-0" />
                      <span>{preview.warning.message}</span>
                    </div>
                  )}
                  <ImportClassificationNotice
                    status={preview.classificationStatus}
                  />
                  <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 mb-3 text-sm">
                    <div>
                      <strong>{preview.total}</strong> transações ·
                      <strong> {preview.totalDebits ?? 0}</strong> débitos ·
                      <strong> {preview.totalCredits ?? 0}</strong> créditos ·
                      duplicadas: <strong>{preview.duplicated}</strong> ·
                      formato: <strong>{preview.source}</strong>
                    </div>
                    <div className="mt-1 text-xs text-blue-700">
                      Após confirmar: <strong>{counts.willCreate}</strong> novas
                      ·<strong> {counts.willLink}</strong> vinculadas ·
                      <strong> {counts.willSkip}</strong> ignoradas ·
                      {counts.possibleDup > 0 && (
                        <>
                          <strong> {counts.possibleDup}</strong> possível(is)
                          duplicata(s) ·
                        </>
                      )}
                      saídas:{" "}
                      <strong>{formatCurrency(counts.debitCents / 100)}</strong>{" "}
                      · entradas:{" "}
                      <strong>
                        {formatCurrency(counts.creditCents / 100)}
                      </strong>
                    </div>
                  </div>

                  {flow.stage === "review" ? (
                    <>
                      <ImportFilters
                        statuses={preview.preview.map((tx) =>
                          reviewStatus(tx, txStates[tx.externalId]?.decision),
                        )}
                        value={flow.filter}
                        onChange={flow.setFilter}
                      />
                      {preview.preview
                        .filter((tx) =>
                          matchesReviewFilter(
                            reviewStatus(tx, txStates[tx.externalId]?.decision),
                            flow.filter,
                          ),
                        )
                        .map((tx) => {
                          const state = txStates[tx.externalId] ?? {};
                          const decision = state.decision;
                          const targetName = preview.inlineTargetProjects?.find(
                            (project) =>
                              project.id ===
                              decision?.newTarget?.targetProjectId,
                          )?.name;
                          const match = tx.crossProjectMatches?.find((m) =>
                            m.kind === "expense"
                              ? m.expenseId === decision?.linkToExpenseId
                              : m.receiptId === decision?.linkToReceiptId,
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
                                (tx.amountCents < 0 ? 1 : -1) *
                                (decision?.overrides?.valorCents ??
                                  Math.abs(tx.amountCents))
                              }
                              purpose={
                                targetName ??
                                match?.projectName ??
                                categoryLabel(
                                  decision?.overrides?.category ??
                                    tx.suggestedCategory ??
                                    "OUTROS",
                                )
                              }
                              status={reviewStatus(tx, decision)}
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
                    <div className="space-y-2 text-sm text-gray-700">
                      <p>
                        Os totais acima contam lançamentos bancários uma única
                        vez. A finalidade em outro projeto não é uma segunda
                        saída.
                      </p>
                      <p>
                        Finalidade:{" "}
                        {
                          Object.values(txStates).filter(
                            (state) => state.decision?.newTarget,
                          ).length
                        }{" "}
                        novo(s) destino(s) serão criados na confirmação.
                      </p>
                      <ul className="space-y-2">
                        {preview.preview.map((tx) => {
                          const decision = txStates[tx.externalId]?.decision;
                          if (!decision?.newTarget) return null;
                          const project = preview.inlineTargetProjects?.find(
                            (p) => p.id === decision.newTarget?.targetProjectId,
                          );
                          return (
                            <li
                              key={tx.externalId}
                              className="rounded-lg border border-darc-linen p-3"
                            >
                              <p className="break-words">
                                Finalidade: {project?.name} ·{" "}
                                {categoryLabel(decision.newTarget.tipoDespesa)}
                              </p>
                              <p>
                                Valor integral destinado:{" "}
                                <strong>
                                  {formatCurrency(
                                    (decision.overrides?.valorCents ??
                                      tx.amountCents) / 100,
                                  )}
                                </strong>
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                      <p>
                        As associações existentes serão tentadas após a
                        importação; confira eventuais avisos no resultado.
                      </p>
                    </div>
                  )}
                  <ImportFooter>
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
                    <Button
                      variant="secondary"
                      disabled={loading}
                      onClick={close}
                      className="min-h-11"
                    >
                      Cancelar
                    </Button>
                    <Button
                      onClick={
                        flow.stage === "summary"
                          ? handleCommit
                          : () => flow.setStage("summary")
                      }
                      disabled={
                        loading ||
                        flow.uncertain ||
                        counts.willCreate + counts.willLink === 0
                      }
                      className="min-h-11"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />{" "}
                          Importando…
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
                </div>
              )
            )}
          </>
        )}
      </ImportJourney>
    </Modal>
  );
}

function CommittedView({
  result,
  onClose,
}: {
  result: BankCommitResult;
  onClose: () => void;
}) {
  return (
    <div className="text-center py-8">
      <ImportWarnings warnings={result.postCommitWarnings} />
      <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
      <h3 className="text-xl font-semibold mb-2">Importação concluída</h3>
      <div className="text-gray-700 space-y-1">
        <p>
          <strong>{result.inserted}</strong> despesas criadas
        </p>
        <p>
          <strong>{result.receiptsInserted}</strong> recebimentos criados
        </p>
        <p>
          <strong>{result.duplicated}</strong> ignoradas (duplicadas)
        </p>
        {!!result.possibleDuplicates?.length && (
          <p className="text-orange-700">
            <strong>{result.possibleDuplicates.length}</strong> possível(is)
            duplicata(s) não importada(s) — marque “Importar mesmo assim” para
            incluí-las.
          </p>
        )}
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
        {!!result.cardPayments && (
          <p>
            <strong>{result.cardPayments}</strong> pagamentos de fatura
            detectados
          </p>
        )}
        {!!result.unlinkedCardPayments && (
          <p className="text-amber-700">
            <strong>{result.unlinkedCardPayments}</strong> pagamento(s) de
            fatura sem cartão identificado — saíram do saldo, mas nenhuma fatura
            foi quitada.
          </p>
        )}
        {!!result.aiReclassified && (
          <p>
            <strong>{result.aiReclassified}</strong> reclassificadas pela IA
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
        {!!result.unparsedItems?.length && (
          <div className="text-left mt-2 mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-800">
              {result.unparsedItems.length} linha(s) não reconhecida(s) — não
              viraram lançamento. Confira no extrato se falta algo.
            </p>
            <ul className="mt-2 divide-y divide-amber-100">
              {result.unparsedItems.map((it) => (
                <li
                  key={`${it.rowIndex}-${it.description}`}
                  className="flex items-baseline justify-between gap-3 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-amber-900">
                    {it.description}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-xs text-amber-600">
                    linha {it.rowIndex}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!result.failedItems?.length && (
          <div className="text-left mt-2 mx-auto max-w-md rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-medium text-red-800">
              {result.failedItems.length} linha(s) falharam ao importar — não
              entraram no caixa.
            </p>
            <ul className="mt-2 divide-y divide-red-100">
              {result.failedItems.map((it, i) => (
                <li
                  key={`${it.date}-${i}`}
                  className="flex items-baseline justify-between gap-3 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-red-900">
                    {it.description}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-red-700">
                    {formatCurrency(Math.abs(it.amountCents) / 100)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!result.skipped && (
          <p>
            <strong>{result.skipped}</strong> ignoradas pelo usuário
          </p>
        )}
        {!!result.inlineExpenses?.length && (
          <p>
            <strong>{result.inlineExpenses.length}</strong> destino(s) criado(s)
            e vinculados, sem duplicar a saída da conta.
          </p>
        )}
        <p className="text-sm text-gray-500 mt-2">
          Período: {result.periodLabel}
        </p>
      </div>
      <Button onClick={onClose} className="mt-6 min-h-11">
        Concluir
      </Button>
    </div>
  );
}
