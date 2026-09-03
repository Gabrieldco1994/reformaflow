# DESIGN — issue #582 REOPENED: `classifyForImport` precedence + Gemini-response trust

Branch: `fix/582-classifyforimport-precedence` (base `origin/main` c29ddd0e)
Scope: `apps/api` only. No schema / migration / new column. `MerchantCategory` stays in `modelsWithoutSoftDelete`.

## 1. Subsystem map

Live import-classification path:

```
credit-card.service.ts:~409  ┐
bank-account.service.ts:~669  ┘ → MerchantClassifierService.classifyForImport(merchants, tenantId)
                                    → classifyBatchDetailed(merchants, tenantId)        (:340)
                                        1. normalizeKey dedupe
                                        2. prisma.merchantCategory.findMany  (cache read, OUT of tx)   (:368)
                                        3. cachedMap  <-- DEFECT 1/2/3 live here (:372-378)
                                        4. pending -> callGemini(chunk of 60)  (:430 / :727)  <-- DEFECT 4
                                        5. $transaction: re-read tenant rows (SEC-3 TOCTOU), createMany/update  (:439)
                                        6. merge chunk buffer into classifications ONLY after tx commits
                                    → filter to ImportClassification  (:578-592)
                                        - drop category whose MERCHANT_TO_EXPENSE_TYPE == OUTROS   (F1, keep)
                                        - MANUAL -> {source:'regra'}; AI && conf>=τ -> {source:'ia'}
                                    → status = (providerError||providerIncomplete) ? 'error'
                                               : (pendingCount>0 && !providerAttempted) ? 'unavailable' : 'ok'
```

Correct precedence chain that ALREADY exists but is only wired to the write-shim
(`resolveLearnedExpenseType` / `manualExpenseType`): `resolveLearnedTypeFromRows` (:139)
— tiers MANUAL-tenant > AI-tenant(>=τ) > MANUAL-global > nothing; AI-global never (SEC-1).

