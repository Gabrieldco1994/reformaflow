# DESIGN — issue #582 REOPENED: `classifyForImport` precedence + Gemini-response trust

Branch: `fix/582-classifyforimport-precedence` (base `origin/main` c29ddd0e; turn-green at `8603bde0`).
Scope: `apps/api` only. No schema / migration / new column. `MerchantCategory` stays in `modelsWithoutSoftDelete`.

> **Revision 2 (PO review):** the Gemini-response trust model changes from *echo-back merchant
> name* to **1-based index (`i`) + a split gate** (structural failure rejects the whole chunk;
> element softness drops only that line). Reason: `normalizeKey('PAY IFD 12/03')` vs the model's
> `"iFood"` diverge, so name-echo would reject a whole 60-item chunk on the first paraphrased
> merchant and dump a real bank statement onto the local heuristic (ai-quality blocker G1).

## 1. Subsystem map

```
credit-card.service.ts:~409  ┐
bank-account.service.ts:~669  ┘ → MerchantClassifierService.classifyForImport(merchants, tenantId)
                                    → classifyBatchDetailed(merchants, tenantId)
                                        1. normalizeKey dedupe → uniqueByKey / keys
                                        2. prisma.merchantCategory.findMany  (cache read, OUT of tx)
                                        3. rowsByKey → pickLearnedRow per key   (TIERED, §3)
                                        4. pending → callGemini(chunk of 60)    (§4)
                                        5. per chunk: consume GeminiChunkValidation
                                             structural fail → providerIncomplete, DO NOT abort, persist nothing
                                             ok → $transaction: re-read tenant rows (SEC-3 TOCTOU),
                                                  createMany/update for validated.items only
                                        6. merge chunk buffer into classifications ONLY after tx commits
                                    → filter to ImportClassification (drop MERCHANT_TO_EXPENSE_TYPE==OUTROS; MANUAL→regra; AI&&conf>=τ→ia)
                                    → status = (providerError || providerIncomplete) ? 'error'
                                               : (pendingCount>0 && !providerAttempted) ? 'unavailable' : 'ok'
```

