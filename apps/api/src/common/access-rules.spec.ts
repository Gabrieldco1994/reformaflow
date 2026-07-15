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
    it('allows legacy users with empty allowedProjectTypes and empty allowedModules', () => {
      expect(userCanAccessProjectType('USER', [], [], 'PESSOAL')).toBe(true);
      expect(userCanAccessProjectType('USER', undefined, [], 'REFORMA')).toBe(true);
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
    it('returns null (no type restriction) for legacy empty grants', () => {
      expect(accessibleProjectTypes('USER', [], [])).toBeNull();
    });

    it('returns empty types when types are empty but modules exist', () => {
      expect(accessibleProjectTypes('USER', [], ['monthlyOverview'])).toEqual([]);
    });
  });

  it('non-REFORMA types do NOT have pendencias', () => {
    for (const t of ['COMPRA', 'CASA', 'CARRO', 'PESSOAL', 'PLANTAS']) {
      expect(projectTypeHasModule(t, 'pendencias')).toBe(false);
    }
  });
});
