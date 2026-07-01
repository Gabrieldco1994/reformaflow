'use client';

import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { PENDENCIA_STATUS_LABELS, type PendenciaStatus } from '@reformaflow/domain';
import type { PendenciaDTO } from '../_types';
import { PendenciaCard } from './PendenciaCard';

const COLUMN_TINT: Record<PendenciaStatus, string> = {
  PENDENTE: 'bg-lifeone-surface',
  ANDAMENTO: 'bg-lifeone-info',
  PARADO: 'bg-[#FBEBDC]',
  CONCLUIDO: 'bg-[#E3F6EA]',
};

const COLUMN_DOT: Record<PendenciaStatus, string> = {
  PENDENTE: 'bg-lifeone-ink-4',
  ANDAMENTO: 'bg-lifeone-blue',
  PARADO: 'bg-[#B5803A]',
  CONCLUIDO: 'bg-[#1E924A]',
};

interface Props {
  status: PendenciaStatus;
  items: PendenciaDTO[];
  onAdd: (status: PendenciaStatus) => void;
  onEdit: (p: PendenciaDTO) => void;
  onDelete: (p: PendenciaDTO) => void;
}

export function PendenciaColumn({ status, items, onAdd, onEdit, onDelete }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col w-[80vw] max-w-[300px] md:w-auto flex-shrink-0 md:flex-shrink rounded-[14px] border border-lifeone-hairline snap-start transition-colors ${
        isOver ? 'ring-2 ring-lifeone-blue/40' : ''
      } ${COLUMN_TINT[status]}`}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${COLUMN_DOT[status]}`} />
          <h2 className="font-geist font-semibold text-[13px] text-lifeone-ink">
            {PENDENCIA_STATUS_LABELS[status]}
          </h2>
          <span className="text-[12px] text-lifeone-ink-3">{items.length}</span>
        </div>
        <button
          type="button"
          onClick={() => onAdd(status)}
          aria-label={`Nova pendência em ${PENDENCIA_STATUS_LABELS[status]}`}
          className="p-1 rounded-md text-lifeone-ink-3 hover:text-lifeone-blue hover:bg-white/70 transition-all"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 flex flex-col gap-2 px-2 pb-3 min-h-[120px] overflow-y-auto">
        {items.length === 0 ? (
          <button
            type="button"
            onClick={() => onAdd(status)}
            className="flex-1 flex flex-col items-center justify-center gap-1 py-6 rounded-[10px] border border-dashed border-lifeone-hairline text-lifeone-ink-4 hover:text-lifeone-blue hover:border-lifeone-blue transition-all text-[13px]"
          >
            <Plus className="w-4 h-4" />
            Adicionar
          </button>
        ) : (
          items.map((p) => (
            <PendenciaCard key={p.id} pendencia={p} onEdit={onEdit} onDelete={onDelete} />
          ))
        )}
      </div>
    </div>
  );
}
