# ReformaFlow Agent Instructions

## Sources of truth

- Read `docs/README.md`; it indexes normative business contracts and the active UX plan.
- For PESSOAL/financial work, read `docs/estado-atual-cockpit-pessoal.md`, `docs/cockpit-caixa-real.md`, `docs/visao-conta-faturas.md`, and `docs/politica-datas-timezone.md`.
- For program #436 work, also read `docs/plano-centro-financeiro-sdd.md`; it is approved planning, not evidence that Centro Financeiro, U6b, Maria agent-first, or H1–H5 shipped.
- Do not infer implementation status from old plans or a dirty shared checkout. Check the current branch, `origin/main`, and the actual code.

## Package manager and commands

Use Node 20+ and npm workspaces (`npm@11.6.2`); do not use pnpm.

| Task | Command |
|---|---|
| Install | `npm ci` |
| Run web + API | `npm run dev` |
| Run API persistently | `./start-api.sh` (`PORT=3011 ./start-api.sh` for another instance) |
| Type-check one package | `cd apps/web && npx tsc --noEmit` (same for `apps/api` or `packages/domain`) |
| Build changed domain package | `npm --workspace @reformaflow/domain run build` |
| Build one app | `npx turbo run build --filter=@reformaflow/web` |
| Lint API | `npm --workspace @reformaflow/api run lint` |
| Prepare disposable test DB | `npm run test:db:prepare` |
| Test one API spec | `cd apps/api && npx jest src/path/file.spec.ts` |
| Test one web file | `cd apps/web && npx vitest run src/path/file.test.tsx` |
| Test one domain file | `cd packages/domain && npx vitest run __tests__/file.test.ts` |
| Test one browser spec | `cd apps/web && TZ=UTC npx playwright test e2e/file.spec.ts` |
| Full tests | `npm test` |

## Architecture

- Turbo monorepo: `apps/web` is Next.js 14 App Router (port 3000), `apps/api` is modular NestJS (port 3001), and `packages/domain` holds shared enums, pure rules, authorization maps, and calculations.
- Browser requests use `apps/web/src/lib/api.ts` with cookie credentials. Nest applies global JWT, role, module, and project-access guards before Prisma reaches SQLite.
- Import domain code only through `@reformaflow/domain`; rebuild it after changes because both apps consume its generated output.
- PESSOAL is the cross-project financial cockpit. Account/card imports, expenses, receipts, settlements, allocations, and mirrors feed monthly/account views; their contracts live in `docs/`.
- Maria uses Gemini for agent/classification flows and VibeVoice on Modal for TTS. Static uploads are served from `uploads/` at `/uploads/`.

## Project-type gates

- `PROJECT_FEATURES` controls product capability, `TYPE_MODULES` controls authorization, and `PROJECT_NAV` controls rendered navigation. They are distinct sources in `packages/domain/src/config`; never replace them with hard-coded project-type checks.
- `expenses` capability is intentionally retained for CASA/CARRO while their `/expenses` navigation redirects to the Avulsas tab in `/bills`.
- `carInfo` is a CARRO-only 1:1 resource, not a feature flag; its API uses `PUT` with Prisma `upsert`.
- Authorization reconciliation must remain in both `AuthService.buildPublicUser` and `JwtStrategy.validate`, using union semantics. All three grant columns (`allowedProjects`, `allowedModules`, `allowedProjectTypes`) share one fail-closed parser, `parseGrantJson` in `apps/api/src/auth/grant-json.ts`: missing/blank/malformed JSON, a non-array, or an array with no string values all fail the whole read closed (401) instead of degrading to `[]` (read downstream as "no restriction"). `AuthService.updateSelfObjectives` reuses the same parser inside its own transaction — see the self-authorization rule in `docs/saas-onboarding.md`.
- `MonthlyOverviewController` binds its project param as `:pessoalProjectId`, not `:projectId` — deliberately. `ProjectAccessGuard` only recognizes literal `projectId`/`sourceProjectId`/`targetProjectId` param/query/body keys; keeping `:projectId` would let that guard short-circuit with a blanket 403 (or silently allow) before `MonthlyOverviewService.resolveAnchor`/`resolveHub` ever runs, which is what has to own the 404 (missing/deleted/cross-tenant) vs 403 (out-of-scope) vs 400 (authorized but not PESSOAL) distinction. Do not rename it back to `projectId`. Because that guard is bypassed, EVERY handler on this route must itself pass the full `MonthlyOverviewRequester` into service-level anchor resolution (`ensurePessoalProject`/`resolveAnchor`/`resolveHub`) — passing only `requester.id` (e.g. for audit) is not enough.

## Data and test safety

