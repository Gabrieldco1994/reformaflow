'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { ScheduleStage } from '../_types';

export function AddTaskModal({
  projectId,
  stages,
  onCreated,
  onClose,
}: {
  projectId: string;
  stages: ScheduleStage[];
  onCreated: () => void;
  onClose: () => void;
}) {
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [nome, setNome] = useState('');
  const [duracao, setDuracao] = useState(1);
  const [predecessoras, setPredecessoras] = useState('');
  const [loading, setLoading] = useState(false);

  const nextNumero = useMemo(() => {
    const allTasks = stages.flatMap((s) => s.tasks);
    return Math.max(0, ...allTasks.map((t) => t.numero)) + 1;
  }, [stages]);

  const handleSubmit = async () => {
    if (!nome.trim() || !stageId) return;
    setLoading(true);
    const predArray = predecessoras ? `[${predecessoras}]` : undefined;
    const stage = stages.find((s) => s.id === stageId);
    const ordem = stage ? stage.tasks.length : 0;

    await api.post(`/projects/${projectId}/schedule/tasks`, {
      stageId,
      numero: nextNumero,
      nome: nome.trim(),
      duracao,
      predecessoras: predArray,
      ordem,
    });
    onCreated();
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-bold mb-4">Nova Tarefa</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Etapa</label>
            <select
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm"
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Nome da Tarefa</label>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm"
              placeholder="Ex: Instalação do piso"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500 block mb-1">Duração (dias)</label>
              <input
                type="number"
                min={1}
                value={duracao}
                onChange={(e) => setDuracao(parseInt(e.target.value) || 1)}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500 block mb-1">Predecessoras (N°)</label>
              <input
                value={predecessoras}
                onChange={(e) => setPredecessoras(e.target.value)}
                className="w-full border rounded px-2 py-1.5 text-sm"
                placeholder="Ex: 2,3"
              />
            </div>
          </div>
        </div>
        <div className="flex gap-3 mt-4">
          <button
            onClick={handleSubmit}
            disabled={loading || !nome.trim()}
            className="flex-1 bg-brand-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? 'Criando...' : 'Criar Tarefa'}
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
