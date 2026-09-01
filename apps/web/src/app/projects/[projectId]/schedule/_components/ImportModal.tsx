'use client';

import { useState } from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import { api } from '@/lib/api';

const SAMPLE_DATA = {
  dataInicio: '2025-01-06T12:00:00.000Z',
  trabalhaDiasUteis: true,
  trabalhaSabados: false,
  holidays: [
    { nome: 'Confraternização Universal', data: '2025-01-01T12:00:00.000Z' },
    { nome: 'Carnaval', data: '2025-03-04T12:00:00.000Z' },
    { nome: 'Paixão de Cristo', data: '2025-04-18T12:00:00.000Z' },
    { nome: 'Tiradentes', data: '2025-04-21T12:00:00.000Z' },
    { nome: 'Dia do Trabalho', data: '2025-05-01T12:00:00.000Z' },
    { nome: 'Corpus Christi', data: '2025-06-19T12:00:00.000Z' },
  ],
  stages: [
    {
      nome: 'DEMOLIÇÃO',
      tasks: [
        { numero: 2, nome: 'Demolir revestimentos', duracao: 7, predecessoras: null },
        { numero: 3, nome: 'Demolir alvenaria da porta de vidro', duracao: 2, predecessoras: '[2]' },
        { numero: 4, nome: 'Demolir piso e rodapé existente', duracao: 2, predecessoras: '[3]' },
        { numero: 5, nome: 'Demolir vãos porta piso teto', duracao: 1, predecessoras: '[3]' },
        { numero: 6, nome: 'Demolição para rodapé invertido', duracao: 2, predecessoras: '[5]' },
        { numero: 7, nome: 'Demolição bancadas', duracao: 1, predecessoras: '[5]' },
        { numero: 8, nome: 'Retirar louças e metais', duracao: 1, predecessoras: '[5]' },
        { numero: 9, nome: 'Demolição para nicho', duracao: 1, predecessoras: '[8]' },
      ],
    },
    {
      nome: 'CONSTRUÇÃO',
      tasks: [
        { numero: 11, nome: 'Construção das bases em alvenaria', duracao: 5, predecessoras: '[9]' },
        { numero: 12, nome: 'Regularização das alvenarias', duracao: 1, predecessoras: '[11]' },
        { numero: 13, nome: 'Regularização do contra piso', duracao: 1, predecessoras: '[12]' },
        { numero: 14, nome: 'Realocar condensadora', duracao: 2, predecessoras: '[13]' },
        { numero: 15, nome: 'Infraestrutura hidráulica', duracao: 5, predecessoras: '[14]' },
        { numero: 16, nome: 'Impermeabilização áreas molhadas', duracao: 3, predecessoras: '[15]' },
        { numero: 17, nome: 'Relocação dos ralos da varanda', duracao: 1, predecessoras: '[16]' },
      ],
    },
    {
      nome: 'ELÉTRICA',
      tasks: [
        { numero: 19, nome: 'Infraestrutura elétrica (tomadas)', duracao: 5, predecessoras: '[15]' },
        { numero: 20, nome: 'Interruptores', duracao: 1, predecessoras: '[19]' },
        { numero: 21, nome: 'Rabichos para fita de LED', duracao: 2, predecessoras: '[19]' },
      ],
    },
    {
      nome: 'FORRO',
      tasks: [
        { numero: 23, nome: 'Forro vinílico', duracao: 5, predecessoras: '[11]' },
        { numero: 24, nome: 'Cortineiros', duracao: 1, predecessoras: '[23]' },
        { numero: 25, nome: 'Refazer sancas para pé direito', duracao: 3, predecessoras: '[23]' },
      ],
    },
    {
      nome: 'REVESTIMENTOS',
      tasks: [{ numero: 27, nome: 'Colocação do azulejo banho', duracao: 5, predecessoras: '[25]' }],
    },
    {
      nome: 'PISO',
      tasks: [
        { numero: 29, nome: 'Colocação do porcelanato', duracao: 5, predecessoras: '[27]' },
        { numero: 30, nome: 'Instalação rodapé sobrepor', duracao: 2, predecessoras: '[29]' },
        { numero: 31, nome: 'Instalação rodapé embutir', duracao: 3, predecessoras: '[30]' },
        { numero: 32, nome: 'Instalação dos ralos', duracao: 1, predecessoras: '[29]' },
        { numero: 33, nome: 'Instalação cantoneira transição', duracao: 1, predecessoras: '[29]' },
      ],
    },
    {
      nome: 'PINTURA',
      tasks: [
        { numero: 38, nome: 'Textura cimento queimado', duracao: 4, predecessoras: '[33]' },
        { numero: 39, nome: 'Textura mineral branco capela', duracao: 9, predecessoras: '[33]' },
      ],
    },
    {
      nome: 'MARMORARIA',
      tasks: [
        { numero: 46, nome: 'Medição', duracao: 4, predecessoras: '[13]' },
        { numero: 47, nome: 'Instalação', duracao: 2, predecessoras: '[27]' },
      ],
    },
    {
      nome: 'MARCENÁRIA',
      tasks: [
        { numero: 53, nome: 'Instalação forro', duracao: 2, predecessoras: '[25]' },
        { numero: 55, nome: 'Instalação marcenaria', duracao: 7, predecessoras: '[53]' },
      ],
    },
    {
      nome: 'BOX E VIDRO',
      tasks: [
        { numero: 76, nome: 'Medição', duracao: 1, predecessoras: '[29]' },
        { numero: 77, nome: 'Instalação', duracao: 2, predecessoras: '[31]' },
      ],
    },
    {
      nome: 'LIMPEZA FINAL',
      tasks: [{ numero: 86, nome: 'Apto para entrega', duracao: 1, predecessoras: '[39]' }],
    },
  ],
};

