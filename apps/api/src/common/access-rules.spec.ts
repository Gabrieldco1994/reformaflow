import { projectTypeHasModule } from './access-rules';

describe('projectTypeHasModule — pendencias gate', () => {
  it('REFORMA has the pendencias module', () => {
    expect(projectTypeHasModule('REFORMA', 'pendencias')).toBe(true);
  });

  it('non-REFORMA types do NOT have pendencias', () => {
    for (const t of ['COMPRA', 'CASA', 'CARRO', 'PESSOAL', 'PLANTAS']) {
      expect(projectTypeHasModule(t, 'pendencias')).toBe(false);
    }
  });
});
