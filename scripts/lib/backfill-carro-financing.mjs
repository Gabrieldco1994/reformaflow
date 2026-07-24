// Lógica pura do backfill (issue #293) — extraída para ser testável sem banco real.
export function parseStringArray(value, field, userId) {
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`User ${userId} has invalid ${field}`);
  }
  return parsed;
}

/**
 * Retorna as atualizações a aplicar: um item por usuário que tem CARRO
 * explícito em allowedProjectTypes e ainda não tem 'financing' em
 * allowedModules. Idempotente — rodar duas vezes não gera updates na 2ª vez.
 */
export function computeFinancingBackfillUpdates(users) {
  return users.flatMap((user) => {
    const projectTypes = parseStringArray(
      user.allowedProjectTypes,
      'allowedProjectTypes',
      user.id,
    );
    const modules = parseStringArray(user.allowedModules, 'allowedModules', user.id);

    if (!projectTypes.includes('CARRO') || modules.includes('financing')) {
      return [];
    }

    return [{ id: user.id, allowedModules: [...modules, 'financing'] }];
  });
}
