import { describe, it, expect } from 'vitest';
import {
  PendenciaStatus,
  PENDENCIA_STATUS_LABELS,
  PENDENCIA_STATUS_COLUMNS,
} from '../src/config/pendencia';

describe('PendenciaStatus / kanban columns', () => {
  it('PENDENCIA_STATUS_COLUMNS is the 4 kanban columns in order', () => {
    expect(PENDENCIA_STATUS_COLUMNS).toEqual([
      'PENDENTE',
      'ANDAMENTO',
      'PARADO',
      'CONCLUIDO',
    ]);
    expect(PENDENCIA_STATUS_COLUMNS).toHaveLength(4);
  });

  it('every column has a non-empty label', () => {
    for (const col of PENDENCIA_STATUS_COLUMNS) {
      expect(PENDENCIA_STATUS_LABELS[col].length).toBeGreaterThan(0);
    }
  });

  it('CONCLUIDO enum value is the string "CONCLUIDO"', () => {
    expect(PendenciaStatus.CONCLUIDO).toBe('CONCLUIDO');
  });
});
