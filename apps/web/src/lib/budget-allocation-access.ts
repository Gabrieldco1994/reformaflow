/**
 * #449 B2 — quem pode LER o histórico congelado de Alocação de Budget.
 *
 * Espelha exatamente o gate da API (`BudgetAllocationAdminGuard` →
 * `isNonGuestFullAccess`): papel full-access (ADMIN|OWNER) e NÃO-convidado.
 *
 * Existe para que a UI não dispare requisição que ela já sabe que vai tomar
 * 403: o `providers.tsx` não repete 4xx e não há toast global, então a falha
 * seria invisível — o usuário só veria linhas a menos. Isto NÃO é um controle
 * de acesso (esse é do servidor); é higiene de chamada.
 *
 * O `!isGuest` é obrigatório: o convidado de demo nasce com
 * `role: 'ADMIN', isGuest: true` (#497), então "é ADMIN" sozinho não distingue
 * administrador de visitante.
 */
export function canReadBudgetAllocations(
  user: { role?: string; isGuest?: boolean } | null | undefined,
): boolean {
  if (!user) return false;
  const isFullAccess = user.role === 'ADMIN' || user.role === 'OWNER';
  return isFullAccess && !user.isGuest;
}
