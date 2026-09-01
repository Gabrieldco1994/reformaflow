/**
 * U6b build 1 (#456) — controle de ativação da lente `by-type` da Visão Conta.
 * Contrato: `docs/financeiro-projetos-por-tipo.md` §7.1 "Controle de ativação".
 *
 * Variável de ambiente build-time (Next.js/Vercel), pública por necessidade
 * (`NEXT_PUBLIC_*` é inlined no bundle do cliente). Ativa SOMENTE quando o
 * valor é exatamente a string `'1'`; ausente ou qualquer outro valor = OFF.
 *
 * NÃO é `ProjectFeature`, `ModuleSlug` nem nav capability — não entra em
 * `PROJECT_FEATURES`, `TYPE_MODULES` ou `PROJECT_NAV`. Não substitui nenhum
 * gate server-side de autorização ou capacidade; é só liga/desliga de
 * renderização de UI.
 */
export const CONTA_LENTE_POR_TIPO_ENABLED =
  process.env.NEXT_PUBLIC_FEATURE_CONTA_LENTE_POR_TIPO === '1';
