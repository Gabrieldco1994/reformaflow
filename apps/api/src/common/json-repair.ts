/**
 * Repair helper for LLM-generated JSON that got truncated (MAX_TOKENS) or has
 * trailing-comma/control-char issues. Tries a plain parse first, then a
 * best-effort repair (strip dangling comma, close open braces/brackets).
 *
 * ponytail: heuristic repair, not a real JSON parser — good enough for
 * Gemini's fairly regular output; swap for a proper streaming JSON repair
 * lib if truncation rate becomes a real problem.
 */
export function parseJsonWithRepair<T>(raw: string): T {
  const cleaned = raw.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f]/g, ' ');

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    let repaired = cleaned.replace(/,\s*[^}\]]*$/, '');
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;
    for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
    for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
    return JSON.parse(repaired) as T; // throws if still broken — caller decides how to handle
  }
}
