import { describe, it, expect } from 'vitest';
import {
  computeModuleReconciliation,
  expectedModulesFor,
  parseStringArray,
} from './reconcile-user-modules.mjs';

/** Usuário no formato cru do banco (os dois campos são JSON em TEXT). */
function user(overrides = {}) {
  return {
    id: 'u1',
    username: 'maria',
    role: 'USER',
    allowedProjectTypes: JSON.stringify(['CASA']),
    allowedModules: JSON.stringify(['dashboard', 'recurringBills']),
    ...overrides,
  };
}

describe('expectedModulesFor', () => {
  it('deriva de TYPE_MODULES — CASA inclui financing', () => {
    expect(expectedModulesFor(['CASA'])).toContain('financing');
  });

  it('CARRO inclui financing e vehicleDocuments', () => {
    const mods = expectedModulesFor(['CARRO']);
    expect(mods).toContain('financing');
    expect(mods).toContain('vehicleDocuments');
  });

  it('une os módulos de múltiplos tipos sem duplicar', () => {
    const mods = expectedModulesFor(['CASA', 'CARRO']);
    // `dashboard` está nos dois — Set garante uma ocorrência só.
    expect([...mods].filter((m) => m === 'dashboard')).toHaveLength(1);
  });

  it('tipo desconhecido não quebra nem inventa módulo', () => {
    expect([...expectedModulesFor(['TIPO_QUE_NAO_EXISTE'])]).toEqual([]);
  });
});

describe('computeModuleReconciliation', () => {
  it('concede o módulo faltante a um usuário de CASA — o caso que o backfill antigo não cobria', () => {
    const [update] = computeModuleReconciliation([user()]);
    expect(update.missing).toContain('financing');
    expect(update.allowedModules).toContain('financing');
  });

  it('concede a um usuário de CARRO', () => {
    const [update] = computeModuleReconciliation([
      user({ allowedProjectTypes: JSON.stringify(['CARRO']) }),
    ]);
    expect(update.missing).toContain('financing');
  });

  it('é idempotente: usuário já completo não gera update', () => {
    const complete = user({
      allowedModules: JSON.stringify([...expectedModulesFor(['CASA'])]),
    });
    expect(computeModuleReconciliation([complete])).toEqual([]);
  });

  it('NUNCA remove módulo — preserva grant fora do mapa do tipo', () => {
    const withExtra = user({
      allowedModules: JSON.stringify([
        ...expectedModulesFor(['CASA']),
        'modulo-concedido-manualmente',
      ]),
    });
    // Nada a fazer: já tem tudo que o tipo concede, e o extra não é motivo
    // para update (nem para remoção).
    expect(computeModuleReconciliation([withExtra])).toEqual([]);
  });

  it('preserva a ordem original e apenas anexa o que falta', () => {
    const [update] = computeModuleReconciliation([
      user({ allowedModules: JSON.stringify(['recurringBills', 'dashboard']) }),
    ]);
    expect(update.allowedModules.slice(0, 2)).toEqual(['recurringBills', 'dashboard']);
  });

  it('ignora ADMIN — isFullAccessRole já dá bypass nos dois gates', () => {
    expect(
      computeModuleReconciliation([user({ role: 'ADMIN', allowedModules: '[]' })]),
    ).toEqual([]);
  });

  it('ignora OWNER pelo mesmo motivo', () => {
    expect(
      computeModuleReconciliation([user({ role: 'OWNER', allowedModules: '[]' })]),
    ).toEqual([]);
  });

  it('ignora usuário legado sem tipos (deriva acesso por outro caminho)', () => {
    expect(
      computeModuleReconciliation([user({ allowedProjectTypes: '[]' })]),
    ).toEqual([]);
  });

  it('cobre módulos além de financing (recurrences/pendencias em PESSOAL)', () => {
    const [update] = computeModuleReconciliation([
      user({
        allowedProjectTypes: JSON.stringify(['PESSOAL']),
        allowedModules: JSON.stringify(['dashboard', 'expenses']),
      }),
    ]);
    expect(update.missing).toContain('recurrences');
    expect(update.missing).toContain('pendencias');
  });

  it('processa vários usuários e devolve só os que precisam', () => {
    const updates = computeModuleReconciliation([
      user({ id: 'a' }),
      user({ id: 'b', allowedModules: JSON.stringify([...expectedModulesFor(['CASA'])]) }),
      user({ id: 'c', allowedProjectTypes: JSON.stringify(['CARRO']) }),
    ]);
    expect(updates.map((u) => u.id)).toEqual(['a', 'c']);
  });
});

describe('parseStringArray', () => {
  it('trata null/vazio como lista vazia', () => {
    expect(parseStringArray(null, 'allowedModules', 'u1')).toEqual([]);
    expect(parseStringArray('', 'allowedModules', 'u1')).toEqual([]);
  });

  it('rejeita JSON que não é lista de strings — melhor falhar que corromper', () => {
    expect(() => parseStringArray('{"a":1}', 'allowedModules', 'u1')).toThrow();
    expect(() => parseStringArray('[1,2]', 'allowedModules', 'u1')).toThrow();
  });
});
