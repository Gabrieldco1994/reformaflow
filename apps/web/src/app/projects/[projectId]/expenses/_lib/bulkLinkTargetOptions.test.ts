import { describe, it, expect } from 'vitest';
import { getBulkLinkTargetProjects } from './bulkLinkTargetOptions';

describe('getBulkLinkTargetProjects', () => {
  it('lista vazia → []', () => {
    expect(getBulkLinkTargetProjects([], 'p1')).toEqual([]);
  });

  it('exclui o projeto atual mesmo presente na lista', () => {
    const projects = [
      { id: 'p1', name: 'Pessoal', type: 'PESSOAL' },
      { id: 'p2', name: 'Reforma', type: 'REFORMA' },
    ];
    const result = getBulkLinkTargetProjects(projects, 'p1');
    expect(result.map((p) => p.id)).toEqual(['p2']);
  });

  it('exclui projetos sem feature "expenses"', () => {
    const projects = [
      { id: 'p2', name: 'Reforma', type: 'REFORMA' },
      { id: 'p3', name: 'SemFeature', type: 'INVALID_TYPE' },
    ];
    const result = getBulkLinkTargetProjects(projects, 'p1');
    expect(result.map((p) => p.id)).toEqual(['p2']);
  });
});
