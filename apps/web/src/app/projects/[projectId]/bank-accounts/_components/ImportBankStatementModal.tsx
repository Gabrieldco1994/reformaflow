'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import type { BankAccountRow, BankPreviewResult, BankCommitResult } from '../_types';
import { BankPreviewTxRow } from './BankPreviewTxRow';

interface Props {
  projectId: string;
  account: BankAccountRow;
  onClose: () => void;
  onCommitted: () => void;
}

export interface BankImportDecision {
  externalId: string;
  action?: 'create' | 'skip' | 'link';
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
}

export default function ImportBankStatementModal({ projectId, account, onClose, onCommitted }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState('AUTO');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<BankPreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<BankCommitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStates, setTxStates] = useState<Record<string, BankTxState>>({});
  // Snapshot da auto-detecção do backend (cartão detectado sem ambiguidade,
  // match único de cross-project) no momento em que a prévia carregou. Usado
  // por `clearDecision` para "limpar decisão" voltar à sugestão automática em
  // vez de apagar tudo — inclusive o cartão que o sistema já tinha achado.
  const [autoTxStates, setAutoTxStates] = useState<Record<string, BankTxState>>({});

  const isPdf = files.some((f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');

  function buildUrl(mode: 'preview' | 'commit') {
    const params = new URLSearchParams({ source, mode });
    if (password) params.set('password', password);
    return `/projects/${projectId}/bank-accounts/${account.id}/import-statement?${params.toString()}`;
  }

  async function handlePreview() {
    if (files.length === 0) { setError('Selecione um arquivo'); return; }
    setError(null);
    setLoading(true);
    setPreview(null);
    setTxStates({});
    setAutoTxStates({});
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const res = await api.upload<BankPreviewResult>(buildUrl('preview'), fd);
      setPreview(res);
      const auto: Record<string, BankTxState> = {};
      for (const tx of res.preview ?? []) {
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
              action: 'link',
              linkToExpenseId: m.kind === 'expense' ? m.expenseId : undefined,
              linkToReceiptId: m.kind === 'receipt' ? m.receiptId : undefined,
            },
          };
        }
      }
      setTxStates(auto);
      setAutoTxStates(auto);
      setNeedsPassword(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro no preview';
      if (/pdf_password_required|senha do pdf necessária|senha necessária/i.test(msg)) {
        setNeedsPassword(true);
        setError('Este PDF está protegido. Informe a senha e tente novamente.');
      } else if (/pdf_wrong_password|senha.*incorreta/i.test(msg)) {
        setNeedsPassword(true);
        setError('Senha incorreta. Tente novamente.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleCommit() {
    if (files.length === 0 || !preview) return;
    setLoading(true);
    setError(null);
    try {
      const decisions: BankImportDecision[] = Object.values(txStates)
        .map((s) => s.decision)
        .filter((d): d is BankImportDecision => !!d && (!!d.action || !!d.overrides));
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      fd.append('decisions', JSON.stringify(decisions));
      const res = await api.upload<BankCommitResult>(buildUrl('commit'), fd);
      setCommitResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro no commit');
    } finally {
      setLoading(false);
    }
  }

  function updateTx(externalId: string, patch: Partial<BankTxState>) {
    setTxStates((s) => ({ ...s, [externalId]: { ...s[externalId], ...patch } }));
  }

  // Regressão #572: "limpar decisão" apagava a linha inteira do estado,
  // inclusive o cartão/vínculo que o BACKEND já tinha auto-detectado — o
  // usuário perdia a sugestão do sistema, não só a própria edição. Agora volta
  // para o snapshot de auto-detecção (`autoTxStates`) quando existir; só some
  // de vez quando a linha nunca teve sugestão automática.
  function clearDecision(externalId: string) {
    setTxStates((s) => {
      const next = { ...s };
      const auto = autoTxStates[externalId];
      if (auto) {
        next[externalId] = auto;
      } else {
        delete next[externalId];
      }
      return next;
    });
  }

  const counts = useMemo(() => {
    if (!preview) return { willCreate: 0, willLink: 0, willSkip: 0, debitCents: 0, creditCents: 0 };
    let willCreate = 0, willLink = 0, willSkip = 0, debitCents = 0, creditCents = 0;
    for (const tx of preview.preview) {
      const d = txStates[tx.externalId]?.decision;
      if (tx.duplicate) continue;
      if (d?.action === 'skip') { willSkip++; continue; }
      if (d?.action === 'link') willLink++;
      else willCreate++;
      const v = d?.overrides?.valorCents ?? Math.abs(tx.amountCents);
      if (tx.amountCents < 0) creditCents += v;
      else debitCents += v;
    }
    return { willCreate, willLink, willSkip, debitCents, creditCents };
  }, [preview, txStates]);

  return (
    <Modal
      open
      onClose={commitResult ? onCommitted : onClose}
      title={`Importar extrato — ${account.nickname ?? `${account.institution} ****${account.last4}`}`}
      size="xl"
      variant="center"
    >

        {commitResult ? (
          <CommittedView result={commitResult} onClose={onCommitted} />
        ) : (
          <>
            <div className="space-y-3 mb-4">
              <div>
                <label className="text-sm text-gray-600">Arquivos (OFX, CSV, TXT, PDF, XLSX/XLS ou 📷 até 5 prints/fotos, máx 10MB cada)</label>
                <input
                  type="file"
                  multiple
                  accept=".ofx,.csv,.txt,.pdf,.xlsx,.xls,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic"
                  onChange={(e) => {
                    setFiles(Array.from(e.target.files ?? []).slice(0, 5));
                    setPreview(null);
                    setNeedsPassword(false);
                    setPassword('');
                    setTxStates({});
                    setAutoTxStates({});
                  }}
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
                    {files.length >= 5 && <li className="text-amber-600">Máximo de 5 arquivos por lote.</li>}
                  </ul>
                )}
              </div>
              <div>
                <label className="text-sm text-gray-600">Formato</label>
                <select value={source} onChange={(e) => setSource(e.target.value)} className="w-full border rounded-lg p-2">
                  <option value="AUTO">Auto-detectar</option>
                  <option value="OFX">OFX</option>
                  <option value="CSV_GENERIC">CSV genérico</option>
                  <option value="PDF">PDF</option>
                </select>
              </div>
              {(isPdf || needsPassword) && (
                <div>
                  <label className="text-sm text-gray-600">
                    Senha do PDF {!needsPassword && <span className="text-gray-400">(se houver)</span>}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full border rounded-lg p-2"
                    autoComplete="off"
                  />
                </div>
              )}
              <Button
                onClick={handlePreview}
                disabled={files.length === 0 || loading || !!preview}
                className="w-full"
                variant="secondary"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {loading ? 'Processando…' : 'Pré-visualizar'}
              </Button>
              {/* Regressão #572: clicar de novo em "Pré-visualizar" com uma prévia
                  já carregada chamava `setTxStates({})` e apagava silenciosamente
                  exclusões/edições/vínculos que o usuário já tinha feito. Uma vez
                  que a prévia existe, o botão fica desabilitado — para reprocessar,
                  o usuário escolhe o(s) arquivo(s) de novo (o próprio input de
                  arquivo já limpa a prévia e as decisões, de forma explícita). */}
              {preview && (
                <p className="text-xs text-gray-500 -mt-1">
                  Prévia já carregada. Para reprocessar, escolha o(s) arquivo(s) novamente acima.
                </p>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg flex gap-2 mt-3">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {preview && (
              <div className="mt-4">
                {preview.warning && (
                  <div className="rounded-xl bg-amber-50 border border-amber-300 text-amber-800 p-3 mb-3 text-sm flex gap-2">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <span>{preview.warning.message}</span>
                  </div>
                )}
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 mb-3 text-sm">
                  <div>
                    <strong>{preview.total}</strong> transações ·
                    <strong> {preview.totalDebits ?? 0}</strong> débitos ·
                    <strong> {preview.totalCredits ?? 0}</strong> créditos ·
                    duplicadas: <strong>{preview.duplicated}</strong> ·
                    formato: <strong>{preview.source}</strong>
                  </div>
                  <div className="mt-1 text-xs text-blue-700">
                    Após confirmar: <strong>{counts.willCreate}</strong> novas ·
                    <strong> {counts.willLink}</strong> vinculadas ·
                    <strong> {counts.willSkip}</strong> ignoradas ·
                    saídas: <strong>{formatCurrency(counts.debitCents / 100)}</strong> ·
                    entradas: <strong>{formatCurrency(counts.creditCents / 100)}</strong>
                  </div>
                </div>

                <div className="border rounded-xl overflow-hidden">
                  <div className="bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 hidden sm:flex gap-2">
                    <span className="w-7"></span>
                    <span className="flex-1">Descrição / Data</span>
                    <span className="w-32 text-right">Valor</span>
                    <span className="w-44">Categoria</span>
                    <span className="w-12"></span>
                  </div>
                  <div className="max-h-[45dvh] overflow-y-auto divide-y divide-gray-100">
                    {preview.preview.map((tx) => (
                      <BankPreviewTxRow
                        key={tx.externalId}
                        tx={tx}
                        state={txStates[tx.externalId] ?? {}}
                        onChange={(patch) => updateTx(tx.externalId, patch)}
                        onClearDecision={() => clearDecision(tx.externalId)}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-4">
                  <Button variant="secondary" onClick={onClose}>Cancelar</Button>
                  <Button
                    onClick={handleCommit}
                    disabled={loading || (counts.willCreate + counts.willLink === 0)}
                  >
                    {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Importando…</> : <><Upload className="w-4 h-4" /> Confirmar importação</>}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
    </Modal>
  );
}

function CommittedView({ result, onClose }: { result: BankCommitResult; onClose: () => void }) {
  return (
    <div className="text-center py-8">
      <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
      <h3 className="text-xl font-semibold mb-2">Importação concluída</h3>
      <div className="text-gray-700 space-y-1">
        <p><strong>{result.inserted}</strong> despesas criadas</p>
        <p><strong>{result.receiptsInserted}</strong> recebimentos criados</p>
        <p><strong>{result.duplicated}</strong> ignoradas (duplicadas)</p>
        {!!result.duplicatedItems?.length && (
          <details className="text-left mt-1 mx-auto max-w-md">
            <summary className="text-sm text-gray-500 cursor-pointer select-none">
              Ver linhas ignoradas como duplicadas
            </summary>
            <ul className="mt-2 divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
              {result.duplicatedItems.map((it) => (
                <li key={it.externalId} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-700">{it.description}</span>
                    <span className="block text-xs text-gray-400">
                      {new Date(it.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
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
        {!!result.cardPayments && <p><strong>{result.cardPayments}</strong> pagamentos de fatura detectados</p>}
        {!!result.unlinkedCardPayments && (
          <p className="text-amber-700">
            <strong>{result.unlinkedCardPayments}</strong> pagamento(s) de fatura em que
            nenhuma fatura compatível foi liquidada — saíram do saldo, mas nenhuma
            fatura foi quitada.
          </p>
        )}
        {!!result.aiReclassified && <p><strong>{result.aiReclassified}</strong> reclassificadas pela IA</p>}
        {!!result.unparsedItems?.length && (
          <div className="text-left mt-2 mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-800">
              {result.unparsedItems.length} linha(s) não reconhecida(s) — não viraram lançamento.
              Confira no extrato se falta algo.
            </p>
            <ul className="mt-2 divide-y divide-amber-100">
              {result.unparsedItems.map((it) => (
                <li key={`${it.rowIndex}-${it.description}`} className="flex items-baseline justify-between gap-3 py-1">
                  <span className="min-w-0 flex-1 truncate text-sm text-amber-900">{it.description}</span>
                  <span className="shrink-0 whitespace-nowrap text-xs text-amber-600">linha {it.rowIndex}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!result.failedItems?.length && (
          <div className="text-left mt-2 mx-auto max-w-md rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-medium text-red-800">
              {result.failedItems.length} linha(s) falharam ao importar — não entraram no caixa.
            </p>
            <ul className="mt-2 divide-y divide-red-100">
              {result.failedItems.map((it, i) => (
                <li key={`${it.date}-${i}`} className="flex items-baseline justify-between gap-3 py-1">
                  <span className="min-w-0 flex-1 truncate text-sm text-red-900">{it.description}</span>
                  <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-red-700">
                    {formatCurrency(Math.abs(it.amountCents) / 100)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!result.skipped && <p><strong>{result.skipped}</strong> ignoradas pelo usuário</p>}
        <p className="text-sm text-gray-500 mt-2">Período: {result.periodLabel}</p>
      </div>
      <Button onClick={onClose} className="mt-6 min-h-11">Concluir</Button>
    </div>
  );
}
