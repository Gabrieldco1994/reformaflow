'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { X, Upload, CheckCircle2, AlertCircle } from 'lucide-react';
import type { BankAccountRow, BankPreviewResult, BankCommitResult } from '../_types';

interface Props {
  projectId: string;
  account: BankAccountRow;
  onClose: () => void;
  onCommitted: () => void;
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
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload<BankPreviewResult>(buildUrl('preview'), fd);
      setPreview(res);
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
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload<BankCommitResult>(buildUrl('commit'), fd);
      setCommitResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro no commit');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">
            Importar extrato — {account.nickname ?? `${account.institution} ****${account.last4}`}
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        {commitResult ? (
          <div className="text-center py-8">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h3 className="text-xl font-semibold mb-2">Importação concluída</h3>
            <div className="text-gray-700 space-y-1 text-sm">
              <p><strong>{commitResult.inserted}</strong> despesas inseridas</p>
              <p><strong>{commitResult.receiptsInserted}</strong> recebimentos (créditos)</p>
              <p><strong>{commitResult.cardPayments}</strong> pagamentos de fatura de cartão vinculados</p>
              <p><strong>{commitResult.aiReclassified}</strong> reclassificadas por IA</p>
              <p><strong>{commitResult.recurrencesCreated}</strong> recorrências propagadas para Casa/Carro</p>
              <p><strong>{commitResult.duplicated}</strong> ignoradas (duplicadas)</p>
              <p className="text-xs text-gray-500 mt-2">Período: {commitResult.periodLabel}</p>
            </div>
            <button onClick={onCommitted} className="mt-6 px-6 py-2 bg-blue-600 text-white rounded-lg">
              Fechar
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-3 mb-4">
              <div>
                <label className="text-sm text-gray-600">Arquivo (OFX, CSV ou PDF, máx 10MB)</label>
                <input
                  type="file"
                  accept=".ofx,.csv,.txt,.pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setFile(f);
                    setPreview(null);
                    setNeedsPassword(false);
                    setPassword('');
                  }}
                  className="w-full border rounded-lg p-2"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Formato</label>
                <select value={source} onChange={(e) => setSource(e.target.value)} className="w-full border rounded-lg p-2">
                  <option value="AUTO">Auto-detectar</option>
                  <option value="OFX">OFX</option>
                  <option value="CSV_GENERIC">CSV</option>
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
                    placeholder="Senha (ex: 6 últimos do CPF)"
                    className="w-full border rounded-lg p-2"
                    autoComplete="off"
                  />
                </div>
              )}

              <button
                onClick={handlePreview}
                disabled={!file || loading}
                className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg disabled:opacity-50"
              >
                {loading ? 'Processando…' : 'Pré-visualizar'}
              </button>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg flex gap-2">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {preview && (
              <div className="mt-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 text-sm">
                  <strong>{preview.totals.count}</strong> transações ·
                  total <strong>{formatCurrency(preview.totals.sumCents / 100)}</strong> ·
                  <strong> {preview.totals.duplicates}</strong> já existentes ·
                  formato detectado: <strong>{preview.source}</strong>
                </div>

                <div className="max-h-80 overflow-y-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-2">Data</th>
                        <th className="text-left p-2">Descrição</th>
                        <th className="text-right p-2">Valor</th>
                        <th className="text-left p-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.transactions.map((t) => (
                        <tr key={t.externalId} className={t.duplicate ? 'bg-yellow-50 text-gray-500' : ''}>
                          <td className="p-2">{formatDateBR(t.date)}</td>
                          <td className="p-2">{t.merchant}</td>
                          <td className={`p-2 text-right font-mono ${t.amountCents < 0 ? 'text-green-700' : ''}`}>
                            {formatCurrency(t.amountCents / 100)}
                          </td>
                          <td className="p-2">
                            {t.duplicate ? (
                              <span className="text-xs text-yellow-700">duplicada</span>
                            ) : (
                              <span className="text-xs text-green-700">nova</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
                  <button
                    onClick={handleCommit}
                    disabled={loading || preview.totals.count - preview.totals.duplicates === 0}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg flex items-center gap-2 disabled:opacity-50"
                  >
                    <Upload className="w-4 h-4" />
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
