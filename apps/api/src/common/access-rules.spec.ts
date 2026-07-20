import {
  accessibleProjectTypes,
  projectTypeHasModule,
  userCanAccessProjectType,
} from './access-rules';

describe('projectTypeHasModule — pendencias gate', () => {
  it('REFORMA has the pendencias module', () => {
    expect(projectTypeHasModule('REFORMA', 'pendencias')).toBe(true);
  });

  describe('userCanAccessProjectType', () => {
    it('denies access when both type and module grants are empty', () => {
      expect(userCanAccessProjectType('USER', [], [], 'PESSOAL')).toBe(false);
      expect(userCanAccessProjectType('USER', undefined, [], 'REFORMA')).toBe(false);
    });

    it('keeps explicit type restriction when allowedProjectTypes is provided', () => {
      expect(
        userCanAccessProjectType('USER', ['PESSOAL'], ['monthlyOverview'], 'PESSOAL'),
      ).toBe(true);
      expect(
        userCanAccessProjectType('USER', ['PESSOAL'], ['monthlyOverview'], 'REFORMA'),
      ).toBe(false);
    });
  });

  describe('accessibleProjectTypes', () => {
    it('returns empty list when both type and module grants are empty', () => {
      expect(accessibleProjectTypes('USER', [], [])).toEqual([]);
    });

    it('derives types from modules when type grant is empty', () => {
      expect(accessibleProjectTypes('USER', [], ['monthlyOverview'])).toEqual([
        'PESSOAL',
      ]);
    });
  });

  it('only REFORMA and PESSOAL have pendencias', () => {
    expect(projectTypeHasModule('PESSOAL', 'pendencias')).toBe(true);
    for (const t of ['COMPRA', 'CASA', 'CARRO', 'PLANTAS']) {
      expect(projectTypeHasModule(t, 'pendencias')).toBe(false);
    }
  });
});
