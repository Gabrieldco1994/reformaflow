# #659 — Carteira launcher reachability (design)

## 1. Problem restated
`ImportWithoutAccountModal` (`POST /projects/:id/receipts/import?origin=none`) is fully working
(category parity #668, 44px/ignored-row fixes #670, cross-origin dedupe #672) but is only mounted
by `ImportMassStep` for onboarding steps with `experience:'SUMMARY'`. Default PESSOAL onboarding
steps use `FULL` → unreachable in the shipped build (journey QA Gap 1, PR #668 comment
`#issuecomment-5530227208`). PO decision: ship reachability only after cross-origin dedupe — #672
merged (`9539c39f`, base of this worktree) → gate satisfied.

## 2. Component map (current)
- **Desktop launcher**: `apps/web/src/app/projects/[projectId]/expenses/_components/NovaDespesaLauncher.tsx`.
  Mounted from `/conta` ("Lançar" button) and `/expenses`. Owns `importStep: null|'pick-card'|'pick-account'`
  state machine. The account picker (`importStep==='pick-account'`) queries
  `['bank-accounts', projectId]` (`enabled: importStep==='pick-account' && canImportBankStatement`)
  and today only branches `loadingAccounts` (from `isFetching`) vs `importAccounts.length===0` →
  `SemContaEmptyState` vs the account list. There is no error branch.
- **Mobile launcher**: `apps/web/src/app/projects/[projectId]/_components/mobile-launch/MobileLaunchSheetContainer.tsx`.
  Mounted by the "+" tab bar action, gated by `AppShell` on `hasFeature('monthlyOverview')` (PESSOAL
  only reaches it in practice, but the file is defensive — see #218 comment at top of file). The
  `extrato` screen (`screen==='extrato' && canImportBankStatement && !selectedAccountId`) queries
  `['project', projectId, 'bank-accounts']` and today only branches `accounts.length===0` →
  `SemContaEmptyState` vs the list (no explicit loading/error branch either — `data=[]` default masks
  "loading" as "zero").
- **The importer**: `apps/web/src/app/projects/[projectId]/bank-accounts/_components/ImportWithoutAccountModal.tsx`.
  Defaults `documentType` state to `"bank"` (extrato) already — no prop needed to "preset extrato".
  Internal `committedNotifiedRef` guard already makes `onCommitted` fire exactly once no matter how
  it's triggered (Escape, close button, or the internal 1.5s timer at commit success). Consumed
  as-is by `ImportMassStep` today (`onClose={closeModal}` / `onCommitted={() => {closeModal(); onDone();}}`) —
  same shape the two launchers already use for `ImportStatementModal`/`ImportBankStatementModal`.
- **Gate pattern to copy**: `BankAccountsSection.tsx` — `canManage = hasFeature(projectType,'bankAccounts') && hasModule('bankAccounts')`,
  then branches `accountsQuery.isLoading` / `accountsQuery.isError` / `accountsQuery.isSuccess`
  (never conflates loading/error with "zero"). This is the mechanism both launchers must copy for
  the picker's account-count query — they currently don't have an `isError` branch to copy from,
  but the shape is a direct lift.

## 3. Exact insertion point

### Desktop — `NovaDespesaLauncher.tsx`
In the `importStep==='pick-account' && !selectedAccount` `<Modal>` block (current lines ~259-283):
1. Rename the query result to expose the full status triplet: `const { data: importAccounts = [], isLoading: loadingAccounts, isError: accountsError, refetch: refetchAccounts } = useQuery(...)` (same query key/queryFn/enabled — no key change, so no extra request).
2. Add local state `const [carteiraImportOpen, setCarteiraImportOpen] = useState(false)`.
3. Add the gate `const canImportToCarteira = hasFeature(projectType as ProjectType,'monthlyOverview') && canImportBankStatement && hasFeature(projectType as ProjectType,'receipts') && hasModule('receipts')` (module 42-47 area, next to `canImportBankStatement`).
4. Branch inside the Modal:
   - `loadingAccounts` → unchanged "Carregando contas…" text (must NOT show the zero-state CTAs or `SemContaEmptyState`).
   - `!loadingAccounts && accountsError` → new `role="alert"` block, copy of `BankAccountsSection`'s error box: "Não foi possível carregar as contas bancárias." + "Tentar novamente" button (`onClick={() => refetchAccounts()}`). Must NOT show the zero-state CTAs.
   - `!loadingAccounts && !accountsError && importAccounts.length===0` → **replace** the bare `<SemContaEmptyState>` with, when `canImportToCarteira`: an ordered CTA cluster — `<button>Importar para Carteira</button>` (`onClick={() => setCarteiraImportOpen(true)}`) rendered **before** `<SemContaEmptyState projectId={projectId} />` (which already renders "Nova conta" as its empty-state action — reused unchanged, satisfies "then Nova conta"). When `!canImportToCarteira`, keep today's bare `SemContaEmptyState` (no regression for REFORMA/CASA/CARRO or a module-less PESSOAL user).
   - `!loadingAccounts && !accountsError && importAccounts.length>0` → unchanged list.
5. After the Modal, add:
   ```tsx
   {carteiraImportOpen && (
     <ImportWithoutAccountModal
       projectId={projectId}
       onClose={() => setCarteiraImportOpen(false)}
       onCommitted={() => {
         setCarteiraImportOpen(false);
         setImportStep(null);
         invalidate();
         invalidateImportQueries(queryClient, projectId);
       }}
     />
   )}
   ```
   (Same shape as the existing `selectedCard`/`selectedAccount` blocks at L285-301 — one `invalidate()` + one `invalidateImportQueries()` call, guarded by the modal's own once-only `onCommitted`.)

### Mobile — `MobileLaunchSheetContainer.tsx`
Mirror the same shape in the `screen==='extrato' && canImportBankStatement && !selectedAccountId`
block (current lines ~328-347):
1. Add `isLoading: accountsLoading, isError: accountsError` to the `accounts` query destructure (same key `['project', projectId, 'bank-accounts']`).
2. Add `const [carteiraImportOpen, setCarteiraImportOpen] = useState(false)`, reset alongside
   `selectedCardId`/`selectedAccountId` both in the `open` effect (L59-65) and in `handleClose` (L155-160) — same reset discipline the existing state already has, so re-opening the "+" always restarts at `choose`.
3. Add `canImportToCarteira` next to `canImportBankStatement` (L49-50), same expression as desktop.
4. Branch loading/error/zero exactly as desktop, with the "Importar para Carteira" button first, `SemContaEmptyState` (→ "Nova conta") after, gated by `canImportToCarteira`.
5. Render:
   ```tsx
   {open && screen === 'extrato' && carteiraImportOpen && (
     <ImportWithoutAccountModal
       projectId={projectId}
       onClose={() => setCarteiraImportOpen(false)}
       onCommitted={handleImported}
     />
   )}
   ```
   `handleImported` already does `invalidateImportQueries` + `handleClose()` exactly once (L162-168) — reused unchanged, so mobile gets the once-only guarantee for free.

## 4. The gate expression (exact, no hard-coded type)
```ts
const canImportToCarteira =
  hasFeature(projectType as ProjectType, 'monthlyOverview') &&   // "is PESSOAL" without a literal
  hasFeature(projectType as ProjectType, 'bankAccounts') && hasModule('bankAccounts') &&
  hasFeature(projectType as ProjectType, 'receipts') && hasModule('receipts');
```
`monthlyOverview` is the feature that is PESSOAL-only today (per `PROJECT_FEATURES` table in
`CLAUDE.md` and the existing `MobileLaunchSheetContainer` top-of-file comment) — using it instead of
`projectType==='PESSOAL'` means the gate tracks the domain config, not a literal, per the golden
rule about `PROJECT_FEATURES`/`TYPE_MODULES` divergence (rule set in `CLAUDE.md` §"Financeiro por
tipo"). `bankAccounts` and `receipts` are both real PESSOAL features (`packages/domain/src/config/project-features.ts`)
and both real `TYPE_MODULES` authorization slugs — `hasModule` must be checked for both, mirroring
`BankAccountsSection.tsx`'s single-feature pattern extended to the two capabilities this affordance
actually needs (list accounts + write receipts).

## 5. Zero vs loading vs error — the distinguishing mechanism
React Query's own status triplet on the *existing* account-count query (no new query, no new
network call): `isLoading` (no data yet, first fetch in flight) → `isError` (settled, failed) →
`isSuccess && data.length===0` (settled, empty) → `isSuccess && data.length>0`. This is exactly the
`BankAccountsSection.tsx` shape. The bug being fixed is that today's code only has 2 branches
(`loadingAccounts` / `length===0`), which conflates "haven't checked yet" and "checked, zero" in one
dimension and has no representation at all for "checked, failed" (a failed fetch silently renders as
"zero contas" today because `data` defaults to `[]`) — that is precisely the failure mode the RED
spec's loading/error tests target.

## 6. Cancel-no-loop mechanism
`carteiraImportOpen` is `false` by default and only ever set `true` by a direct user click. Its
`onClose` handler sets it back to `false` and nothing else — no effect depends on it, so there is no
path back to `true` without another explicit click. The picker Modal underneath is untouched by the
cancel (desktop: `importStep` stays `'pick-account'`; mobile: `screen` stays `'extrato'`) — the user
lands back on the zero-accounts CTA cluster, "no loop" is structural (no `useEffect` watches
`carteiraImportOpen`), not timing-based.

## 7. Once-only `onCommitted`/invalidate/close
`ImportWithoutAccountModal` already owns this guarantee internally via `committedNotifiedRef` +
`notifyCommitted()` (idempotent: `if (committedNotifiedRef.current) return;`) — called from exactly
one of three triggers (Escape/close-button after success, or the internal `setTimeout`), never more
than once. Both launchers' `onCommitted` handlers are plain, unguarded closures that call
`invalidate()`/`invalidateImportQueries()`/state-setters exactly once *each time the modal itself
calls `onCommitted`* — since the modal guarantees a single call, the launchers get the "exactly once"
property for free without adding their own guard. This is the same pattern already used for
`selectedCard`/`selectedAccount` in both files — no new mechanism, just a third instance of it.

## 8. OPEN QUESTION for the orchestrator — "success persists until Concluir" vs "don't touch modal internals"
These two scope lines are in tension:
- "Success state stays visible until the user hits 'Concluir' — it must not auto-dismiss."
- "Do NOT change: … `ImportWithoutAccountModal`'s internals (you consume it as-is)."

Today the modal's success screen (`committedCount !== null`) has **no button at all** — no
"Concluir", no close. The only exits are Escape or the internal `setTimeout(notifyCommitted, 1500)`
(this is Journey-QA Gap 4 from the #668 review, never fixed). Reusing the modal "as-is" means the
success screen auto-dismisses at 1.5s — the opposite of "must not auto-dismiss" and there is no
"Concluir" to click. **Both cannot hold without a minimal, additive change to the modal**: add an
explicit "Concluir" button in the success branch (calls `notifyCommitted()`, same guarded function
that already exists) and remove the 1.5s `setTimeout`. This is a small, additive change confined to
the success branch — it does not touch import/preview/commit logic, the `possibleDuplicate` contract,
or any prop surface — and it also closes Gap 4. The RED spec below (`ImportWithoutAccountModal.concluir.test.tsx`)
targets exactly this and is written to fail for the right reason: assert a "Concluir" button exists
in the success state, and assert `onCommitted` is NOT called merely by the passage of time. **If the
PO wants zero changes to the modal file, drop that one spec file and its production line item** — the
reachability work (§3) stands on its own either way.

## 9. Fan-out / empty-set audit
Not applicable in the classic "1 source → N targets" sense, but the analogous edge case here is
"zero accounts is the state that MUST make the CTA reachable, not the state that hides it" — audited
explicitly in §5 above (the RED spec's "loading must not look like a valid zero-CTA state and error
must not either" tests are the enforcement-point audit for this feature, since the CTA's *only*
trigger condition is "zero, confirmed").

## 10. Production file/function change list (for frontend-expert)
1. `apps/web/src/app/projects/[projectId]/expenses/_components/NovaDespesaLauncher.tsx` — §3 desktop.
2. `apps/web/src/app/projects/[projectId]/_components/mobile-launch/MobileLaunchSheetContainer.tsx` — §3 mobile.
3. (Conditional on §8 resolution) `apps/web/src/app/projects/[projectId]/bank-accounts/_components/ImportWithoutAccountModal.tsx` — add "Concluir" button to the success branch, remove the 1.5s auto-timer (`committedTimerRef`/`setTimeout` at L443-445 and its cleanup at L237-240, L261-267).
4. No API, Prisma, journeys, or `possibleDuplicate` changes.

## 11. Adversarial pass
- **Double-open**: clicking "Importar para Carteira" twice fast — `setCarteiraImportOpen(true)` is idempotent (same value), React won't double-mount; the modal itself is keyless single-instance in a conditional block, not a list, so there's no duplicate-mount risk.
- **Race between picker settling and gate flipping** (e.g. `hasModule` resolves after first render): `canImportToCarteira` is derived from `useAuth()` on every render, not cached — if it flips from false→true mid-session the CTA appears on next render without a stale closure, matching how `canImportBankStatement` already behaves.
- **Existing-accounts regression**: the `importAccounts.length>0` branch is untouched — same JSX, same query, same key. The new state (`carteiraImportOpen`) defaults false and is never set true by the "has accounts" path, so `ImportWithoutAccountModal` never mounts when accounts exist.
- **Error retry then success**: `refetchAccounts()` uses the same `queryKey`, so a retry that returns `[]` correctly falls through to the zero-CTA branch (not stuck in error) since `isError` becomes false on the new fetch — verified implicitly by React Query's own status transition, no extra code needed.
