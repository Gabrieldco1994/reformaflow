/**
 * Minimal in-memory `where` evaluator for the hand-rolled Prisma fakes in unit
 * specs. Only the operators the removal/read loaders use: equality (incl. null),
 * `in`, `notIn`, `not` (an undefined operand matches everything, like Prisma's
 * `INCLUDE_SOFT_DELETED`), and `AND`/`OR`. Anything else throws, so a fake can
 * never silently answer a query it does not understand.
 */
type Row = Record<string, unknown>;

export function matchesWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((clause) => matchesWhere(row, clause));
    if (key === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((clause) => matchesWhere(row, clause as Row));
    if (cond === undefined) return true;
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      return cond instanceof Date ? value instanceof Date && value.getTime() === cond.getTime() : value === cond;
    }
    return Object.entries(cond as Row).every(([op, operand]) => {
      if (op === 'in') return (operand as unknown[]).includes(value);
      if (op === 'notIn') return !(operand as unknown[]).includes(value);
      if (op === 'not') return operand === undefined ? true : value !== operand;
      throw new Error(`prisma-where fake: unsupported operator ${key}.${op}`);
    });
  });
}

export const findManyOver =
  (rows: () => Row[]) =>
  async ({ where }: { where?: Record<string, unknown> } = {}) =>
    rows().filter((row) => matchesWhere(row, where));
