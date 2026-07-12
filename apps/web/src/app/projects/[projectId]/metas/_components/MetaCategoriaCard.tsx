'use client';
import { Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { metaProgressTone as tone } from '../_lib/metaTone';

export interface MetaProgress {
  tipoDespesa: string;
  limiteCents: number;
  gastoCents: number;
  pct: number;
}

export function MetaCategoriaCard({
  item,
  label,
  onEdit,
  onDelete,
}: {
  item: MetaProgress;
  label: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = tone(item.pct);
  const width = Math.min(100, Math.max(0, item.pct));
  return (
    <div className="group rounded-2xl border border-darc-linen bg-white p-4 shadow-darc-soft">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onEdit} className="min-w-0 text-left">
          <p className="truncate text-sm font-semibold text-darc-velvet">{label}</p>
          <p className="text-[11px] text-darc-velvet/50">
            {formatCurrency(item.gastoCents / 100)} de {formatCurrency(item.limiteCents / 100)}
          </p>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${t.txt} bg-orange-50`}>
            {item.pct}% · {t.label}
          </span>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-darc-velvet/30 hover:bg-red-50 hover:text-red-500"
            title="Remover meta"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-darc-linen">
        <div className={`h-full rounded-full ${t.bar} transition-all`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
