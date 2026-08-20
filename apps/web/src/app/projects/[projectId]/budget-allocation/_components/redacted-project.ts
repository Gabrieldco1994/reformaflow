/**
 * Rótulo de uma relação legada REDIGIDA pela API (#449 B2).
 *
 * O backend responde `null` no lugar de projeto/recebimento de outro tenant —
 * a linha histórica continua no banco, só o conteúdo da relação não sai na
 * resposta. Sem este fallback a tabela quebraria em `alloc.targetProject.name`.
 */
export const REDACTED_PROJECT_LABEL = 'Projeto indisponível';
