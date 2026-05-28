'use client';
import React from 'react';
import { LayoutGrid, Calendar, Layers } from 'lucide-react';

export type ExpenseViewMode = 'category' | 'month' | 'project';

interface Props {
  value: ExpenseViewMode;
  onChange: (v: ExpenseViewMode) => void;
  showProject?: boolean;
}

export function ExpenseViewToggle({ value, onChange, showProject = false }: Props) {
  const baseBtn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors';
  const active = 'bg-orange-500 text-white';
  const inactive = 'bg-white text-gray-600 hover:bg-gray-50';
  return (
    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => onChange('category')}
        className={`${baseBtn} ${value === 'category' ? active : inactive}`}
      >
        <LayoutGrid className="w-3.5 h-3.5" /> Categoria
      </button>
      <button
        type="button"
        onClick={() => onChange('month')}
        className={`${baseBtn} border-l border-gray-200 ${value === 'month' ? active : inactive}`}
      >
        <Calendar className="w-3.5 h-3.5" /> Mês
      </button>
      {showProject && (
        <button
          type="button"
          onClick={() => onChange('project')}
          className={`${baseBtn} border-l border-gray-200 ${value === 'project' ? active : inactive}`}
        >
          <Layers className="w-3.5 h-3.5" /> Por projeto
        </button>
      )}
    </div>
  );
}
