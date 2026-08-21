/**
 * U2 §5 (adendo) — transporte de CONTEXTO COMPARTILHADO na navegação do shell.
 *
 * Params de contexto compartilhado são os ÚNICOS que sobrevivem a uma troca de
 * destino no shell (dock, Mais, cabeçalho, rail desktop). Tudo que não estiver
 * em `NAV_SHARED_PARAMS` é privado da rota e é DESCARTADO.
 *
 * Passthrough total seria ativamente errado: `launch` é lido globalmente pelo
 * AppShell e reabriria a sheet de lançamento a cada navegação; `focus` existe
 * em credit-cards e bank-accounts com semânticas diferentes (colisão latente
 * num namespace global). Adicionar item aqui é decisão de produto e exige teste.
 *
 * Fica em `apps/web` (não no domain): é concern de URL/roteamento, nenhuma regra
 * de servidor depende dele, e os únicos consumidores são view (shell + rail).
 */

/**
 * Chave de mês `YYYY-MM`. Fonte única da regex — `expense-query-state.ts` a
 * reimporta em vez de recriar, para que `?mes=` e o `period` de expenses
 * validem exatamente igual.
 */
export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const NAV_SHARED_PARAMS = ['mes'] as const;
export type NavSharedParam = (typeof NAV_SHARED_PARAMS)[number];

function toSearchParams(current: URLSearchParams | string | null): URLSearchParams {
  if (current == null) return new URLSearchParams();
  if (typeof current === 'string') {
    return new URLSearchParams(current.startsWith('?') ? current.slice(1) : current);
  }
  return current;
}

/** Um param compartilhado só é preservado se seu valor for válido para a chave. */
function isValidSharedValue(key: NavSharedParam, value: string): boolean {
  if (key === 'mes') return MONTH_KEY_RE.test(value);
  return value.length > 0;
}

/**
 * Subconjunto allowlistado da query atual, em ordem estável (a de
 * `NAV_SHARED_PARAMS`, nunca a de chegada — href determinístico é href
 * testável). Devolve `''` quando não há nada a preservar (nunca `'?'` sozinho,
 * porque `foo?` ≠ `foo` para o router e para asserção de URL).
 */
export function preserveNavParams(current: URLSearchParams | string | null): string {
  const params = toSearchParams(current);
  const out = new URLSearchParams();
  for (const key of NAV_SHARED_PARAMS) {
    const value = params.get(key); // chave repetida: vence a primeira
    if (value && isValidSharedValue(key, value)) out.set(key, value);
  }
  const query = out.toString();
  return query ? `?${query}` : '';
}

/** Mês válido (`YYYY-MM`) da query, ou `null`. Mesma regex que `preserveNavParams`. */
export function readMonthParam(current: URLSearchParams | string | null): string | null {
  const value = toSearchParams(current).get('mes');
  return value && MONTH_KEY_RE.test(value) ? value : null;
}

/**
 * Destino navegável do shell. `pathHref` continua SEM query e é o único que
 * alimenta `isPathActive` (o pathname jamais contém query string). O `<a>` usa
 * o retorno desta função como href.
 *
 * `leavesProject`: destinos que saem do projeto (`/settings`, `/admin/users`,
 * `/projects`) não recebem contexto — levar `?mes` para `/settings` é lixo.
 */
export function buildNavHref(
  pathHref: string,
  current: URLSearchParams | string | null,
  options?: { leavesProject?: boolean },
): string {
  if (options?.leavesProject) return pathHref;
  return `${pathHref}${preserveNavParams(current)}`;
}
