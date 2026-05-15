'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

export function AddStageModal({
  projectId,
  stagesCount,
  onCreated,
  onClose,
}: {
  projectId: string;
  stagesCount: number;
  onCreated: () => void;
  onClose: () => void;
}) {
  const [nome, setNome] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!nome.trim()) return;
    setLoading(true);
    await api.post(`/projects/${projectId}/schedule/stages`, {
      nome: nome.trim(),
      ordem: stagesCount,
    });
    onCreated();
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-bold mb-4">Nova Etapa</h3>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Nome da Etapa</label>
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm"
            placeholder="Ex: DEMOLIÇÃO"
            autoFocus
          />
        </div>
        <div className="flex gap-3 mt-4">
          <button
            onClick={handleSubmit}
            disabled={loading || !nome.trim()}
            className="flex-1 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? 'Criando...' : 'Criar Etapa'}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
