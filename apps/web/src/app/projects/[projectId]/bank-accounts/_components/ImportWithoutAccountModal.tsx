'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Upload, AlertCircle, Loader2, X } from 'lucide-react';

interface Props {
  projectId: string;
  onClose: () => void;
  onCommitted: () => void;
}

export default function ImportWithoutAccountModal({
  projectId,
  onClose,
  onCommitted,
}: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleImport() {
    if (files.length === 0) {
      setError('Selecione um arquivo para importar');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const fd = new FormData();
      for (const f of files) {
        fd.append('files', f);
      }

      await api.upload<{ count: number }>(
        `/projects/${projectId}/receipts/import?origin=none`,
        fd,
      );

      setSuccess(true);
      setTimeout(() => {
        onCommitted();
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao importar arquivo');
    } finally {
      setLoading(false);
    }
  }

  function handleFilesChange(event: React.ChangeEvent<HTMLInputElement>) {
    const newFiles = Array.from(event.target.files || []);
    setFiles(newFiles);
    setError(null);
  }

  if (success) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg w-full max-w-md p-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
          <h2 className="text-lg font-bold mb-2">Importação concluída!</h2>
          <p className="text-sm text-gray-600">
            Seus recebimentos foram importados com sucesso. Você poderá vincular uma conta depois.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">Importar sem conta</h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Importe seus recebimentos de um arquivo CSV, OFX, ou TXT. Depois você poderá vincular a uma conta real para reconciliação automática.
        </p>

        <div className="mb-4 p-4 rounded-lg border-2 border-dashed border-gray-300 hover:border-blue-400 transition-colors">
          <input
            type="file"
            multiple
            onChange={handleFilesChange}
            disabled={loading}
            accept=".csv,.ofx,.txt,.pdf"
            className="hidden"
            id="file-input"
          />
          <label
            htmlFor="file-input"
            className="flex flex-col items-center gap-2 cursor-pointer"
          >
            <Upload className="w-8 h-8 text-gray-400" />
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700">Clique para selecionar</p>
              <p className="text-xs text-gray-500">CSV, OFX, TXT ou PDF</p>
            </div>
          </label>
        </div>

        {files.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-medium text-gray-700 mb-2">Arquivo selecionado:</p>
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li key={i} className="text-sm text-gray-600 flex items-center gap-2">
                  <span className="w-4 h-4 bg-blue-100 rounded flex items-center justify-center text-xs text-blue-600">✓</span>
                  {f.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleImport}
            disabled={loading || files.length === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Importando…
              </>
            ) : (
              'Importar'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
