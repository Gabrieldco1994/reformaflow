/**
 * #449 B2 — redação de relação legada cross-tenant do Budget Allocation.
 *
 * O `include` do Prisma resolve a relação pela FK e NÃO carrega filtro de
 * tenant: uma linha histórica que aponta para projeto/recebimento de outro
 * tenant devolvia nome, tipo e valor do vizinho dentro da resposta. Redigir é
 * responder `null` no lugar da relação — **na resposta**. A linha, a FK e todos
 * os bytes históricos ficam onde estão: B2 é congelamento, não extinção.
 *
 * O escalar (`sourceProjectId`/`targetProjectId`) é preservado de propósito: é
 * um id opaco, não expõe recurso nenhum (toda outra rota é escopada por tenant)
 * e é o que permite a um ADMIN reconciliar o histórico depois. O que sai da
 * resposta é o CONTEÚDO da relação.
 */

/** Qualquer linha que carrega o dono para comparação. */
interface TenantOwned {
  tenantId: string;
}

/**
 * Relação 1:1 → devolve a relação SEM o `tenantId` auxiliar (a resposta
 * continua com as mesmas chaves de sempre) ou `null` quando é de outro tenant.
 */
export function redactCrossTenantRelation<T extends TenantOwned>(
  relation: T | null | undefined,
  tenantId: string,
): Omit<T, 'tenantId'> | null {
  if (!relation) return null;
  const { tenantId: relationTenantId, ...rest } = relation;
  if (relationTenantId !== tenantId) return null;
  return rest;
}

/** Relação 1:N → as linhas de outro tenant simplesmente não são devolvidas. */
export function redactCrossTenantRelations<T extends TenantOwned>(
  relations: T[] | null | undefined,
  tenantId: string,
): T[] {
  if (!relations) return [];
  return relations.filter((relation) => relation.tenantId === tenantId);
}
