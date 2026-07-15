'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Upload, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
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
  const [files, setFiles] = useState<File[]>([]);
  const [source, setSource] = useState('AUTO');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStates, setTxStates] = useState<Record<string, TxState>>({});
  const [showFuture, setShowFuture] = useState(false);

  const isPdf = files.some((f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');

  function buildUrl(mode: 'preview' | 'commit') {
    const params = new URLSearchParams({ source, mode });
    if (password) params.set('password', password);
    return `/projects/${projectId}/credit-cards/${card.id}/import-statement?${params.toString()}`;
  }

  async function handlePreview() {
    if (files.length === 0) { setError('Selecione um arquivo'); return; }
    setError(null);
    setLoading(true);
    setPreview(null);
    setTxStates({});
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
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
    if (files.length === 0 || !preview) return;
    setLoading(true);
    setError(null);
    try {
      const decisions: ImportDecision[] = Object.values(txStates)
        .map((s) => s.decision)
        .filter((d): d is ImportDecision => !!d && (!!d.action || !!d.overrides));
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
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
    <Modal
      open
      onClose={onClose}
      title={`Importar fatura — ${card.nickname ?? `${card.brand} ****${card.last4}`}`}
      size="xl"
      variant="center"
    >
      {commitResult ? (
        <CommittedView result={commitResult} onClose={onCommitted} />
      ) : (
        <>
          <UploadStep
            files={files} setFiles={(f) => { setFiles(f); setPreview(null); setNeedsPassword(false); setPassword(''); setTxStates({}); }}
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
              <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 mb-3 text-sm">
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

              <div className="border rounded-xl overflow-hidden">
                <div className="bg-gray-50 px-3 py-2 text-xs font-medium text-gray-700 hidden sm:flex gap-2">
                  <span className="flex-1">Estabelecimento / Data</span>
                  <span className="w-32 text-right">Valor (R$)</span>
                  <span className="w-40">Categoria</span>
                  <span className="w-12"></span>
                </div>
                <div className="max-h-[45vh] overflow-y-auto divide-y divide-gray-100">
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

function UploadStep({
  files, setFiles, source, setSource, password, setPassword, isPdf, needsPassword, loading, onPreview,
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
}) {
  return (
    <div className="space-y-3 mb-4">
      <div>
        <label className="text-sm text-gray-600">Arquivos (OFX, CSV, PDF ou 📷 até 5 prints/fotos, máx 10MB cada)</label>
        <input
          type="file"
          multiple
          accept=".ofx,.csv,.txt,.pdf,image/png,image/jpeg,image/webp,image/heic,.png,.jpg,.jpeg,.webp,.heic"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))}
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
      <Button
        onClick={onPreview}
        disabled={files.length === 0 || loading}
        className="w-full"
        variant="secondary"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {loading ? 'Processando…' : 'Pré-visualizar'}
      </Button>
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
      <Button onClick={onClose} className="mt-6">Fechar</Button>
    </div>
  );
}
