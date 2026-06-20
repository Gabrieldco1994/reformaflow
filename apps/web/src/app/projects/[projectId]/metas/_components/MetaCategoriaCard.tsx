'use client';
import { Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

export interface MetaProgress {
  tipoDespesa: string;
  limiteCents: number;
  gastoCents: number;
  pct: number;
}

/** Cor por % de uso do limite: <80 ok (laranja), <100 atenção (âmbar), >=100 estourado (vermelho). */
function tone(pct: number) {
  if (pct >= 100) return { bar: 'bg-red-600', txt: 'text-red-700', label: 'Estourou' };
  if (pct >= 80) return { bar: 'bg-amber-500', txt: 'text-amber-700', label: 'Atenção' };
  return { bar: 'bg-orange-500', txt: 'text-orange-700', label: 'No limite' };
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
