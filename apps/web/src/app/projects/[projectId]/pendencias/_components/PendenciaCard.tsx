'use client';

import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { CalendarDays, User, MapPin, ListTree, Trash2 } from 'lucide-react';
import type { PendenciaDTO } from '../_types';

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface Props {
  pendencia: PendenciaDTO;
  onEdit: (p: PendenciaDTO) => void;
  onDelete: (p: PendenciaDTO) => void;
}

export function PendenciaCard({ pendencia, onEdit, onDelete }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: pendencia.id });
  const due = formatDate(pendencia.dueDate);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.5 : 1 }}
      className="group relative bg-lifeone-card border border-lifeone-hairline rounded-[12px] shadow-lifeone-card p-3 select-none"
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        onClick={() => onEdit(pendencia)}
        className="block w-full text-left cursor-grab active:cursor-grabbing"
        aria-label={`Pendência: ${pendencia.title}`}
      >
        <p className="font-geist font-semibold text-[14px] text-lifeone-ink leading-snug pr-5">
          {pendencia.title}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-lifeone-ink-3">
          {pendencia.owner && (
            <span className="inline-flex items-center gap-1">
              <User className="w-3.5 h-3.5" /> {pendencia.owner}
            </span>
          )}
          {due && (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="w-3.5 h-3.5" /> {due}
            </span>
          )}
        </div>

        {(pendencia.roomName || pendencia.scheduleTaskNome) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pendencia.roomName && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-lifeone-info text-lifeone-blue">
                <MapPin className="w-3 h-3" /> {pendencia.roomName}
              </span>
            )}
            {pendencia.scheduleTaskNome && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-lifeone-surface text-lifeone-ink-2">
                <ListTree className="w-3 h-3" />
                {pendencia.scheduleTaskNumero != null ? `#${pendencia.scheduleTaskNumero} ` : ''}
                {pendencia.scheduleTaskNome}
              </span>
            )}
          </div>
        )}
      </button>

      <button
        type="button"
        onClick={() => onDelete(pendencia)}
        aria-label="Excluir pendência"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded-md text-lifeone-ink-4 hover:text-[#D92D20] hover:bg-[#FEF3F2] transition-all"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
