import { describe, expect, it } from 'vitest';
import { monthlyOverviewPath } from './monthly-overview-query';

describe('monthly overview query', () => {
  it('forwards the selected browser month using the API month parameter', () => {
    const path = monthlyOverviewPath('project-123', '2026-06');

    expect(path).toBe('/projects/project-123/monthly-overview?month=2026-06');
    expect(path).not.toContain('?mes=');
  });
});
