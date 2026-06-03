'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { ScheduleStage } from '../_types';
import { ROW_H } from './EditableTaskRow';

export function EditableStageRow({
  stage,
  collapsed,
  onToggle,
  onRename,
  onDelete,
  compact = false,
}: {
  stage: ScheduleStage;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(stage.nome);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== stage.nome) onRename(trimmed);
    else setValue(stage.nome);
    setEditing(false);
  };

  return (
    <div
      className="flex items-center bg-darc-pink-logo/60 border-y border-darc-pink-logo hover:bg-darc-pink-logo group"
      style={{ height: ROW_H }}
    >
      <button
        className="w-8 flex justify-center text-darc-raspberry hover:text-darc-velvet"
        onClick={onToggle}
        title={collapsed ? 'Expandir etapa' : 'Recolher etapa'}
      >
        {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      <div className="w-10 px-1 text-[11px] font-bold text-darc-raspberry tabular-nums">{stage.tasks[0]?.numero ?? ''}</div>
      <div className="flex-1 min-w-[320px] px-2 text-sm font-bold uppercase tracking-wider text-darc-velvet truncate">
        {editing ? (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') {
                setValue(stage.nome);
                setEditing(false);
              }
            }}
            autoFocus
            className="w-full bg-white border border-darc-red rounded px-1.5 py-0.5 text-sm font-bold uppercase tracking-wider text-darc-velvet outline-none"
          />
        ) : (
          <button
            className="w-full text-left truncate hover:text-darc-red"
            onDoubleClick={() => setEditing(true)}
            onClick={onToggle}
            title="Clique para expandir/recolher. Duplo clique para renomear."
          >
            {stage.nome}
          </button>
        )}
      </div>
      {!compact && (
        <>
          <div className="w-14" />
          <div className="w-14" />
          <div className="w-[104px]" />
          <div className="w-[104px]" />
        </>
      )}
      <div className="w-20" />
      <button
        onClick={onDelete}
        className="w-8 flex justify-center text-darc-raspberry/40 opacity-0 group-hover:opacity-100 hover:text-darc-red transition"
        title="Excluir etapa"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
