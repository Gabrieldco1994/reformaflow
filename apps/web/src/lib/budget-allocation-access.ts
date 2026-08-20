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

/**
 * #504 — quem enxerga o PONTO DE ENTRADA do histórico congelado.
 *
 * O #449/#500 removeu o item de `PROJECT_NAV` (correto: aquela lista filtra por
 * MÓDULO e o gate desta tela é PAPEL, então devolvê-la ali reporia o item no
 * menu de todo mundo levando a 403). Só que a remoção levou junto TODA a
 * descoberta: a tela passou a existir apenas por URL digitada à mão, e o
 * administrador do tenant com alocações vivas ficou sem o próprio histórico.
 *
 * Este predicado devolve a descoberta SEM afrouxar nada: é a conjunção do gate
 * de leitura (papel full-access não-convidado, espelho do
 * `BudgetAllocationAdminGuard`) com o tipo de projeto que a página realmente
 * atende. É estritamente MAIS ESTREITO que `canReadBudgetAllocations` — nunca
 * mais permissivo —, então nenhum ponto de entrada leva a uma tela de bloqueio.
 *
 * Fica fora de `PROJECT_NAV` de propósito: mora ao lado do item administrativo
 * "Usuários", que já é papel-gated e já vive fora daquela lista. Isso também
 * mantém o #450 (U1), que está redesenhando `PROJECT_NAV` agora, livre de
 * conflito.
 *
 * `projectType` é `string` (não o enum) porque é o que `/projects/:id` devolve
 * e o que `ProjectInfo.type` carrega no shell; ausente ⇒ fail-closed.
 */
export function canSeeBudgetAllocationEntryPoint(
  user: { role?: string; isGuest?: boolean } | null | undefined,
  projectType: string | null | undefined,
): boolean {
  return canReadBudgetAllocations(user) && projectType === 'PESSOAL';
}
