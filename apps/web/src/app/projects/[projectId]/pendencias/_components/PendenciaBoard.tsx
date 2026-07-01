'use client';

import { useMemo, useState } from 'react';
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCorners } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PENDENCIA_STATUS_COLUMNS, PendenciaStatus } from '@reformaflow/domain';
import type { PendenciaDTO } from '../_types';
import { groupByStatus, makeDragEndHandler } from '../_lib/group';
import {
  usePendenciasQuery,
  useRoomsQuery,
  useScheduleTasksQuery,
  useCreatePendencia,
  useUpdatePendencia,
  useDeletePendencia,
  useMovePendencia,
} from '../_hooks/usePendencias';
import { PendenciaColumn } from './PendenciaColumn';
import { PendenciaModal, type PendenciaFormValue } from './PendenciaModal';

function toPayload(v: PendenciaFormValue) {
  return {
    title: v.title.trim(),
    description: v.description.trim() || null,
    status: v.status,
    dueDate: v.dueDate ? new Date(v.dueDate).toISOString() : null,
    owner: v.owner.trim() || null,
    roomId: v.roomId || null,
    scheduleTaskId: v.scheduleTaskId || null,
  };
}

export function PendenciaBoard({ projectId }: { projectId: string }) {
  const { data: items = [], isLoading, error } = usePendenciasQuery(projectId);
  const { data: rooms = [] } = useRoomsQuery(projectId);
  const { data: tasks = [] } = useScheduleTasksQuery(projectId);
  const create = useCreatePendencia(projectId);
  const update = useUpdatePendencia(projectId);
  const remove = useDeletePendencia(projectId);
  const move = useMovePendencia(projectId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PendenciaDTO | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<PendenciaStatus>(PendenciaStatus.PENDENTE);

  const grouped = useMemo(() => groupByStatus(items), [items]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const onDragEnd = useMemo(
    () => makeDragEndHandler({ items, move: (input) => move.mutate(input) }),
    [items, move],
  );

  function openCreate(status: PendenciaStatus) {
    setEditing(null);
    setDefaultStatus(status);
    setModalOpen(true);
  }
  function openEdit(p: PendenciaDTO) {
    setEditing(p);
    setModalOpen(true);
  }
  function handleDelete(p: PendenciaDTO) {
    if (!confirm(`Excluir a pendência "${p.title}"?`)) return;
    remove.mutate(p.id, { onSuccess: () => toast.success('Pendência excluída') });
  }
  function handleSubmit(v: PendenciaFormValue) {
    const payload = toPayload(v);
    if (editing) {
      update.mutate(
        { id: editing.id, ...payload },
        {
          onSuccess: () => {
            toast.success('Pendência atualizada');
            setModalOpen(false);
          },
        },
      );
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          toast.success('Pendência criada');
          setModalOpen(false);
        },
      });
    }
  }

  return (
    <div className="font-geist">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-[24px] md:text-[28px] font-bold tracking-[-0.02em] text-lifeone-ink leading-tight">
            Pendências
          </h1>
          <p className="text-[13px] text-lifeone-ink-3 mt-0.5">Organize as tarefas da reforma por status</p>
        </div>
        <button
          type="button"
          onClick={() => openCreate(PendenciaStatus.PENDENTE)}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-lifeone-blue text-[#FFFFFF] text-[14px] font-semibold rounded-[10px] hover:brightness-95 transition-all"
        >
          <Plus className="w-4 h-4" /> Nova pendência
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-40 rounded-[14px] bg-lifeone-surface animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-[14px] border border-[#FECDCA] bg-[#FEF3F2] p-4 text-[14px] text-[#B42318]">
          Não foi possível carregar as pendências. Tente novamente.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          <div className="flex md:grid md:grid-cols-4 gap-3 overflow-x-auto snap-x pb-2 -mx-1 px-1">
            {PENDENCIA_STATUS_COLUMNS.map((status) => (
              <PendenciaColumn
                key={status}
                status={status}
                items={grouped[status]}
                onAdd={openCreate}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </DndContext>
      )}

      <PendenciaModal
        open={modalOpen}
        editing={editing}
        defaultStatus={defaultStatus}
        rooms={rooms}
        tasks={tasks}
        saving={create.isPending || update.isPending}
        onClose={() => setModalOpen(false)}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
