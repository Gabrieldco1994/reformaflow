import { ProjectType } from '@reformaflow/domain';
import { describe, it, expect } from 'vitest';
import { resolveDashboardVariant } from './resolve-variant';

describe('resolveDashboardVariant', () => {
  it.each([
    [ProjectType.REFORMA, 'financial'],
    [ProjectType.COMPRA, 'financial'],
    [ProjectType.CASA, 'management'],
    [ProjectType.CARRO, 'management'],
    [ProjectType.PESSOAL, null],
    [ProjectType.PLANTAS, 'plants'],
  ] as const)('resolves %s to %s using hasFeature, never a literal type string', (type, expected) => {
    expect(resolveDashboardVariant(type)).toBe(expected);
  });
});
