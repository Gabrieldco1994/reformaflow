'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/modal';
import {
  PENDENCIA_STATUS_COLUMNS,
  PENDENCIA_STATUS_LABELS,
  PendenciaStatus,
} from '@reformaflow/domain';
import type { PendenciaDTO, RoomOption, ScheduleTaskOption } from '../_types';

const inputClass =
  'w-full bg-lifeone-surface border border-lifeone-hairline rounded-[10px] px-3 py-2 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:outline-none focus:border-lifeone-blue focus:ring-2 focus:ring-lifeone-blue/25 transition-all';
const labelClass = 'block text-[12px] font-medium text-lifeone-ink-2 mb-1';

export interface PendenciaFormValue {
  title: string;
  description: string;
  status: PendenciaStatus;
  dueDate: string;
  owner: string;
  roomId: string;
  scheduleTaskId: string;
}

interface Props {
  open: boolean;
  editing: PendenciaDTO | null;
  defaultStatus: PendenciaStatus;
  rooms: RoomOption[];
  tasks: ScheduleTaskOption[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (value: PendenciaFormValue) => void;
}

function toDateInput(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

export function PendenciaModal({
  open,
  editing,
  defaultStatus,
  rooms,
  tasks,
  saving,
  onClose,
  onSubmit,
}: Props) {
  const [value, setValue] = useState<PendenciaFormValue>({
    title: '',
    description: '',
    status: defaultStatus,
    dueDate: '',
    owner: '',
    roomId: '',
    scheduleTaskId: '',
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setValue({
        title: editing.title,
        description: editing.description ?? '',
        status: editing.status,
        dueDate: toDateInput(editing.dueDate),
        owner: editing.owner ?? '',
        roomId: editing.roomId ?? '',
        scheduleTaskId: editing.scheduleTaskId ?? '',
      });
    } else {
      setValue({
        title: '',
        description: '',
        status: defaultStatus,
        dueDate: '',
        owner: '',
        roomId: '',
        scheduleTaskId: '',
      });
    }
    setError(null);
  }, [open, editing, defaultStatus]);

  function handleSubmit() {
    if (!value.title.trim()) {
      setError('Informe um título para a pendência.');
      return;
    }
    onSubmit(value);
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Editar pendência' : 'Nova pendência'} size="md">
      <div className="space-y-3 font-geist">
        <div>
          <label className={labelClass}>Título</label>
          <input
            className={inputClass}
            value={value.title}
            onChange={(e) => setValue((v) => ({ ...v, title: e.target.value }))}
            placeholder="Ex: Comprar tinta do quarto"
            autoFocus
          />
        </div>

        <div>
          <label className={labelClass}>Descrição (opcional)</label>
          <textarea
            className={inputClass}
            rows={2}
            value={value.description}
            onChange={(e) => setValue((v) => ({ ...v, description: e.target.value }))}
            placeholder="Detalhes da pendência"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Status</label>
            <select
              className={inputClass}
              value={value.status}
              onChange={(e) => setValue((v) => ({ ...v, status: e.target.value as PendenciaStatus }))}
            >
              {PENDENCIA_STATUS_COLUMNS.map((s) => (
                <option key={s} value={s}>
                  {PENDENCIA_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Prazo (opcional)</label>
            <input
              type="date"
              className={inputClass}
              value={value.dueDate}
              onChange={(e) => setValue((v) => ({ ...v, dueDate: e.target.value }))}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>Responsável (opcional)</label>
          <input
            className={inputClass}
            value={value.owner}
            onChange={(e) => setValue((v) => ({ ...v, owner: e.target.value }))}
            placeholder="Nome do responsável"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Ambiente (opcional)</label>
            <select
              className={inputClass}
              value={value.roomId}
              onChange={(e) => setValue((v) => ({ ...v, roomId: e.target.value }))}
              disabled={rooms.length === 0}
            >
              <option value="">{rooms.length === 0 ? 'Nenhum ambiente cadastrado' : 'Sem ambiente'}</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Tarefa do cronograma (opcional)</label>
            <select
              className={inputClass}
              value={value.scheduleTaskId}
              onChange={(e) => setValue((v) => ({ ...v, scheduleTaskId: e.target.value }))}
              disabled={tasks.length === 0}
            >
              <option value="">{tasks.length === 0 ? 'Nenhuma tarefa cadastrada' : 'Sem tarefa'}</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  #{t.numero} {t.nome}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <div className="text-[13px] text-[#B42318] bg-[#FEF3F2] border border-[#FECDCA] rounded-[10px] px-3 py-2">
            {error}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3 mt-5 pt-4 border-t border-lifeone-hairline">
        <button
          onClick={onClose}
          className="px-4 py-2 text-[14px] font-medium text-lifeone-ink-2 hover:text-lifeone-ink transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving || !value.title.trim()}
          className="px-4 py-2 bg-lifeone-blue text-[#FFFFFF] text-[14px] font-semibold rounded-[10px] hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          {saving ? 'Salvando…' : editing ? 'Salvar' : 'Criar'}
        </button>
      </div>
    </Modal>
  );
}
