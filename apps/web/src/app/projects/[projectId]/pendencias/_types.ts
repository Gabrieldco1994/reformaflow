import type { PendenciaStatus } from '@reformaflow/domain';

/** Item retornado pelo GET /projects/:projectId/pendencias (denormalizado). */
export interface PendenciaDTO {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: PendenciaStatus;
  dueDate: string | null;
  owner: string | null;
  roomId: string | null;
  roomName: string | null;
  scheduleTaskId: string | null;
  scheduleTaskNome: string | null;
  scheduleTaskNumero: number | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** Payload de criação (POST). */
export interface CreatePendenciaInput {
  title: string;
  description?: string | null;
  status?: PendenciaStatus;
  dueDate?: string | null;
  owner?: string | null;
  roomId?: string | null;
  scheduleTaskId?: string | null;
}

/** Payload de atualização (PATCH :id). */
export interface UpdatePendenciaInput {
  title?: string;
  description?: string | null;
  status?: PendenciaStatus;
  dueDate?: string | null;
  owner?: string | null;
  roomId?: string | null;
  scheduleTaskId?: string | null;
}

/** Payload de movimentação de coluna (PATCH :id/move). */
export interface MoveInput {
  id: string;
  status: PendenciaStatus;
  order: number;
}

/** Fonte de dados para o select de ambiente. */
export interface RoomOption {
  id: string;
  name: string;
}

/** Fonte de dados para o select de tarefa do cronograma. */
export interface ScheduleTaskOption {
  id: string;
  nome: string;
  numero: number;
}
