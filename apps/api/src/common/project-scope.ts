/**
 * Álgebra do escopo de projeto tri-state, compartilhada por quem precisa de
 * MAIS DE UMA lente ao mesmo tempo (#483 SEC-5).
 *
 * Um escopo é `null` (irrestrito — só ADMIN/OWNER) ou a lista EXATA de ids
 * visíveis (`[]` nega tudo). Quando um payload mistura recursos de módulos
 * diferentes (despesa × recebimento), cada consulta usa a lente do SEU módulo e
 * os metadados comuns usam a união/interseção delas — nunca uma lente só.
 */
export type ProjectScope = string[] | null;

/** União (`null` vence: irrestrito ∪ qualquer coisa = irrestrito). */
export function unionProjectScope(a: ProjectScope, b: ProjectScope): ProjectScope {
  if (a === null || b === null) return null;
  return Array.from(new Set([...a, ...b]));
}

/** Interseção (`null` é elemento neutro: irrestrito ∩ X = X). */
export function intersectProjectScope(a: ProjectScope, b: ProjectScope): ProjectScope {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  const rhs = new Set(b);
  return a.filter((id) => rhs.has(id));
}

/** O escopo alcança `projectId`? (`null` alcança tudo.) */
export function projectScopeIncludes(scope: ProjectScope, projectId: string): boolean {
  return scope === null || scope.includes(projectId);
}

/** Mesma visibilidade? Usado para preservar a forma histórica da query. */
export function sameProjectScope(a: ProjectScope, b: ProjectScope): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const rhs = new Set(b);
  return a.every((id) => rhs.has(id));
}
