'use client';

import React from 'react';
import { GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Expense } from '@/types';
import { LinkPreviewCard } from './LinkPreviewCard';

export function SortableCard({ expense, tipoLabel }: { expense: Expense; tipoLabel: (t: string) => string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: expense.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <div
        {...attributes}
        {...listeners}
        className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 z-10 p-0.5 sm:p-1 rounded-md bg-white/80 backdrop-blur-sm shadow-sm cursor-grab active:cursor-grabbing hover:bg-white transition-colors"
      >
        <GripVertical className="w-3 h-3 sm:w-4 sm:h-4 text-gray-400" />
      </div>
      <LinkPreviewCard expense={expense} tipoLabel={tipoLabel} />
    </div>
  );
}

