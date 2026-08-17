/**
 * B0 (#447) — shared grant-JSON parser contract.
 *
 * `allowedProjects`/`allowedModules`/`allowedProjectTypes` are JSON-in-a-TEXT-
 * column grants. Today `AuthService.buildPublicUser` and `JwtStrategy.validate`
 * each inline their OWN `JSON.parse(...) catch => []` logic, and a corrupted/
 * blank/null/non-array grant silently DEGRADES to `[]` — which downstream
 * (`accessibleProjectScope`, `userCanAccessProject`) is INDISTINGUISHABLE from
 * the legitimate empty-array wildcard ("no restriction"). That is a fail-OPEN
 * bug: a corrupted grant must never buy MORE access than a well-formed one.
 *
 * This spec pins the contract for the shared parser both readers must adopt:
 *   - `{valid, values}` — `valid` says whether the raw text was a well-formed
 *     grant; `values` is always a clean `string[]` (never null/number/etc).
 *   - `[]` (a real, syntactically valid empty JSON array) is the ONLY input
 *     that is `valid: true` with `values: []` (wildcard downstream).
 *   - Malformed JSON, blank string, `null`/`undefined`, and non-array JSON
 *     (object/number/string) are all `valid: false` — fail CLOSED, never
 *     reinterpreted as the wildcard.
 *   - An array containing anything OTHER than `string`/`null` (e.g. `7`)
 *     invalidates the WHOLE grant — `[null, 7]` must NOT collapse to a
 *     seemingly-valid `[]` after filtering (that would silently readmit the
 *     wildcard-fail-open bug through a naive `.filter(isString)`).
 *   - `null` ENTRIES inside an otherwise-valid array are simply dropped:
 *     `["p1", null]` is `valid: true` with `values: ["p1"]`.
 */
import { parseGrantJson } from './grant-json';

describe('parseGrantJson — B0 fail-closed contract (#447)', () => {
  it('treats a real empty JSON array as the valid, limited wildcard', () => {
    expect(parseGrantJson('[]')).toEqual({ valid: true, values: [] });
  });

  it('fails closed on malformed JSON — never degrades to the wildcard', () => {
    expect(parseGrantJson('{invalid-json')).toEqual({ valid: false, values: [] });
  });

  it('fails closed on a blank string', () => {
    expect(parseGrantJson('')).toEqual({ valid: false, values: [] });
    expect(parseGrantJson('   ')).toEqual({ valid: false, values: [] });
  });

  it('fails closed on null/undefined', () => {
    expect(parseGrantJson(null)).toEqual({ valid: false, values: [] });
    expect(parseGrantJson(undefined)).toEqual({ valid: false, values: [] });
  });

  it('fails closed when the argument is entirely missing (no argument at all, not just undefined)', () => {
    // Cast to `any` so this compiles regardless of whether the eventual
    // parser signature makes the parameter optional — the contract is about
    // the RUNTIME behavior of a zero-argument call, not the TS arity.
    expect((parseGrantJson as any)()).toEqual({ valid: false, values: [] });
  });

  it('fails closed on well-formed JSON that is not an array', () => {
    expect(parseGrantJson('{"p1":true}')).toEqual({ valid: false, values: [] });
    expect(parseGrantJson('42')).toEqual({ valid: false, values: [] });
    expect(parseGrantJson('"p1"')).toEqual({ valid: false, values: [] });
  });

  it('[null,7] is invalid as a WHOLE — must not become the wildcard via naive filtering', () => {
    const result = parseGrantJson('[null,7]');
    expect(result.valid).toBe(false);
    // Whatever `values` ships as for an invalid grant, it must NEVER equal the
    // legitimate wildcard shape `[]` — a caller that only checks `values.length
    // === 0` to decide "no restriction" must not be fooled by this input.
    expect(result).not.toEqual({ valid: true, values: [] });
  });

  it('filters null entries but keeps a valid grant valid — ["p1", null] -> ["p1"]', () => {
    expect(parseGrantJson('["p1", null]')).toEqual({
      valid: true,
      values: ['p1'],
    });
  });

  it('every value in a valid result is a plain string (never leaks null/number/object)', () => {
    const cases = ['[]', '["p1", null]', '["p1", "p2"]'];
    for (const raw of cases) {
      const { values } = parseGrantJson(raw);
      expect(values.every((value) => typeof value === 'string')).toBe(true);
    }
  });
});
