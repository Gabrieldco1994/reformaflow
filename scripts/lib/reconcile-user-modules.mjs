import { TYPE_MODULES } from '@reformaflow/domain';

/**
 * Reconciliação do snapshot de autorização por usuário.
 *
 * O acesso de cada usuário é uma FOTO tirada no signup (`deriveObjectiveAccess`
 * em `auth.service.ts`). Quando um módulo novo entra em `TYPE_MODULES`, quem já
 * tinha conta fica para trás — a foto dele é anterior ao módulo existir. Foi
 * assim que `financing` sumiu do menu para usuários antigos de CASA/CARRO, e
 * `recurrences`/`pendencias` para usuários de PESSOAL.
 *
 * O backfill anterior (`backfill-carro-financing.mjs`) resolvia UM módulo com a
 * lista de tipos escrita à mão (`if (!projectTypes.includes('CARRO'))`), e por
 * isso CASA nunca foi coberta. Esta versão deriva de `TYPE_MODULES` — o mesmo
 * mapa que o signup usa — então cobre qualquer módulo futuro sem script novo.
 *
 * NUNCA REMOVE MÓDULO. Só adiciona o que falta. Tirar acesso de alguém com base
 * numa reconciliação automática é risco que não se paga: um módulo concedido
 * manualmente por suporte, ou um grant legítimo fora do mapa, seria revogado
 * silenciosamente. União, nunca substituição.
 */

export function parseStringArray(value, field, userId) {
  const parsed = JSON.parse(value || '[]');
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`User ${userId} has invalid ${field}`);
  }
  return parsed;
}

/** Módulos que os tipos escolhidos pelo usuário deveriam conceder, hoje. */
export function expectedModulesFor(projectTypes) {
  const expected = new Set();
  for (const type of projectTypes) {
    for (const slug of TYPE_MODULES[type] ?? []) expected.add(slug);
  }
  return expected;
}

/**
 * Um item por usuário a quem falta pelo menos um módulo. Idempotente: rodar
 * duas vezes não gera update na segunda.
 *
 * `allowedProjectTypes` vazio é legado "sem restrição" — esses usuários derivam
 * acesso por outro caminho (`accessibleProjectTypes` em `access-rules.ts`) e
 * NÃO são tocados, mesmo comportamento do backfill anterior.
 *
 * ADMIN/OWNER também ficam de fora: `isFullAccessRole` já dá bypass nos dois
 * gates (API e web), então escrever no snapshot deles é ruído sem efeito.
 */
export function computeModuleReconciliation(users) {
  return users.flatMap((user) => {
    if (user.role === 'ADMIN' || user.role === 'OWNER') return [];

    const projectTypes = parseStringArray(
      user.allowedProjectTypes,
      'allowedProjectTypes',
      user.id,
    );
    if (projectTypes.length === 0) return [];

    const modules = parseStringArray(user.allowedModules, 'allowedModules', user.id);
    const owned = new Set(modules);
    const missing = [...expectedModulesFor(projectTypes)].filter((m) => !owned.has(m));
    if (missing.length === 0) return [];

    return [
      {
        id: user.id,
        username: user.username,
        projectTypes,
        missing,
        // Preserva a ordem original e ANEXA o que falta: nada é removido nem
        // reordenado, então o diff no banco é sempre aditivo e auditável.
        allowedModules: [...modules, ...missing],
      },
    ];
  });
}
