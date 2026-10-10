import type { Expense } from '@/types';

/**
 * Política de visão para despesas com cronograma documentado (#701).
 *
 * O servidor responde 409 a qualquer alteração financeira (status, parcela,
 * data, valor, exclusão) desses lançamentos. A visão espelha o guard: as CTAs
 * financeiras/bulk não são oferecidas e as mutations falham ANTES de escrever.
 * A edição descritiva (título, fornecedor, categoria não-neutra…) continua
 * disponível pelo modal completo.
 */
export const DOCUMENTED_SCHEDULE_FINANCIAL_MESSAGE =
  'Cronograma documentado: alterações financeiras precisam de correção assistida.';

/** Texto curto (title/tooltip) do status/parcela indisponível. */
export const DOCUMENTED_SCHEDULE_ACTION_TITLE =
  'Cronograma documentado: valores, datas e status não são alterados por aqui.';

/** Texto curto (title/tooltip) da exclusão indisponível. */
export const DOCUMENTED_SCHEDULE_DELETE_TITLE =
  'Cronograma documentado: a exclusão não é feita por aqui.';

export function isDocumentedScheduleExpense(
  expense: Pick<Expense, 'schedule'> | null | undefined,
): boolean {
  return !!expense?.schedule;
}

/** Ids (dentre `expenses`) que têm cronograma documentado. */
export function documentedScheduleIds(
  expenses: ReadonlyArray<Pick<Expense, 'id' | 'schedule'>>,
): Set<string> {
  return new Set(expenses.filter((e) => e.schedule).map((e) => e.id));
}

/**
 * Fail-before-write: lança se QUALQUER id do conjunto for documentado. Deve
 * rodar antes do primeiro request de uma operação (inclusive bulk sequencial,
 * para não deixar um lote parcialmente escrito por um caso já conhecido).
 */
export function assertNoDocumentedSchedule(
  expenses: ReadonlyArray<Pick<Expense, 'id' | 'schedule'>>,
  ids: readonly string[],
): void {
  if (expenses.some((expense) => ids.includes(expense.id) && expense.schedule)) {
    throw new Error(DOCUMENTED_SCHEDULE_FINANCIAL_MESSAGE);
  }
}

/**
 * True quando o erro indica que o estado local ficou defasado: 409 do servidor
 * (guard concorrente) ou o guard local. Nesses casos as listas devem ser
 * recarregadas para exibir o estado atual.
 */
export function isDocumentedScheduleConflict(error: unknown): boolean {
  // Duck-typing em `status` (ApiResponseError): evita acoplar o módulo ao client HTTP.
  if ((error as { status?: unknown } | null)?.status === 409) return true;
  return error instanceof Error && error.message === DOCUMENTED_SCHEDULE_FINANCIAL_MESSAGE;
}
