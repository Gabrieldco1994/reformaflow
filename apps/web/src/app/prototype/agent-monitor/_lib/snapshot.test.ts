import { describe, expect, it } from 'vitest';

import { _test } from './snapshot';

describe('snapshot helpers', () => {
  it('parses workspace yaml keys used by monitor', () => {
    const parsed = _test.parseWorkspaceYaml(
      ['repository: Gabrieldco1994/reformaflow', 'branch: main', 'updated_at: 2026-07-13T20:00:00.000Z'].join(
        '\n',
      ),
    );

    expect(parsed).toEqual({
      repo: 'Gabrieldco1994/reformaflow',
      branch: 'main',
      updatedAt: '2026-07-13T20:00:00.000Z',
    });
  });

  it('derives active/idle status from lock state', () => {
    expect(_test.deriveStatus(true)).toBe('active');
    expect(_test.deriveStatus(false)).toBe('idle');
  });
});
