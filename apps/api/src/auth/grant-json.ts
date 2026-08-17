/**
 * Single fail-closed parser for the "grant" JSON columns (`allowedProjects`)
 * read by `AuthService.buildPublicUser`, `JwtStrategy.validate`, and
 * `AuthService.updateSelfObjectives`.
 *
 * `[]` is the valid wildcard (no project restriction — the caller derives
 * visibility from type/module elsewhere). Anything else that isn't a clean
 * JSON array of strings degrades the whole grant to INVALID so the caller can
 * fail closed (401) instead of silently treating corruption as "no
 * restriction", which would grant full access by accident.
 *
 * `raw === undefined` (property not supplied at all, as opposed to a stored
 * value) is treated as the wildcard too — this covers internal callers that
 * build a partial user object without ever touching `allowedProjects`
 * (e.g. `AuthService`'s objectives-response formatting), which never carried
 * this field and must not start failing closed just because it's absent.
 */
export interface ParsedGrant {
  valid: boolean;
  values: string[];
}

export function parseGrantJson(raw: unknown): ParsedGrant {
  if (raw === undefined) {
    return { valid: true, values: [] };
  }
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
