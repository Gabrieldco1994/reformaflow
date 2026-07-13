# reformaflow — Agent Guidance

Monorepo Turbo (**npm workspaces**, `packageManager: npm@11.6.2`): **Next 14 (App Router)** + **NestJS** + **Prisma/SQLite** + Tailwind + React Query + Zustand + recharts + dnd-kit.

> **`pnpm` NÃO está instalado nesta máquina.** Use `npm`/`npx`. Para scripts em um pacote específico, `cd` na pasta e chame `npx` direto (ex.: `cd apps/api && npx jest`, `cd packages/domain && npx vitest run`).

## Leitura obrigatória no início de sessão (status real)

1. Ler `docs/estado-atual-cockpit-pessoal.md` (fonte de verdade de status/escopo).
2. Ler `docs/cockpit-caixa-real.md` e `docs/visao-conta-faturas.md` para regras de negócio.
3. Confirmar estado do git antes de concluir "falta implementar":

```bash
git --no-pager branch -vv
git --no-pager log --oneline -20
git --no-pager log --oneline --all | grep -E "feat\\(cockpit\\): Fase [1-6]|feat\\(cockpit\\): caixa real"
```

> Não assumir status por plano antigo/handoff local sem validar no histórico do git.

## Pré-commit

Há um hook git ativo que roda `tsc --noEmit` em `packages/domain`, `apps/api`, `apps/web`. Ele bloqueia o commit se falhar — não é necessário rodar manualmente. Se mudou `packages/domain/src/`, rode `cd packages/domain && npm run build` antes do commit (o `dist` é consumido pelos apps).

Se mudou `prisma/schema.prisma`: **backup obrigatório** `cp prisma/dev.db prisma/dev.db.bak-$(date +%Y%m%d-%H%M%S)`, depois `cd apps/api && npx prisma migrate dev --name <desc> --schema=../../prisma/schema.prisma`.

## Layout

- `apps/api/` — NestJS, porta **3001**, DB `prisma/dev.db`. Módulos principais: expense, cash-flow, dashboard, simulation, floor-plan, room, price-compare, car-info, recurring-bill, maintenance, reminder, schedule, receipt, project, tenant. Cockpit PESSOAL/financeiro: monthly-overview, tenant-financial, conciliacao, credit-card, bank-account, budget-allocation, category-budget. Assistente Maria: agent, tts, merchant-classifier. Infra: auth, users, common, prisma, notifications, link-preview.
- `apps/web/` — Next.js, porta **3000**. Rotas dinâmicas em `src/app/projects/[projectId]/...` (cockpit em `.../monthly`).
- `packages/domain/` — enums + regras (`ExpenseTypeLabels`, `ProjectType`, `getExpenseTypesForProject`, `PROJECT_FEATURES`, `hasFeature`). **Barrel only**: importar via `@reformaflow/domain`. Após mudar, `npm run build`.

## Comandos

```bash
npm run dev                                       # tudo (Turbo: web + api)
./start-api.sh                                    # API estável em background (sobrevive ao shell)
npx turbo run build --filter=@reformaflow/web     # build de um app
cd apps/web && npx tsc --noEmit                   # type-check rápido (idem apps/api, packages/domain)
cd apps/api && npx jest                           # testes API (jest, *.spec.ts)
cd packages/domain && npx vitest run              # testes domínio (vitest, __tests__/*.test.ts)
```

## Tipos de projeto (em `packages/domain/src/config/project-features.ts` — fonte de verdade)

`PROJECT_FEATURES`/`hasFeature`. Gate de UI/rotas sempre por `hasFeature(tipo, 'x')`, nunca por tipo hard-coded.

| Tipo | Módulos (features) |
|---|---|
| REFORMA | dashboard, expenses, receipts, cashFlow, rooms, floorPlans, simulation, priceCompare |
| COMPRA | dashboard, expenses, receipts, cashFlow |
| CASA | dashboard, recurringBills, maintenance, reminders, **expenses** (avulsas) |
| CARRO | dashboard, recurringBills, maintenance, reminders, **expenses** (avulsas) |
| PESSOAL | monthlyOverview, dashboard, expenses, receipts, cashFlow, creditCards, bankAccounts |
| PLANTAS | dashboard, maintenance, reminders, plantsAi |

> `carInfo` **não** é uma feature de `PROJECT_FEATURES` — é um endpoint/módulo 1:1 com `Project` (`PUT` + upsert), específico de CARRO. CASA e CARRO compartilham o mesmo conjunto (recurringBills/maintenance/reminders/expenses); CARRO só acrescenta o registro `carInfo`. Como CASA/CARRO têm `expenses`, suas despesas planejadas podem ser alvo de vínculo/rateio cross-project a partir do PESSOAL.

## Convenções

