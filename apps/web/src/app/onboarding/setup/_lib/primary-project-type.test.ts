import { describe, it, expect } from 'vitest';
import { pickPrimaryProjectType } from './primary-project-type';
import type { ObjectiveType } from '@/components/objectives/objective-options';

// ponytail: `ObjectiveType` resolves to `ProjectType` enum members (nominal type) —
// plain string-literal arrays need this cast to typecheck; runtime values are identical
// to the enum's string values (e.g. ProjectType.PESSOAL === 'PESSOAL').
function types(values: string[]): ObjectiveType[] {
  return values as ObjectiveType[];
}

describe('pickPrimaryProjectType', () => {
  it('returns null for an empty selection', () => {
    expect(pickPrimaryProjectType([])).toBeNull();
  });

  it('prioritizes PESSOAL when selected alongside other types', () => {
    expect(pickPrimaryProjectType(types(['REFORMA', 'PESSOAL', 'CASA']))).toBe('PESSOAL');
  });

  it('falls back to the first type in canonical OBJECTIVE_TYPES order when PESSOAL is absent', () => {
    expect(pickPrimaryProjectType(types(['CARRO', 'REFORMA']))).toBe('REFORMA');
  });

  it('returns the single selected type as-is', () => {
    expect(pickPrimaryProjectType(types(['CASA']))).toBe('CASA');
  });
});
