'use client';
import React from 'react';
import { Calendar, List } from 'lucide-react';
import type { ViewMode } from '../_types';

interface Props {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}

function ViewToggleImpl({ value, onChange }: Props) {
  const baseBtn =
    'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors';
  const activeBtn =
    'bg-white text-darc-velvet shadow-sm';
  const inactiveBtn =
    'text-darc-velvet/60 hover:text-darc-velvet';

  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-darc-linen/60 border border-darc-linen">
      <button
        type="button"
        aria-pressed={value === 'month'}
        onClick={() => onChange('month')}
        className={`${baseBtn} ${value === 'month' ? activeBtn : inactiveBtn}`}
      >
        <Calendar className="w-3.5 h-3.5" />
        Por mês
      </button>
      <button
        type="button"
        aria-pressed={value === 'type'}
        onClick={() => onChange('type')}
        className={`${baseBtn} ${value === 'type' ? activeBtn : inactiveBtn}`}
      >
        <List className="w-3.5 h-3.5" />
        Por tipo
      </button>
    </div>
  );
}

export const ViewToggle = React.memo(ViewToggleImpl);