- Never run `prisma migrate reset`, `db push --force-reset`, delete `prisma/dev.db`, or run tests against it; it contains real data.
- Before schema migrations, back up `prisma/dev.db`, then run `cd apps/api && npx prisma migrate dev --name <desc> --schema=../../prisma/schema.prisma`.
- Every test runner or standalone Prisma test must load `scripts/test-db-env.cjs`; intentional dev scripts and Playwright against a running API are exceptions.
- Prisma soft-delete behavior lives in `apps/api/src/prisma/prisma.service.ts`. Add models without `deletedAt` to `modelsWithoutSoftDelete` in the same change. Prisma transaction clients bypass `$use`.
- Cross-project rateio allocations must sum to the source `valorTotal`. PESSOAL movements without card/account belong to Carteira and must remain visible in account views and totals.
- In PESSOAL account views, count a rateio source exactly once, preserve its Carteira/account/card origin, and exclude every paid target from `saidas`/`saiuMes` by enumerating tenant-scoped `RateioAllocation`.
- `Expense.linkedExpenseId` reflects only the **first** target of a rateio (legacy 1:1 field); it is not the full allocation set. `GET :id/rateio` may receive a source or target id: resolve the canonical `sourceExpenseId` through tenant-scoped `RateioAllocation` (never through `linkedExpenseId`), then require ACL access to **every** participant.
- `GET :id/rateio` is **source-only** (#448 B1b, shipped): unless the requester can see every active participant AND the enumerated allocations sum exactly to the source `valorTotal`, respond with the payload of a purchase that was **never** rateada — anchored on the id that was asked for, never on the resolved source. There is no partial list, no `hidden*` field, and no number a partial list could be subtracted from. A redacted response must stay byte-identical to a never-rateada one: any new field breaks that indistinguishability. Lock: `apps/api/src/expense/expense.rateio-redaction.spec.ts`.
- Legacy `last4` identity is fail-loud, never fail-silent: when `payInvoice`/`undoInvoicePayment` resolve a card/account by `last4` alone and more than one active row matches, respond **409** (`resolveUniqueLegacyMatch`, `apps/api/src/common/invoice-identity.ts`) instead of picking one. Prefer explicit `cardId`/`accountId`; settlement is never resolved by `tenantId+last4` alone.
- The view side of that contract is **not optional and not implicit**: a surface that renders an invoice CTA must consume the server's `actions` array and never synthesize its own verb. The server already answers `actions: []` for an ambiguous `last4`; a client that ignores the field renders a button whose only outcome is a 409 the user cannot act on. Shipping the server half without the client half turns "fail loud" into "dead end" — pair them in the same release.
- Merchant-category rules are tenant-scoped and change category only, never value or cash; readers and writers must pass `tenantId`.

## Code and UI conventions

- Keep route pages thin; place route-local components, hooks, types, and helpers in `_components`, `_hooks`, `_types.ts`, and `_lib`.
- Call `useProject()` only inside React components/hooks. Reuse `apps/web/src/lib/api.ts`, `apps/web/src/lib/expense-options.ts`, and domain exports instead of parallel helpers.
- Freeze the clock in current-month tests (`vi.setSystemTime` or `page.clock.setFixedTime` before navigation) and validate date-sensitive suites with `TZ=UTC`.
- Route, auth/onboarding, and access-gate changes require Playwright because jsdom does not exercise redirects or middleware; reproduce parallel-only failures with `--workers=1`.
- Update `docs/manual-do-aplicativo.md` in the same change when visible behavior changes.
- In a Nest controller mixing literal and `:id` routes, declare literal
  segments (e.g. `@Get('paid-origins')`) BEFORE the `@Get(':id')` handler —
  otherwise the parameterized route swallows the literal one as an id.
- UI changes require runtime QA at 375/390px and desktop. Use `MovimentacaoRow` as the financial-list layout; keep touch targets at least 44px and monetary values `nowrap`.
- Mobile means the responsive/PWA experience in `apps/web`, never a native iOS/Android app.
- Maria tool money values stay strings until `parseSpokenMoney`; schedule ordering goes through `sortScheduleByDate`.

## Collaboration

- Work in an isolated git worktree. Never edit/reset the shared checkout or use `git stash`, which is shared across worktrees.
- Never remove `apps/web/src/app/prototype/agent-monitor/` or `tools/agent-monitor/`; both are production functionality.
- For multi-agent coordination, use `.claude/agents/fleet-po.md`. One owner per branch; the PO owns merge order.
- Experience owners decide Web, Mobile/PWA, or Maria contracts; the existing backend/frontend builders continue to implement them.
- Open PRs against `main`, verify `baseRefName=main`, and require `gh pr checks <n>` to be green before merging.
- AI commits must include the agent's own `Co-authored-by` trailer.

## Scars — rules paid for with an incident

Each line is a real failure, with its date and what it actually cost. Delete one only when you can show the failure is now structurally impossible.

- **A dead screen does not imply a dead service** (2026-08-19). `/financeiro` was unreachable for 200 of 200 users, so an agent retiring it also deleted 146 lines from `agent-tools.service.ts` — silently removing six *live* Maria tools. Maria never went through the screen's permission; her gate is `financialScope()`. Before removing any service code behind a dead surface, enumerate the callers, not the routes. Retire HTTP and screens; never the calculation.
- **A barrier test must not derive its expectation from the constant it protects** (2026-08-19). The first guard against that deletion read the same list the next remover would edit, so it would have gone green while the capability vanished. Pin the expected set literally.
- **A PR must not edit the contract it has to satisfy** (2026-08-19). A change deleted the `AGENTS.md` line stating the rateio contract and replaced it with wording that legalized the very leak it was supposed to close. Contract edits ship in their own commit, reviewed against the code, never inside the feature that must obey them.
- **Before changing a field, read the docstring of its type** (2026-08-19). `rateio.types.ts:52-57` carried an explicit warning that "fixing" `rateadoCents` to Σ visible items would reopen a known leak. The change was made anyway, and the review (mine included) never opened that file. The invariant was written where it belonged; nobody looked.
- **A partial list plus a total is a leak by subtraction** (2026-08-19). Redacting items while keeping a total-aware sum let any reader compute the hidden amount exactly, because the server refuses writes unless allocations sum to `valorTotal`. Redaction is only safe when the response carries no derivable remainder — hence source-only.
- **Review both halves of a PR whose title says "and"** (2026-08-20). #499 shipped "409 on ambiguous `last4` **and** all-or-nothing rateio". Only the rateio half was reviewed; the `last4` half reached production without its web counterpart, leaving a real tenant with two cards ending `1234` facing a CTA that could only 409. When a PR carries two changes, ask of each: does this half have a counterpart that is not merged yet?
