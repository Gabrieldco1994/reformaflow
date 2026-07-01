import type { PendenciaDTO, MoveInput } from '../_types';
import { PENDENCIA_STATUS_COLUMNS, type PendenciaStatus } from '@reformaflow/domain';

export type Grouped = Record<PendenciaStatus, PendenciaDTO[]>;

/**
 * Agrupa as pendências pelas 4 colunas do Kanban. Retorna SEMPRE as 4 chaves
 * (arrays vazios para colunas sem itens), cada coluna ordenada por `order` e,
 * em empate, por `id` (secundária determinística, espelha o orderBy da API).
 */
export function groupByStatus(items: PendenciaDTO[]): Grouped {
  const grouped = {} as Grouped;
  for (const status of PENDENCIA_STATUS_COLUMNS) {
    grouped[status] = [];
  }
  for (const item of items) {
    if (grouped[item.status]) grouped[item.status].push(item);
    else grouped[item.status] = [item];
  }
  for (const status of PENDENCIA_STATUS_COLUMNS) {
    grouped[status].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  }
  return grouped;
}

interface DragEndLike {
  active: { id: string | number };
  over: { id: string | number } | null;
}

/**
 * Fábrica do handler de fim de arraste (dnd-kit). Extraída como função pura
 * para ser testável sem simular um drag real. `over.id` é o status da coluna
 * de destino. Calcula a nova posição (fim da coluna de destino) e chama `move`.
 * No-op quando `over` é nulo (solto fora de qualquer coluna).
 */
export function makeDragEndHandler({
  items,
  move,
}: {
  items: PendenciaDTO[];
  move: (input: MoveInput) => void;
}) {
  return (event: DragEndLike) => {
    if (!event.over) return;
    const id = String(event.active.id);
    const targetStatus = String(event.over.id) as PendenciaStatus;
    if (!PENDENCIA_STATUS_COLUMNS.includes(targetStatus)) return;

    const dragged = items.find((it) => it.id === id);
    if (!dragged) return;

    const targetItems = items.filter((it) => it.status === targetStatus && it.id !== id);
    const maxOrder = targetItems.reduce((max, it) => Math.max(max, it.order), -1);
    const order = maxOrder + 1;

    if (dragged.status === targetStatus && dragged.order === order) return;
    move({ id, status: targetStatus, order });
  };
}
