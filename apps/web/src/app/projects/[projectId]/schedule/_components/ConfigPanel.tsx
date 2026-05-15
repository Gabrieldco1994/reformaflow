'use client';

import { useState } from 'react';
import { Calendar, ChevronDown, ChevronRight } from 'lucide-react';
import type { ScheduleConfig } from '../_types';

export function ConfigPanel({
  config,
  onSave,
}: {
  config: ScheduleConfig | null;
  onSave: (data: Partial<ScheduleConfig>) => void;
}) {
  const [open, setOpen] = useState(!config);
  const [dataInicio, setDataInicio] = useState(
    config?.dataInicio?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
  );
  const [diasUteis, setDiasUteis] = useState(config?.trabalhaDiasUteis ?? true);
  const [sabados, setSabados] = useState(config?.trabalhaSabados ?? false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-800"
      >
        <Calendar className="w-4 h-4" />
        Configuração do Projeto
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-2 bg-white border rounded-lg p-4 flex flex-wrap gap-4 items-end">
          <div>
            <label className="text-xs text-gray-500 block">Data Início do Projeto</label>
            <input
              type="date"
              value={dataInicio}
              onChange={(e) => setDataInicio(e.target.value)}
              className="border rounded px-2 py-1 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={diasUteis} onChange={(e) => setDiasUteis(e.target.checked)} />
            Só dias úteis
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sabados} onChange={(e) => setSabados(e.target.checked)} />
            Trabalha sábados
          </label>
          <button
            onClick={() =>
              onSave({
                dataInicio: new Date(dataInicio + 'T12:00:00').toISOString(),
                trabalhaDiasUteis: diasUteis,
                trabalhaSabados: sabados,
              })
            }
            className="bg-brand-600 text-white px-4 py-1.5 rounded text-sm hover:bg-brand-700"
          >
            Salvar
          </button>
        </div>
      )}
    </div>
  );
}
