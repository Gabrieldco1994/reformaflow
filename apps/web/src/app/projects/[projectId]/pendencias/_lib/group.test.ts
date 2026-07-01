import { describe, it, expect, vi } from 'vitest';
import { groupByStatus, makeDragEndHandler } from './group';
import type { PendenciaDTO } from '../_types';
import { PendenciaStatus } from '@reformaflow/domain';

function p(partial: Partial<PendenciaDTO> & { id: string }): PendenciaDTO {
  return {
    projectId: 'proj1',
    title: 't',
    description: null,
    status: PendenciaStatus.PENDENTE,
    dueDate: null,
    owner: null,
    roomId: null,
    roomName: null,
    scheduleTaskId: null,
    scheduleTaskNome: null,
    scheduleTaskNumero: null,
    order: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...partial,
  };
}

describe('groupByStatus', () => {
  it('buckets items and yields empty arrays for empty columns', () => {
    const g = groupByStatus([p({ id: 'a', status: PendenciaStatus.PENDENTE }), p({ id: 'b', status: PendenciaStatus.PARADO })]);
    expect(g.PENDENTE.map((x) => x.id)).toEqual(['a']);
    expect(g.ANDAMENTO).toEqual([]);
    expect(g.PARADO.map((x) => x.id)).toEqual(['b']);
    expect(g.CONCLUIDO).toEqual([]);
  });

  it('always returns all 4 columns', () => {
    const g = groupByStatus([]);
    expect(Object.keys(g).sort()).toEqual(['ANDAMENTO', 'CONCLUIDO', 'PARADO', 'PENDENTE']);
  });

  it('sorts each column by order then id', () => {
    const g = groupByStatus([
      p({ id: 'z', status: PendenciaStatus.PENDENTE, order: 2 }),
      p({ id: 'a', status: PendenciaStatus.PENDENTE, order: 1 }),
      p({ id: 'm', status: PendenciaStatus.PENDENTE, order: 1 }),
    ]);
    expect(g.PENDENTE.map((x) => x.id)).toEqual(['a', 'm', 'z']);
  });
});

describe('makeDragEndHandler', () => {
  const items = [p({ id: 'p1', status: PendenciaStatus.PENDENTE, order: 0 }), p({ id: 'p2', status: PendenciaStatus.ANDAMENTO, order: 0 })];

  it('calls move with the target column status', () => {
    const move = vi.fn();
    makeDragEndHandler({ items, move })({ active: { id: 'p1' }, over: { id: 'ANDAMENTO' } });
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', status: PendenciaStatus.ANDAMENTO }));
  });

  it('places the card at the end of the target column (order = max+1)', () => {
    const move = vi.fn();
    makeDragEndHandler({ items, move })({ active: { id: 'p1' }, over: { id: 'ANDAMENTO' } });
    expect(move).toHaveBeenCalledWith({ id: 'p1', status: PendenciaStatus.ANDAMENTO, order: 1 });
  });

  it('is a no-op when dropped outside any column (over null)', () => {
    const move = vi.fn();
    makeDragEndHandler({ items, move })({ active: { id: 'p1' }, over: null });
    expect(move).not.toHaveBeenCalled();
  });

  it('is a no-op when the target is not a valid status', () => {
    const move = vi.fn();
    makeDragEndHandler({ items, move })({ active: { id: 'p1' }, over: { id: 'NOPE' } });
    expect(move).not.toHaveBeenCalled();
  });

  it('is a no-op when dropped at its own current position', () => {
    const move = vi.fn();
    const single = [p({ id: 'p1', status: PendenciaStatus.PENDENTE, order: 0 })];
    makeDragEndHandler({ items: single, move })({ active: { id: 'p1' }, over: { id: 'PENDENTE' } });
    expect(move).not.toHaveBeenCalled();
  });
});