function contagem(n: number, singular: string, plural: string) {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function ImportModal({
  projectId,
  onImported,
  onClose,
  stageCount,
  taskCount,
}: {
  projectId: string;
  onImported: () => void;
  onClose: () => void;
  stageCount: number;
  taskCount: number;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  // "Há cronograma" = existe QUALQUER etapa ou tarefa. A importação apaga os
  // dois (hard-delete no backend, sem desfazer), então count > 0 em qualquer
  // um já exige o passo de confirmação.
  const hasSchedule = stageCount > 0 || taskCount > 0;
  const resumo = `${contagem(stageCount, 'etapa', 'etapas')} e ${contagem(taskCount, 'tarefa', 'tarefas')}`;

  const handleImportSample = async () => {
    setLoading(true);
    setError('');
    try {
      await api.post(`/projects/${projectId}/schedule/import`, SAMPLE_DATA);
      onImported();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 max-h-[90dvh] overflow-y-auto">
        <h3 className="text-lg font-bold mb-4">Importar Cronograma</h3>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-2 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {error}
          </div>
        )}

        {!hasSchedule ? (
          <>
            <p className="text-sm text-gray-600 mb-4">
              Importe um cronograma modelo de obra com etapas e tarefas pré-configuradas,
              incluindo dependências entre tarefas e cálculo automático de datas.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleImportSample}
                disabled={loading}
                className="flex-1 min-h-[44px] bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Upload className="w-4 h-4" />
                {loading ? 'Importando...' : 'Importar Modelo de Obra'}
              </button>
              <button
                onClick={onClose}
                className="min-h-[44px] px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancelar
              </button>
            </div>
          </>
        ) : !confirming ? (
          <>
            <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-3 mb-4 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Isto vai substituir o cronograma atual.</p>
                <p className="mt-1">
                  O cronograma deste projeto tem hoje {resumo}. Importar o modelo de obra
                  apaga tudo isso — não há como desfazer.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setError('');
                  setConfirming(true);
                }}
                className="flex-1 min-h-[44px] bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 flex items-center justify-center gap-2"
              >
                Substituir cronograma
              </button>
              <button
                onClick={onClose}
                className="min-h-[44px] px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4 flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Apagar {resumo} e importar o modelo de obra?</p>
                <p className="mt-1">Esta ação não pode ser desfeita.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleImportSample}
                disabled={loading}
                className="flex-1 min-h-[44px] bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Upload className="w-4 h-4" />
                {loading ? 'Importando...' : 'Apagar e importar modelo'}
              </button>
              <button
                onClick={onClose}
                disabled={loading}
                className="min-h-[44px] px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