- **Páginas ≤ 400 linhas / 20 KB** (convenção-alvo; algumas páginas legadas excedem, ex. `floor-plans/page.tsx` — tratar como dívida a quebrar). Quebrar em `<rota>/_components/Foo.tsx` (private folders) + `<rota>/_types.ts` + `<rota>/_hooks/useFoo.ts` + `<rota>/_lib/*.ts`.
- **Labels/options de despesas**: helpers de forma de pagamento e categoria de mão de obra em `apps/web/src/lib/expense-options.ts` (`FORMA_PAGAMENTO_OPTIONS`, `CATEGORIA_MAO_DE_OBRA_OPTIONS`, `tipoLabel`, `formaLabel`, `catMaoLabel`). **Options de tipo de despesa** vêm de `getExpenseOptions(projectType)` em `apps/web/src/app/projects/[projectId]/expenses/_types.ts`.
- **`useProject` é hook**: chamar dentro do componente, nunca no topo do módulo.

## Regras de ouro (cicatrizes — não repetir)

1. **NUNCA** `prisma migrate reset` / `db push --force-reset` / `rm prisma/dev.db` — há dados reais. Backup antes de migration.
2. CSS Tailwind é frágil — confirme classes antes de remover; não faça swaps em massa.
3. `prisma.service.ts` aplica soft-delete via `$use` (delete → update `deletedAt`). Modelos sem `deletedAt` precisam estar em `modelsWithoutSoftDelete` (atualmente: `SimulationValue`, `Simulation`, `FloorPlanRoom`, `RoomImage`, `FloorPlanMarker`, `CarInfo`, `MerchantCategory`, `CrossProjectSettlement`, `RateioAllocation`, `PlantDiagnosisLog`). Modelo novo sem `deletedAt` → atualizar essa lista na mesma mudança.
4. `$transaction` ignora `$use` — em tx, retornar id e chamar `findById` fora.
5. `nest build`/`tsc` às vezes geram `.js`/`.d.ts` dentro de `apps/*/src/app` → "Duplicate page". Limpar: `find apps/*/src -name 'page.js' -delete`.
6. `CarInfo` é 1:1 com `Project` → endpoint usa `PUT` + Prisma `upsert`.
7. Em `FloorPlanRoom.reanalyze`, use `deleteMany({where})` simples — FK cascade cuida do resto (não há soft-delete nesse modelo).
8. **API NestJS morre se o shell que iniciou fechar.** Use `./start-api.sh` ou `bash` async detached.
9. **EMU bloqueia `gh`/`git push` no repo pessoal.** Solução: `unset GH_TOKEN && gh auth switch -u Gabrieldco1994` antes de operações no GitHub.

## Notas técnicas (consulte quando tocar o módulo)

- **Status consolidado do Cockpit PESSOAL**: ver `docs/estado-atual-cockpit-pessoal.md` antes de qualquer análise de escopo.
- **Visão Conta / Faturas de cartão**: regra de neutros, agregação de fatura, casamento pagamento→fatura (`matchPaidInvoices`, por valor+janela) e "cartão paga cartão" (`settlesInvoiceKey` + `computePaidInvoiceKeys`) estão documentados em `docs/visao-conta-faturas.md`. Caixa real §10 em `docs/cockpit-caixa-real.md`.
- **Gemini 2.5-flash**: thinking tokens contam para `maxOutputTokens`. Usar `16K` + `responseMimeType:'application/json'` (sem `responseSchema`). Repair de JSON truncado já existe em `gemini.service.ts`.
- **Price compare**: Buscapé via `__NEXT_DATA__` (sem API key). Google CSE retorna 403 (não habilitado).
- **Floor plans**: `react-zoom-pan-pinch` precisa `disabled={drawingMode}` para permitir desenho.
- **Static uploads**: `ServeStaticModule` serve `{cwd}/uploads/` em `/uploads/`. Floor plans em `uploads/floor-plans/`, room images em `uploads/room-images/`.
- **Rateio (ratear compra)**: distribuir 1 compra parcelada do PESSOAL entre N despesas planejadas de outro projeto. Motor em `conciliacao.service.ts` (`ratearSource`/`unratearSource`); as allocations DEVEM somar o `valorTotal` da fonte (senão dinheiro some do consolidado). Fonte vira espelho (`linkedExpenseId=firstTarget`). `RateioAllocation` não tem `deletedAt`. Endpoints `POST/DELETE :id/ratear`. Modal `RatearCompraModal.tsx` (só PESSOAL).
- **Voz/Maria (assistente)**: `valor` nas tools é **string** (parseada por `parseSpokenMoney` em `agent/tools/money-parse.ts`, vírgula=decimal; ×100 só no `expense.create`) — evita o bug 100x. Tool `update_expense` completa data/tipo faltantes. TTS via VibeVoice no Modal (`deploy/modal/`).
- **Cronograma**: tarefas/etapas exibidas em ordem cronológica (data+predecessoras) via `sortScheduleByDate` em `@reformaflow/domain` — aplicado no backend (`getGanttData`) e no front (`recalcAll`), não pela ordem de inserção.

## Variáveis de ambiente

`DATABASE_URL`, `GOOGLE_API_KEY` (Gemini), `GOOGLE_SEARCH_ENGINE_ID` (opcional). Portas: web 3000, api 3001.
