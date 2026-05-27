# reformaflow — Agent Guidance

Monorepo Turbo (pnpm): **Next 14 (App Router)** + **NestJS** + **Prisma/SQLite** + Tailwind + React Query + Zustand + recharts + dnd-kit.

## Pré-commit

Há um hook git ativo que roda `tsc --noEmit` em `packages/domain`, `apps/api`, `apps/web`. Ele bloqueia o commit se falhar — não é necessário rodar manualmente. Se mudou `packages/domain/src/`, rode `cd packages/domain && npm run build` antes do commit (o `dist` é consumido pelos apps).

Se mudou `prisma/schema.prisma`: **backup obrigatório** `cp prisma/dev.db prisma/dev.db.bak-$(date +%Y%m%d-%H%M%S)`, depois `cd apps/api && npx prisma migrate dev --name <desc> --schema=../../prisma/schema.prisma`.

## Layout

- `apps/api/` — NestJS, porta **3001**, DB `prisma/dev.db`. Módulos: expense, cash-flow, dashboard, simulation, floor-plan, room, link-preview, price-compare, car-info, recurring-bill, maintenance, reminder, schedule.
- `apps/web/` — Next.js, porta **3000**. Rotas dinâmicas em `src/app/projects/[projectId]/...`.
- `packages/domain/` — enums + regras (`ExpenseTypeLabels`, `ProjectType`, `getExpenseTypesForProject`, `PROJECT_FEATURES`, `hasFeature`). **Barrel only**: importar via `@reformaflow/domain`. Após mudar, `npm run build`.
- `packages/config/` — TS configs compartilhados.

## Comandos

```bash
pnpm dev                                         # tudo (Turbo)
./start-api.sh                                   # API estável em background
pnpm --filter @reformaflow/{web,api} build       # builds
pnpm --filter @reformaflow/web exec tsc --noEmit # type-check rápido
```

## Tipos de projeto (em `packages/domain/src/config/project-features.ts`)

| Tipo | Módulos |
|---|---|
| REFORMA | dashboard, expenses, receipts, cashFlow, rooms, floorPlans, simulation, priceCompare |
| COMPRA | dashboard, expenses, receipts, cashFlow |
| CASA | dashboard, recurringBills, maintenance, reminders |
| CARRO | dashboard, recurringBills, maintenance, reminders, carInfo |

## Convenções

- **Páginas ≤ 400 linhas / 20 KB**. Quebrar em `<rota>/_components/Foo.tsx` (private folders) + `<rota>/_types.ts` + `<rota>/_hooks/useFoo.ts`.
- **Labels/options de despesas**: `apps/web/src/lib/expense-options.ts` (`TIPO_DESPESA_OPTIONS`, `CATEGORIA_MAO_DE_OBRA_OPTIONS`, `FORMA_PAGAMENTO_OPTIONS`, `tipoLabel`, `formaLabel`, `catMaoLabel`).
- **`useProject` é hook**: chamar dentro do componente, nunca no topo do módulo.

## Regras de ouro (cicatrizes — não repetir)

1. **NUNCA** `prisma migrate reset` / `db push --force-reset` / `rm prisma/dev.db` — há dados reais. Backup antes de migration.
2. CSS Tailwind é frágil — confirme classes antes de remover; não faça swaps em massa.
3. `prisma.service.ts` aplica soft-delete via `$use` (delete → update `deletedAt`). Modelos sem `deletedAt` precisam estar em `modelsWithoutSoftDelete` (atualmente: `SimulationValue`, `Simulation`, `FloorPlanRoom`, `RoomImage`).
4. `$transaction` ignora `$use` — em tx, retornar id e chamar `findById` fora.
5. `nest build`/`tsc` às vezes geram `.js`/`.d.ts` dentro de `apps/*/src/app` → "Duplicate page". Limpar: `find apps/*/src -name 'page.js' -delete`.
6. `CarInfo` é 1:1 com `Project` → endpoint usa `PUT` + Prisma `upsert`.
7. Em `FloorPlanRoom.reanalyze`, use `deleteMany({where})` simples — FK cascade cuida do resto (não há soft-delete nesse modelo).
8. **API NestJS morre se o shell que iniciou fechar.** Use `./start-api.sh` ou `bash` async detached.
9. **EMU bloqueia `gh`/`git push` no repo pessoal.** Solução: `unset GH_TOKEN && gh auth switch -u Gabrieldco1994` antes de operações no GitHub.

## Notas técnicas (consulte quando tocar o módulo)

- **Gemini 2.5-flash**: thinking tokens contam para `maxOutputTokens`. Usar `16K` + `responseMimeType:'application/json'` (sem `responseSchema`). Repair de JSON truncado já existe em `gemini.service.ts`.
- **Price compare**: Buscapé via `__NEXT_DATA__` (sem API key). Google CSE retorna 403 (não habilitado).
- **Floor plans**: `react-zoom-pan-pinch` precisa `disabled={drawingMode}` para permitir desenho.
- **Static uploads**: `ServeStaticModule` serve `{cwd}/uploads/` em `/uploads/`. Floor plans em `uploads/floor-plans/`, room images em `uploads/room-images/`.

## Variáveis de ambiente

`DATABASE_URL`, `GOOGLE_API_KEY` (Gemini), `GOOGLE_SEARCH_ENGINE_ID` (opcional). Portas: web 3000, api 3001.
