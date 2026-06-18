'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { X, Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
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
  };
}

export interface BankTxState {
  decision?: BankImportDecision;
}

export default function ImportBankStatementModal({ projectId, account, onClose, onCommitted }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState('AUTO');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<BankPreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<BankCommitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStates, setTxStates] = useState<Record<string, BankTxState>>({});

  const isPdf = !!file && (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');

  function buildUrl(mode: 'preview' | 'commit') {
    const params = new URLSearchParams({ source, mode });
    if (password) params.set('password', password);
    return `/projects/${projectId}/bank-accounts/${account.id}/import-statement?${params.toString()}`;
  }

  async function handlePreview() {
    if (!file) { setError('Selecione um arquivo'); return; }
    setError(null);
    setLoading(true);
    setPreview(null);
    setTxStates({});
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload<BankPreviewResult>(buildUrl('preview'), fd);
      setPreview(res);
      const auto: Record<string, BankTxState> = {};
      for (const tx of res.preview ?? []) {
        const matches = tx.crossProjectMatches ?? [];
        if (matches.length === 1 && Math.abs(matches[0].deltaCents) < 100) {
          const m = matches[0];
          auto[tx.externalId] = {
            decision: {
              externalId: tx.externalId,
              action: 'link',
              linkToExpenseId: m.kind === 'expense' ? m.expenseId : undefined,
              linkToReceiptId: m.kind === 'receipt' ? m.receiptId : undefined,
            },
          };
        }
      }
      setTxStates(auto);
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
    if (!file || !preview) return;
    setLoading(true);
    setError(null);
    try {
      const decisions: BankImportDecision[] = Object.values(txStates)
        .map((s) => s.decision)
        .filter((d): d is BankImportDecision => !!d && (!!d.action || !!d.overrides));
      const fd = new FormData();
      fd.append('file', file);
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

  function clearDecision(externalId: string) {
    setTxStates((s) => {
      const { [externalId]: _, ...rest } = s;
      return rest;
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-4xl max-h-[92vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">
            Importar extrato — {account.nickname ?? `${account.institution} ****${account.last4}`}
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        {commitResult ? (
          <CommittedView result={commitResult} onClose={onCommitted} />
        ) : (
          <>
            <div className="space-y-3 mb-4">
              <div>
                <label className="text-sm text-gray-600">Arquivo (OFX, CSV, PDF ou 📷 print/foto, máx 10MB)</label>
                <input
                  type="file"
                  accept=".ofx,.csv,.txt,.pdf,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setPreview(null);
                    setNeedsPassword(false);
                    setPassword('');
                    setTxStates({});
                  }}
                  className="w-full border rounded-lg p-2"
                />
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
              <button
                onClick={handlePreview}
                disabled={!file || loading}
                className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {loading ? 'Processando…' : 'Pré-visualizar'}
              </button>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg flex gap-2 mt-3">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {preview && (
              <div className="mt-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 text-sm">
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

                <div className="border rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 flex gap-2">
                    <span className="w-7"></span>
                    <span className="flex-1">Descrição / Data</span>
                    <span className="w-32 text-right">Valor</span>
                    <span className="w-44">Categoria</span>
                    <span className="w-12"></span>
                  </div>
                  <div className="max-h-[55vh] overflow-y-auto">
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
                  <button onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
                  <button
                    onClick={handleCommit}
                    disabled={loading || (counts.willCreate + counts.willLink === 0)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg flex items-center gap-2 disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {loading ? 'Importando…' : 'Confirmar importação'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
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
        {!!result.cardPayments && <p><strong>{result.cardPayments}</strong> pagamentos de fatura detectados</p>}
        {!!result.aiReclassified && <p><strong>{result.aiReclassified}</strong> reclassificadas pela IA</p>}
        {!!result.skipped && <p><strong>{result.skipped}</strong> ignoradas pelo usuário</p>}
        <p className="text-sm text-gray-500 mt-2">Período: {result.periodLabel}</p>
      </div>
      <button onClick={onClose} className="mt-6 px-6 py-2 bg-blue-600 text-white rounded-lg">
        Fechar
      </button>
    </div>
  );
}
