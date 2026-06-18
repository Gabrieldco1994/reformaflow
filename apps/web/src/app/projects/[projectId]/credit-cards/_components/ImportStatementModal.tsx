'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { X, Upload, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import type { CardRow, PreviewResult, CommitResult, PreviewTx } from '../_types';
import { PreviewTxRow } from './PreviewTxRow';

interface Props {
  projectId: string;
  card: CardRow;
  onClose: () => void;
  onCommitted: () => void;
}

export interface ImportDecision {
  externalId: string;
  action?: 'create' | 'skip' | 'link';
  linkToExpenseId?: string;
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;
  };
}

export interface TxState {
  decision?: ImportDecision;
}

export default function ImportStatementModal({ projectId, card, onClose, onCommitted }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState('AUTO');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStates, setTxStates] = useState<Record<string, TxState>>({});
  const [showFuture, setShowFuture] = useState(false);

  const isPdf = !!file && (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf');

  function buildUrl(mode: 'preview' | 'commit') {
    const params = new URLSearchParams({ source, mode });
    if (password) params.set('password', password);
    return `/projects/${projectId}/credit-cards/${card.id}/import-statement?${params.toString()}`;
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
      const res = await api.upload<PreviewResult>(buildUrl('preview'), fd);
      setPreview(res);
      // Auto-marca matches únicos como "linked" por padrão (quando houver exatamente 1 match com delta=0)
      const auto: Record<string, TxState> = {};
      for (const tx of res.preview ?? []) {
        const matches = tx.crossProjectMatches ?? [];
        if (matches.length === 1 && Math.abs(matches[0].deltaCents) < 100) {
          auto[tx.externalId] = {
            decision: { externalId: tx.externalId, action: 'link', linkToExpenseId: matches[0].expenseId },
          };
        }
      }
      setTxStates(auto);
      setNeedsPassword(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro no preview';
      if (/pdf_password_required|senha/i.test(msg)) {
        setNeedsPassword(true);
        setError('Este PDF está protegido. Informe a senha e tente novamente.');
      } else if (/pdf_wrong_password|incorreta/i.test(msg)) {
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
      const decisions: ImportDecision[] = Object.values(txStates)
        .map((s) => s.decision)
        .filter((d): d is ImportDecision => !!d && (!!d.action || !!d.overrides));
      const fd = new FormData();
      fd.append('file', file);
      fd.append('decisions', JSON.stringify(decisions));
      const res = await api.upload<CommitResult>(buildUrl('commit'), fd);
      setCommitResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro no commit');
    } finally {
      setLoading(false);
    }
  }

  function updateTx(externalId: string, patch: Partial<TxState>) {
    setTxStates((s) => ({ ...s, [externalId]: { ...s[externalId], ...patch } }));
  }

  function clearDecision(externalId: string) {
    setTxStates((s) => {
      const { [externalId]: _, ...rest } = s;
      return rest;
    });
  }

  const counts = useMemo(() => {
    if (!preview) return { willCreate: 0, willLink: 0, willSkip: 0, totalCents: 0 };
    let willCreate = 0, willLink = 0, willSkip = 0, totalCents = 0;
    for (const tx of preview.preview) {
      const d = txStates[tx.externalId]?.decision;
      if (tx.duplicate) continue;
      if (d?.action === 'skip') { willSkip++; continue; }
      if (d?.action === 'link') willLink++;
      else willCreate++;
      totalCents += d?.overrides?.valorCents ?? tx.amountCents;
    }
    return { willCreate, willLink, willSkip, totalCents };
  }, [preview, txStates]);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-4xl max-h-[92vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">
            Importar fatura — {card.nickname ?? `${card.brand} ****${card.last4}`}
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        {commitResult ? (
          <CommittedView result={commitResult} onClose={onCommitted} />
        ) : (
          <>
            <UploadStep
              file={file} setFile={(f) => { setFile(f); setPreview(null); setNeedsPassword(false); setPassword(''); setTxStates({}); }}
              source={source} setSource={setSource}
              password={password} setPassword={setPassword}
              isPdf={isPdf} needsPassword={needsPassword}
              loading={loading} onPreview={handlePreview}
            />

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
                    total <strong>{formatCurrency((preview.totalAmountCents ?? 0) / 100)}</strong> ·
                    <strong> {preview.duplicated}</strong> já existentes ·
                    formato detectado: <strong>{preview.source}</strong>
                  </div>
                  <div className="mt-1 text-xs text-blue-700">
                    Após confirmar: <strong>{counts.willCreate}</strong> novas ·
                    <strong> {counts.willLink}</strong> vinculadas a planejado ·
                    <strong> {counts.willSkip}</strong> ignoradas ·
                    soma: <strong>{formatCurrency(counts.totalCents / 100)}</strong>
                  </div>
                </div>

                <div className="border rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 flex gap-2">
                    <span className="flex-1">Estabelecimento / Data</span>
                    <span className="w-32 text-right">Valor (R$)</span>
                    <span className="w-40">Categoria</span>
                    <span className="w-12"></span>
                  </div>
                  <div className="max-h-[50vh] overflow-y-auto">
                    {preview.preview.map((tx) => (
                      <PreviewTxRow
                        key={tx.externalId}
                        tx={tx}
                        state={txStates[tx.externalId] ?? {}}
                        onChange={(patch) => updateTx(tx.externalId, patch)}
                        onClearDecision={() => clearDecision(tx.externalId)}
                      />
                    ))}
                  </div>
                </div>

                {(preview.futureInstallments ?? []).length > 0 && (
                  <FutureInstallmentsSection
                    items={preview.futureInstallments!}
                    expanded={showFuture}
                    onToggle={() => setShowFuture((v) => !v)}
                  />
                )}

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

function UploadStep({
  file, setFile, source, setSource, password, setPassword, isPdf, needsPassword, loading, onPreview,
}: {
  file: File | null;
  setFile: (f: File | null) => void;
  source: string;
  setSource: (s: string) => void;
  password: string;
  setPassword: (s: string) => void;
  isPdf: boolean;
  needsPassword: boolean;
  loading: boolean;
  onPreview: () => void;
}) {
  return (
    <div className="space-y-3 mb-4">
      <div>
        <label className="text-sm text-gray-600">Arquivo (OFX, CSV, PDF ou 📷 print/foto, máx 10MB)</label>
        <input
          type="file"
          accept=".ofx,.csv,.txt,.pdf,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full border rounded-lg p-2"
        />
      </div>
      <div>
        <label className="text-sm text-gray-600">Formato</label>
        <select value={source} onChange={(e) => setSource(e.target.value)} className="w-full border rounded-lg p-2">
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
          <label className="text-sm text-gray-600">
            Senha do PDF {!needsPassword && <span className="text-gray-400">(se houver)</span>}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Senha (ex: 6 últimos do CPF ou data nasc DDMMAAAA)"
            className="w-full border rounded-lg p-2"
            autoComplete="off"
          />
        </div>
      )}
      <button
        onClick={onPreview}
        disabled={!file || loading}
        className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {loading ? 'Processando…' : 'Pré-visualizar'}
      </button>
    </div>
  );
}

function FutureInstallmentsSection({
  items, expanded, onToggle,
}: { items: PreviewTx[]; expanded: boolean; onToggle: () => void }) {
  const total = items.reduce((s, t) => s + t.amountCents, 0);
  return (
    <div className="mt-3 border border-amber-200 bg-amber-50 rounded-lg">
      <button onClick={onToggle} className="w-full px-3 py-2 flex items-center gap-2 text-sm">
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className="font-medium text-amber-900">
          {items.length} parcela(s) futura(s) — {formatCurrency(total / 100)}
        </span>
        <span className="text-xs text-amber-700">
          (entrarão como PLANEJADO no fluxo de caixa)
        </span>
      </button>
      {expanded && (
        <div className="border-t border-amber-200 max-h-48 overflow-y-auto text-xs">
          {items.map((t) => (
            <div key={t.externalId} className="px-3 py-1.5 flex justify-between border-b border-amber-100 last:border-0">
              <span>{t.merchant}{t.installmentCurrent && t.installmentTotal ? ` (${t.installmentCurrent}/${t.installmentTotal})` : ''}</span>
              <span className="font-mono">{formatCurrency(t.amountCents / 100)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommittedView({ result, onClose }: { result: CommitResult; onClose: () => void }) {
  return (
    <div className="text-center py-8">
      <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
      <h3 className="text-xl font-semibold mb-2">Importação concluída</h3>
      <div className="text-gray-700 space-y-1">
        <p><strong>{result.inserted}</strong> novas transações</p>
        <p><strong>{result.duplicated}</strong> ignoradas (duplicadas)</p>
        <p><strong>{result.settled}</strong> parcelas planejadas marcadas como pagas</p>
        {!!result.linked && <p><strong>{result.linked}</strong> vinculadas a despesas planejadas em outros projetos</p>}
        <p className="text-sm text-gray-500 mt-2">Período: {result.periodLabel}</p>
      </div>
      <button onClick={onClose} className="mt-6 px-6 py-2 bg-blue-600 text-white rounded-lg">
        Fechar
      </button>
    </div>
  );
}
