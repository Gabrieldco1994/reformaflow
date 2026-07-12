'use client';

import { Check, Clock, Edit2, Trash2 } from 'lucide-react';
import { CardActionsMenu, type CardAction } from '@/components/CardActionsMenu';
import { formatDateBR } from '@/lib/utils';

export interface ReminderRow {
  id: string;
  titulo: string;
  descricao?: string;
  data: string;
  recorrencia: string;
  status: string;
  prioridade: string;
}

const PRIORIDADES: Record<string, { label: string; color: string }> = {
  BAIXA: { label: 'Baixa', color: 'bg-gray-100 text-gray-600' },
  MEDIA: { label: 'Média', color: 'bg-blue-100 text-blue-700' },
  ALTA: { label: 'Alta', color: 'bg-amber-100 text-amber-700' },
  URGENTE: { label: 'Urgente', color: 'bg-red-100 text-red-700' },
};

const RECORRENCIAS: Record<string, string> = {
  UNICA: 'Única',
  DIARIA: 'Diária',
  SEMANAL: 'Semanal',
  MENSAL: 'Mensal',
  ANUAL: 'Anual',
};

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  PENDENTE: { label: 'Pendente', color: 'bg-amber-100 text-amber-700' },
  CONCLUIDO: { label: 'Concluído', color: 'bg-green-100 text-green-700' },
  ADIADO: { label: 'Adiado', color: 'bg-gray-100 text-gray-500' },
};

export interface ReminderCardProps {
  reminder: ReminderRow;
  onMarkDone: (id: string) => void;
  onPostpone: (id: string) => void;
  onEdit: (reminder: ReminderRow) => void;
  onDelete: (id: string) => void;
}

/** Card de lembrete — extraído de `reminders/page.tsx` (Fase G, 3 camadas). */
export function ReminderCard({
  reminder: r,
  onMarkDone,
  onPostpone,
  onEdit,
  onDelete,
}: ReminderCardProps) {
  const prio = PRIORIDADES[r.prioridade];
  const statusCfg = STATUS_CONFIG[r.status];
  const recLabel = RECORRENCIAS[r.recorrencia];

  const actions: CardAction[] = [];
  if (r.status === 'PENDENTE') {
    actions.push({ label: 'Concluir', onClick: () => onMarkDone(r.id), icon: <Check className="h-4 w-4" /> });
    actions.push({ label: 'Adiar', onClick: () => onPostpone(r.id), icon: <Clock className="h-4 w-4" /> });
  }
  actions.push({ label: 'Editar', onClick: () => onEdit(r), icon: <Edit2 className="h-4 w-4" /> });
  actions.push({ label: 'Excluir', onClick: () => onDelete(r.id), icon: <Trash2 className="h-4 w-4" />, tone: 'danger' });

  return (
    <article
      aria-label={r.titulo}
      className={`flex items-start gap-4 rounded-lg border bg-white p-4 ${r.status === 'CONCLUIDO' ? 'opacity-60' : ''}`}
    >
      {r.status === 'PENDENTE' && (
        <button
          type="button"
          onClick={() => onMarkDone(r.id)}
          className="mt-0.5 rounded-full border-2 border-gray-300 p-1 transition-colors hover:border-green-500 hover:bg-green-50"
          title="Concluir"
        >
          <Check className="h-4 w-4 text-gray-300 hover:text-green-600" />
        </button>
      )}
      {r.status === 'CONCLUIDO' && (
        <div className="mt-0.5 rounded-full bg-green-100 p-1">
          <Check className="h-4 w-4 text-green-600" />
        </div>
      )}
      {r.status === 'ADIADO' && (
        <div className="mt-0.5 rounded-full bg-gray-100 p-1">
          <Clock className="h-4 w-4 text-gray-400" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className={`font-medium ${r.status === 'CONCLUIDO' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
            {r.titulo}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${prio?.color ?? ''}`}>
            {prio?.label}
          </span>
        </div>
        {r.descricao && <p className="mb-1 text-sm text-gray-500">{r.descricao}</p>}
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span>{formatDateBR(r.data)}</span>
          {r.recorrencia !== 'UNICA' && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5">{recLabel}</span>
          )}
          <span className={`rounded px-1.5 py-0.5 ${statusCfg?.color ?? ''}`}>{statusCfg?.label}</span>
        </div>
      </div>

      <CardActionsMenu ariaLabel={`Ações ${r.titulo}`} actions={actions} />
    </article>
  );
}
