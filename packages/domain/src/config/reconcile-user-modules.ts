import { ProjectType } from '../enums';
import { TYPE_MODULES, TypeModuleSlug } from './type-modules';

/**
 * Reconcilia o snapshot de módulos de um usuário com `TYPE_MODULES`.
 *
 * `User.allowedModules` é uma FOTO tirada no signup (`deriveObjectiveAccess`).
 * Quando um módulo novo entra em `TYPE_MODULES`, quem já tinha conta fica para
 * trás: o menu some no web e a API responde 403 num módulo que o tipo de
 * projeto dele concede. Foi assim que `financing` sumiu para usuários antigos
 * de CASA/CARRO, e `recurrences`/`pendencias` para PESSOAL.
 *
 * Derivar do MESMO mapa que o signup usa faz o problema não voltar no próximo
 * módulo — não há backfill a lembrar de rodar.
 *
 * **UNIÃO, nunca substituição.** Um módulo concedido manualmente (suporte) ou
 * fora do mapa do tipo é preservado. Esta função só adiciona: revogar acesso
 * por reconciliação automática é risco que não se paga.
 *
 * `projectTypes` vazio é o legado "sem restrição" — esses usuários derivam
 * acesso por outro caminho (`accessibleProjectTypes`) e não são tocados.
 *
 * ⚠️ Existem DOIS pontos de leitura do snapshot: `AuthService.buildPublicUser`
 * (resposta de login/`/auth/me`, que alimenta o gate do web) e
 * `JwtStrategy.validate` (monta o `request.user`, que alimenta o
 * `ModulesGuard` da API). **Os dois precisam chamar esta função** — corrigir
 * só um deixa o menu aparecer e a API responder 403, que é pior que o bug
 * original porque o usuário vê a opção e ela falha.
 */
export function reconcileUserModules(
  ownedModules: readonly string[],
  projectTypes: readonly string[],
): string[] {
  if (projectTypes.length === 0) return [...ownedModules];

  const reconciled = new Set<string>(ownedModules);
  for (const type of projectTypes) {
    for (const slug of TYPE_MODULES[type as ProjectType] ?? []) {
      reconciled.add(slug as TypeModuleSlug);
    }
  }
  return [...reconciled];
}
