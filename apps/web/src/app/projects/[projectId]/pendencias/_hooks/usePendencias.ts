'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  PendenciaDTO,
  CreatePendenciaInput,
  UpdatePendenciaInput,
  MoveInput,
  RoomOption,
  ScheduleTaskOption,
} from '../_types';
import { groupByStatus } from '../_lib/group';

const key = (projectId: string) => ['pendencias', projectId] as const;

export function usePendenciasQuery(projectId: string) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: () => api.get<PendenciaDTO[]>(`/projects/${projectId}/pendencias`),
    enabled: !!projectId,
  });
}

/** Ambientes do projeto (o projeto inclui `rooms`). */
export function useRoomsQuery(projectId: string) {
  return useQuery({
    queryKey: ['project-rooms', projectId],
    queryFn: async () => {
      const project = await api.get<{ rooms?: RoomOption[] }>(`/projects/${projectId}`);
      return project.rooms ?? [];
    },
    enabled: !!projectId,
  });
}

/** Tarefas do cronograma (via gantt). */
export function useScheduleTasksQuery(projectId: string) {
  return useQuery({
    queryKey: ['project-schedule-tasks', projectId],
    queryFn: async () => {
      const gantt = await api.get<{ stages: Array<{ tasks: ScheduleTaskOption[] }> }>(
        `/projects/${projectId}/schedule/gantt`,
      );
      return gantt.stages.flatMap((s) => s.tasks).map((t) => ({ id: t.id, nome: t.nome, numero: t.numero }));
    },
    enabled: !!projectId,
  });
}

export function useCreatePendencia(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePendenciaInput) =>
      api.post<PendenciaDTO>(`/projects/${projectId}/pendencias`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  });
}

export function useUpdatePendencia(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdatePendenciaInput & { id: string }) =>
      api.patch<PendenciaDTO>(`/projects/${projectId}/pendencias/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  });
}

export function useDeletePendencia(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/pendencias/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  });
}

/** Move otimista: atualiza o cache antes da resposta; faz rollback em erro. */
export function useMovePendencia(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, order }: MoveInput) =>
      api.patch<PendenciaDTO>(`/projects/${projectId}/pendencias/${id}/move`, { status, order }),
    onMutate: async ({ id, status, order }: MoveInput) => {
      await qc.cancelQueries({ queryKey: key(projectId) });
      const prev = qc.getQueryData<PendenciaDTO[]>(key(projectId));
      if (prev) {
        qc.setQueryData<PendenciaDTO[]>(
          key(projectId),
          prev.map((it) => (it.id === id ? { ...it, status, order } : it)),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key(projectId), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key(projectId) }),
  });
}

export { groupByStatus };
