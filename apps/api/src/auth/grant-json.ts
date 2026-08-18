/**
 * Single fail-closed parser for every "grant" JSON column read from the
 * `User` row (`allowedModules`, `allowedProjects`, `allowedProjectTypes`),
 * used by `AuthService.buildPublicUser`, `JwtStrategy.validate`, and
 * `AuthService.updateSelfObjectives`.
 *
 * The DB column is the source of truth and is never optional at the schema
 * level (`String @default("[]")`), so there is no legitimate "field not
 * supplied" case — a caller without the real value simply hasn't loaded the
 * row. Only the literal JSON array `[]` is the valid wildcard (no
 * restriction — the caller derives visibility from type/module elsewhere).
 * Missing/undefined, blank, `null`, invalid JSON, a non-array, or a
 * non-empty array with no string values all degrade the whole grant to
 * INVALID so the caller fails closed (401) instead of silently treating
 * corruption as "no restriction", which would grant full access by accident.
 */
export interface ParsedGrant {
  valid: boolean;
  values: string[];
}

export function parseGrantJson(raw: unknown): ParsedGrant {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { valid: false, values: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, values: [] };
  }

  if (!Array.isArray(parsed)) {
    return { valid: false, values: [] };
  }
  if (parsed.length === 0) {
    return { valid: true, values: [] };
  }

  const values = parsed.filter((value): value is string => typeof value === 'string');
  if (values.length === 0) {
    return { valid: false, values: [] };
  }
  return { valid: true, values };
}