Correct precedence chain (pre-existing): `resolveLearnedTypeFromRows` → `pickLearnedRow`.
Other `MerchantCategory` readers/writers (unchanged): `lookup`, `fromCache`, `setManual`,
`promoteGlobal` (ADMIN), `removeManual`, `learnFromImportOverrides` (#665, correct),
regex categorizer `credit-card/categorizer.ts` (out of scope).

## 2. Invariants

- **INV-1 precedence:** `MANUAL tenant > AI tenant (confidence >= AI_RULE_MIN_CONFIDENCE) > MANUAL global > regex/local`. AI-tenant sub-τ falls through to MANUAL-global, never masks it.
- **INV-2 SEC-1:** an `AI` row with `tenantId = null` is NEVER applied at any confidence. MANUAL-global stays the single shared fallback.
- **INV-3 chunk trust (split gate):**
  - *Structural failure* → the WHOLE chunk is untrusted: persist nothing (no `$transaction`), `status:'error'`, but subsequent chunks still run.
  - *Element softness* → drop only the offending line, keep the rest aligned; the batch is still marked incomplete → `status:'error'`, and the surviving lines DO persist.
- **INV-4 alignment by explicit index:** response element carries `i` (1-based position in the sent list). Persistence uses `slice[i-1]`. Never array position of the response, never `normalizeKey` echo.
- **INV-5 money/caixa untouched.** (Unchanged.)
- **INV-6 tenant isolation (SEC-2):** every query filters `tenantId`; missing tenantId throws before I/O. `classifyBatchDetailed` dedupes to `uniqueByKey` before the provider call, so `validateGeminiChunk` never has to reason about tenancy.
- **INV-7 external contract frozen:** `ImportClassification = { category, source:'regra'|'ia', confidence }`, `ClassifyForImportResponse = { classifications, status }`.

## 3. Precedence — ONE source of truth (`pickLearnedRow`)

`pickLearnedRow(rows, { tenantId, threshold, manualOnly? })` is the sole encoding of tier order.
It now **always** returns an object (never re-derived by the caller — SEC-3):

```
{ row: MerchantRuleRow | null; tier: 'MANUAL_TENANT'|'AI_TENANT'|'MANUAL_GLOBAL' | null; sawSubThreshold: boolean }
```

- `resolveLearnedTypeFromRows` = `const p = pickLearnedRow(...); if (p.row) return classifyLearnedRow(p.row, p.tier); return { … reason: p.sawSubThreshold ? 'sub-limiar' : 'sem-regra' }`. It must **not** recompute `sawSubThreshold`.
- `classifyBatchDetailed` cache step: group `cachedRows` by `merchantKey`, `pickLearnedRow` per key.
  - `p.row` MANUAL_TENANT / MANUAL_GLOBAL → `ClassifyResult { source: 'MANUAL' }`
  - `p.row` AI_TENANT → `ClassifyResult { source: 'AI', confidence: row.confidence }`
  - `p.row === null` but rows exist for the key (AI-tenant sub-τ, AI-global any conf, CACHE/unknown) → resolved-as-unclassified: not in Map, not re-sent to Gemini.
  - no rows → `pending`.

Defects 1/2/3 fixed by tiering; already green at `8603bde0` and unchanged by revision 2.

## 4. Gemini-response validation contract (revision 2 — index + split gate)

### Prompt change (`callGemini`)
- Response is a JSON array, one object per item, each carrying `"i"` = the **1-based index** of the
  input line: `[{"i":1,"category":"...","subcategory":"breve","confidence":0.0-1.0}]`.
- Drop the `"merchant"` field from the requested schema. Keep "mantenha a MESMA ORDEM" as a hint,
  but the code depends only on `i`.

### `validateGeminiChunk(sentMerchants: string[], parsed: unknown, finishReason: string | undefined)`

Return type:
```
| { ok: true;  items: Array<{ sentIndex: number; category: MerchantCategory;
                              subcategory: string | null; confidence: number }>;
    dropped: number }
| { ok: false; reason: 'finish-reason' | 'not-array' | 'index-set' }
```
`sentIndex` is 0-based (`i - 1`). `dropped` = number of elements silently discarded by the soft gate.

**Structural gate (→ `ok:false`, reject whole chunk):**
- `finishReason !== 'STOP'` — exact string. `undefined`, `'MAX_TOKENS'`, `'SAFETY'`, `'stop'`
  (wrong casing), anything else → `reason:'finish-reason'`.
- `parsed` is not an array → `reason:'not-array'`.
- the multiset of `i` across all elements is **not exactly `{1..N}`** (`N = sentMerchants.length`):
  `parsed.length !== N`, a missing index, a duplicate index, a non-integer `i`, or an `i` outside
  `[1, N]` → `reason:'index-set'`. Computed as: collect `i` from every element; each must be an
  integer in `[1, N]`; `parsed.length === N` **and** `new Set(is).size === N`.

**Soft gate (element survives structural gate — drop the single line, `dropped++`, keep the rest):**
- element is not a non-null object, or has no usable `category` → drop.
- `category`, after normalization (`normalizeCategory`: `trim().toLowerCase()`, NFD strip diacritics,
  compare against the same-normalized taxonomy) does not match any `MERCHANT_CATEGORIES` member → drop.
  A match yields the **canonical** accented lowercase category (`"Saúde"` / `"saúde "` → `'saúde'`).
- `subcategory` not `string | null | undefined` → coerce to `null` (do not drop).
- `confidence`: pass through `sanitizeConfidence` (see below) — never a drop reason.

A structurally-valid chunk with `dropped > 0` returns `ok:true` — the caller sets
`providerIncomplete` and still persists `items`.

### `sanitizeConfidence(raw)` — extended
- `number` & not NaN → clamp `[0,1]`.
- `null` / `undefined` → `UNKNOWN_CONFIDENCE` (0.5, sub-τ by construction).
- **`string` → `Number(raw)`**; NaN → `0` (fail-closed); else clamp `[0,1]`. (`"0.95"` → `0.95`.)
- any other type → `0`.

### `callGemini` control flow
- HTTP/network failure (`!res.ok`, `AbortSignal.timeout(30000)`) → **throws** (unchanged).
- After parse/repair: `const v = validateGeminiChunk(merchants, parsed, finishReason)`. **Return `v`**
  (the whole union) — do **not** throw on `v.ok === false`. Return type becomes `GeminiChunkValidation`.

### `classifyBatchDetailed` chunk loop
```
for (let i = 0; i < pending.length && !providerError; i += CHUNK) {
  let v;
  try { v = await this.callGemini(slice.map(p => p.sample)); }
  catch (err) { this.logger.warn(...); providerError = true; continue; }   // NETWORK only → aborts

  if (!v.ok) { providerIncomplete = true; continue; }                       // STRUCTURAL → no abort, persist nothing
  if (v.dropped > 0) providerIncomplete = true;                            // partial

  const chunkResult = new Map<string, ClassifyResult>();
  await this.prisma.$transaction(async (tx) => {
    const existing = await tx.merchantCategory.findMany({ where: { tenantId, merchantKey: { in: chunkKeys } }, select: {…} });
    const byKey = new Map(existing.map(r => [r.merchantKey, r]));
    const toCreate = [];
    for (const item of v.items) {                     // ← iterate validated items, NOT `for j`
      const { key, sample } = slice[item.sentIndex];  // ← alignment by explicit index
      const prior = byKey.get(key);
      if (prior?.source === 'MANUAL') { chunkResult.set(key, {…prior…, source:'MANUAL'}); continue; }
      const confidence = item.confidence;             // already sanitized
      chunkResult.set(key, { merchant: sample, category: item.category, subcategory: item.subcategory, source: 'AI', confidence });
      if (!prior) toCreate.push({ tenantId, merchantKey: key, merchantSample: sample.slice(0,200), category: item.category, subcategory: item.subcategory, source: 'AI', confidence, aiResponse: JSON.stringify(item).slice(0,1000) });
      else await tx.merchantCategory.update({ where: { tenantId_merchantKey: { tenantId, merchantKey: key } }, data: {…} });
    }
    if (toCreate.length) await tx.merchantCategory.createMany({ data: toCreate });
  }, { timeout: 10000 });
  for (const [k, val] of chunkResult) classifications.set(k, val);
}
```
- **Delete** the `j < aiResults.length` bound and the `... : 'outros'` category coercion in the merge
  loop — unreachable now that `v.items` are pre-validated with canonical categories and in-range
  `sentIndex` (security-tenant-lens SEC-1).
- Delete the interim `aiResults.length !== slice.length → providerError` guard added at turn-green —
  the union already encodes that.

`providerError` (loop abort) is set **only** by the network/persistence `catch`. `providerIncomplete`
is set by structural failure, partial drops, or (belt) a short list. `classifyForImport` status
expression is unchanged: `(providerError || providerIncomplete) ? 'error' : …`.

## 5. Concurrency analysis

Mutators of `MerchantCategory` for `(tenantId, merchantKey)`: `setManual`,
`learnFromImportOverrides`→`setManual`, `promoteGlobal` (global only), `removeManual`,
`classifyBatchDetailed`'s own tx.

- **A — `setManual(tenant)` lands mid-`callGemini`, same key:** key was `pending` (cache miss).
  `callGemini` returns; if `v.ok`, the in-tx SEC-3 re-read (`where: { tenantId, merchantKey: { in: chunkKeys } }`)
  sees `prior.source === 'MANUAL'` → the AI row is not written and `chunkResult` reflects the persisted
  MANUAL row. If `!v.ok` (structural), the tx never opens; the concurrent `setManual` persists; next
  import's cache read resolves it as MANUAL_TENANT. No lost write, no mis-assignment.
- **B — `promoteGlobal` (MANUAL global) lands mid-`callGemini`:** in-tx re-read only queries tenant
  rows, so an AI-tenant row could be written for a key that now has a MANUAL-global. Precedence still
  resolves correctly next read: AI-tenant ≥ τ beats MANUAL-global (tier 2 > 3); AI-tenant < τ is
  skipped and `pickLearnedRow` returns MANUAL_GLOBAL. Benign, no new guard.
- **C — two concurrent imports, same tenant, overlapping merchants:** each builds its own local Map
  (no instance state). Second `createMany` hits the unique `(tenantId, merchantKey)` → throws → caught
  → `providerError` for the loser's chunk → `status:'error'`. No corruption.
- **D — `removeManual` mid-import:** worst case an AI row is written after the MANUAL was removed; next
  read resolves by precedence. Benign.
- **Index-gate & concurrency:** `validateGeminiChunk` is pure and stateless; `i` refers to positions in
  the *caller's* deduped `slice`, computed before any await. A concurrent write cannot renumber it.

## 6. Production files & functions the backend-expert changes

`apps/api/src/merchant-classifier/merchant-classifier.service.ts` only:

- `pickLearnedRow` — return `{ row: MerchantRuleRow | null; tier | null; sawSubThreshold }` always
  (row/tier null on no hit). Sole tier-order encoding.
- `resolveLearnedTypeFromRows` — consume `pickLearnedRow`'s `sawSubThreshold`; delete the local
  recomputation (SEC-3).
- **add** `export function normalizeCategory(raw: unknown): MerchantCategory | null` — trim +
  casefold + NFD-strip vs same-normalized taxonomy, returns canonical member.
- `sanitizeConfidence` — accept numeric strings (`Number(raw)`, NaN→0).
- `validateGeminiChunk` — rewrite to the §4 contract: `finishReason` exact `'STOP'`; `not-array`;
  `index-set` (`{1..N}` multiset check); soft-drop off-taxonomy / malformed element with `dropped`
  counter; return `{ ok:true, items:[{sentIndex,…}], dropped } | { ok:false, reason }`. Add a 1-line
  comment: caller guarantees `uniqueByKey` dedup (no cross-tenant merchants reach here) — SEC-2.
- `GeminiChunkItem` — replace `merchant: string` with `sentIndex: number`.
- `callGemini` — prompt emits/【requests `"i"` (1-based), drops `"merchant"`; return
  `GeminiChunkValidation` (stop throwing on `!v.ok`); still throw on `!res.ok` / timeout.
- `classifyBatchDetailed` — chunk loop per §4: structural fail → `providerIncomplete=true; continue`
  (no abort); `dropped>0` → `providerIncomplete=true`; merge loop iterates `v.items` by `sentIndex`;
  delete `j < aiResults.length` bound, delete `... : 'outros'` coercion, delete the interim
  `aiResults.length !== slice.length` guard.
- `classifyForImport` — unchanged (F1 OUTROS drop + AI τ re-check stay).
- **do NOT touch:** `lookup`, `fromCache`, `setManual`, `promoteGlobal`, `removeManual`,
  `learnFromImportOverrides`, `AI_RULE_MIN_CONFIDENCE` (stays `0.8`, `>=`), INV-7 interfaces,
  `credit-card/categorizer.ts`, the tenant-scope contract of `lookup`, the admin gate.

Callers (`credit-card.service.ts`, `bank-account.service.ts`): no change.

### Stale tests the implementer updates in the same PR
- `merchant-classifier.gemini-validation-582-reopen.red.spec.ts` — rewritten here for the index model
  (reorder WITH correct `i` is now accepted; rejection is by missing/dup/out-of-range `i`).
- `merchant-classifier.classify-for-import.red.spec.ts` F2 "short AI response … the returned item
  stays" — under the split gate a short list is `index-set` structural → persists nothing; flip that
  assertion to `.has(...) === false`.
- Any existing `merchant-classifier.service.spec.ts` case that stubs `callGemini` to return raw
  arrays must return `GeminiChunkValidation` or be routed through the new item shape.

### Pending from ai-quality
A ~15-string realistic Itaú/Nubank fixture for a false-reject-rate assertion
(`it.todo` placeholder in the softness spec until delivered).