Other readers/writers of `MerchantCategory` (unchanged by this issue, but part of the
invariant surface): `lookup` (:235, tenant-first), `fromCache` (:242), `setManual` (:608),
`promoteGlobal` (:695, ADMIN only), `removeManual` (:715), `learnFromImportOverrides`
(:654, #665 — correct, do not touch), regex categorizer `credit-card/categorizer.ts` (out of scope).

## 2. Invariants

- **INV-1 precedence (single order, every enforcement point):**
  `MANUAL tenant  >  AI tenant (confidence >= AI_RULE_MIN_CONFIDENCE)  >  MANUAL global  >  regex/local heuristic`.
  AI-tenant below τ does NOT mask MANUAL-global — it falls through.
- **INV-2 SEC-1:** an `AI` row with `tenantId = null` is NEVER applied, at any confidence.
  MANUAL-global is the single shared fallback and stays allowed.
- **INV-3 trust of provider output:** a chunk's Gemini response is applied (Map + DB) only if
  it is *wholly* trustworthy. Partially-trusted chunk => apply nothing from that chunk.
- **INV-4 association by identity:** result element j is bound to sent merchant j only if
  `normalizeKey(parsed[j].merchant) === normalizeKey(sent[j])`. Position alone never binds.
- **INV-5 money/caixa untouched:** classification only ever changes category/source/confidence
  of a `MerchantCategory` row; never an Expense, never valor/sinal/status/caixa. (Unchanged.)
- **INV-6 tenant isolation (SEC-2):** every query filters `tenantId`; missing tenantId throws
  before I/O. (Unchanged, keep guards.)
- **INV-7 external contract:** `ImportClassification = { category, source:'regra'|'ia', confidence }`
  and `ClassifyForImportResponse = { classifications: Map, status }` are frozen. Callers consume
  `{ classifications, status }` only.

## 3. Chosen approach — precedence (ONE source of truth)

Refactor `resolveLearnedTypeFromRows` to delegate its tier *selection* to a new exported pure
helper and have `classifyBatchDetailed` call the **same** helper for its cache step:

```
export type LearnedTier = 'MANUAL_TENANT' | 'AI_TENANT' | 'MANUAL_GLOBAL';

// pure, no Prisma. The ONLY place tier order is encoded.
export function pickLearnedRow(
  rows: MerchantRuleRow[],
  opts: { tenantId: string; threshold: number; manualOnly?: boolean },
): { row: MerchantRuleRow; tier: LearnedTier } | null
```

- `resolveLearnedTypeFromRows` becomes: `const hit = pickLearnedRow(rows, opts); if (!hit) return {…sub-limiar|sem-regra}; return classifyLearnedRow(hit.row, hit.tier)`.
  (Keep the existing `sawSubThreshold` reason distinction — `pickLearnedRow` also returns
  `reason` or a small discriminated result; implementer's choice, but the *order* lives in one fn.)
- `classifyBatchDetailed` cache step: for each `merchantKey`, build the `MerchantRuleRow[]` for
  that key from `cachedRows` and call `pickLearnedRow(rowsForKey, { tenantId, threshold: AI_RULE_MIN_CONFIDENCE })`.
  - hit MANUAL_TENANT / MANUAL_GLOBAL  -> `ClassifyResult { source: 'MANUAL', … }`
  - hit AI_TENANT                      -> `ClassifyResult { source: 'AI', confidence: row.confidence }`
  - no hit, **but at least one row exists for the key** (AI-tenant sub-τ, AI-global any conf,
    CACHE/unknown) -> the key is *resolved-as-unclassified*: NOT added to `classifications`,
    NOT added to `pending` (no Gemini re-call — keeps provider call volume identical to today).
  - no row at all -> `pending` (Gemini).
- `classifyForImport` filter simplifies but keeps the F1 OUTROS drop and the τ re-check for AI
  (defense in depth; boundary tests pin it).

Why this and not routing through `resolveLearnedTypeFromRows` directly: that fn folds the
result into `ExpenseType` and collapses `OUTROS -> null`, losing the raw category that the AI
branch of the preview still needs, and it has no tenant/global scope marker. `pickLearnedRow`
returns the raw winning row + its tier, so both callers derive what they need from one ordering.

Net effect on the 4 defects:
1. cache resolution now tiered, not `tenantId`-only.
2. AI-tenant 0.3 + MANUAL-global -> `pickLearnedRow` returns MANUAL_GLOBAL -> `{source:'regra'}`.
3. AI-global 0.9/0.99/1.0 -> no tier matches (tier 3 requires `source==='MANUAL'`) -> unclassified.
4. see §4.

## 4. Gemini-response validation contract

New pure helper, single call site inside `callGemini` right after JSON parse/repair:

```
export function validateGeminiChunk(
  sentMerchants: string[],
  parsed: unknown,
  finishReason: string | undefined,
): { ok: true; items: Array<{ merchant: string; category: MerchantCategory;
                              subcategory: string | null; confidence: number }> }
  | { ok: false; reason: 'finish-reason' | 'not-array' | 'length' | 'schema' | 'misaligned' }
```

Rules (ALL must hold or the chunk is rejected):

- **finishReason:** must be exactly `'STOP'`. `undefined`, `'MAX_TOKENS'`, `'SAFETY'`,
  `'RECITATION'`, anything else -> `reason:'finish-reason'`. Read from
  `json.candidates?.[0]?.finishReason`.
- **shape:** `parsed` is an array -> else `not-array`.
- **length:** `parsed.length === sentMerchants.length` -> else `length` (covers the "4 of 5"
  short response and any over-long response).
- **per-element schema:** every element is a non-null object with
  - `merchant`: string, non-empty
  - `category`: string that is a member of `MERCHANT_CATEGORIES` (taxonomy). NOT coerced to
    `'outros'` anymore for an out-of-taxonomy value — an off-taxonomy category is a schema
    violation (`reason:'schema'`). (A genuinely uncertain merchant should come back as the
    literal `'outros'`, which is in the taxonomy and passes.)
  - `subcategory`: string | undefined | null
  - `confidence`: number | undefined | null  (then `sanitizeConfidence`)
  - any failure -> `reason:'schema'`.
- **alignment (INV-4):** for every index `j`,
  `MerchantClassifierService.normalizeKey(parsed[j].merchant) === MerchantClassifierService.normalizeKey(sentMerchants[j])`.
  A reordered same-length response fails here -> `reason:'misaligned'`. (We do NOT attempt to
  re-sort by identity: the prompt demands "MESMA ORDEM"; a model that reorders is untrusted for
  the whole chunk, not selectively salvageable.)

On `ok:false`: `callGemini` **throws** `new Error('Gemini untrusted response: <reason>')`.
That is caught by the existing per-chunk `try/catch` in `classifyBatchDetailed` -> sets
`providerError = true` -> `for` loop stops -> **`$transaction` for this chunk is never opened**,
so `createMany`/`update` never run: "persist nothing" holds structurally (nothing correct,
nothing incorrect). `classifyForImport` maps `providerError` -> `status: 'error'`.

On `ok:true`: `callGemini` returns `items` already validated + aligned; the existing zip in
`classifyBatchDetailed` (`for j`) is now safe because length + alignment are guaranteed. The
in-tx TOCTOU re-read (SEC-3) is unchanged.

Network timeout (`AbortSignal.timeout(30000)`) path is untouched: `fetch` rejects ->
existing catch -> `providerError` -> `status:'error'`. `!res.ok` path untouched (throws).
The truncation-repair (`lastIndexOf(']')`) stays as a *parse* fallback, but a repaired-then-
short array now fails the `length` check instead of silently under-filling — deliberate.

`providerIncomplete` flag: kept for compatibility but a short response now takes the
`providerError` path (throw) before it would be observed; `providerIncomplete` remains only for
a defensive belt in `classifyForImport`'s status expression. Implementer may fold it away if no
path sets it — leave the status expression tolerant of both.

## 5. Concurrency analysis

Actors that mutate `MerchantCategory` for a `(tenantId, merchantKey)`:
`setManual`, `learnFromImportOverrides`->`setManual`, `promoteGlobal` (global only),
`removeManual`, and `classifyBatchDetailed`'s own tx.

Scenario A — `setManual(tenant)` lands mid-`callGemini` for the same key:
- pre-Gemini cache read missed it (or saw an older AI row) so the key was `pending`.
- `callGemini` returns; `validateGeminiChunk` ok.
- `$transaction` re-reads `tenantId` rows for `chunkKeys` INSIDE the tx (SEC-3, unchanged) and
  finds `prior.source === 'MANUAL'` -> the AI row is **not** written, and `chunkResult` for that
  key reflects the persisted MANUAL row. `classifications` ends MANUAL. Invariant held.
- If instead the whole chunk was rejected (throw): tx never opens, the concurrent `setManual`
  simply persists; next import's cache read picks it up as MANUAL_TENANT. No lost write, no
  mis-assignment.

Scenario B — `promoteGlobal` (MANUAL global) lands mid-`callGemini`:
- The in-tx re-read only queries `tenantId` rows, not global. So we could write an AI-tenant row
  for a key that now has a MANUAL-global. Precedence still resolves correctly on the *next*
  read: AI-tenant >= τ beats MANUAL-global anyway (tier 2 > tier 3); AI-tenant < τ would be
  written and then, on next read, `pickLearnedRow` returns MANUAL_GLOBAL (tier 3) because the
  sub-τ AI-tenant row is skipped. Outcome is correct either way — no new guard needed. Documented
  as benign.

Scenario C — two concurrent imports, same tenant, overlapping merchants:
- Each builds its own local `Map` (no instance state — already fixed in PR-4). Both may call
  Gemini and both may `createMany`. `MerchantCategory` has a unique `(tenantId, merchantKey)`;
  the second `createMany` throws -> caught -> `providerError` for that chunk -> `status:'error'`
  for the loser. Acceptable (preview ret/refresh). No corruption. Unchanged behavior.

Scenario D — `removeManual` mid-import: worst case the import writes an AI row after the MANUAL
was removed; next read resolves by precedence. Benign.

## 6. Production files & functions the backend-expert changes

`apps/api/src/merchant-classifier/merchant-classifier.service.ts`:
- **add** `export function pickLearnedRow(rows, { tenantId, threshold, manualOnly? })` — the sole
  encoding of tier order (extracted from current `resolveLearnedTypeFromRows` body).
- **refactor** `resolveLearnedTypeFromRows` to delegate selection to `pickLearnedRow`
  (keep `reason: 'sub-limiar' | 'sem-regra'` distinction, keep `manualOnly`).
- **add** `export function validateGeminiChunk(sentMerchants, parsed, finishReason)` — §4 contract.
- **rewrite** `classifyBatchDetailed` cache step (:361-394): group `cachedRows` by
  `merchantKey`, resolve each via `pickLearnedRow`; "row(s) present but no tier hit" => resolved-
  as-unclassified (not pending, not in Map).
- **edit** `callGemini` (:727): capture `json.candidates?.[0]?.finishReason`; after parse/repair
  call `validateGeminiChunk`; throw on `ok:false`; return the validated+aligned `items` on ok.
- `classifyForImport` filter (:578-592): keep F1 OUTROS drop + AI τ re-check; no structural
  change required (may simplify).
- **do NOT** touch: `lookup`, `fromCache`, `setManual`, `promoteGlobal`, `removeManual`,
  `learnFromImportOverrides`, `AI_RULE_MIN_CONFIDENCE` (stays `0.8`, `>=`), the external
  interfaces in INV-7, `credit-card/categorizer.ts`.

Callers (`credit-card.service.ts`, `bank-account.service.ts`): **no change** — `{ classifications, status }` shape preserved.

### Stale tests the implementer must update (behavior intentionally changed by the reopen)
`apps/api/src/merchant-classifier/merchant-classifier.classify-for-import.red.spec.ts`:
- F2 "short AI response (1 item for 3 pending) → the returned item stays" — under the reopen a
  short chunk persists/keeps **nothing**; assertion `classifications.get('pendente um')` must
  flip to `.has(...) === false`. Status `'error'` still correct.
- F2 "empty AI response …" — still valid (status error, nothing kept). Keep.
- These are updated in the same PR as the fix; the NEW red specs below encode the target.
