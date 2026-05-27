# reformaflow — Agent Guidance

## ✅ Checklist Obrigatório Antes de Qualquer Commit

Execute **sempre** antes de `git commit`, independente do tamanho da mudança:

### Se mudou `packages/domain/src/`:
```bash
cd packages/domain && npm run build
cd ../..
```

### Verificações de tipo (rodar da raiz):
```bash
cd packages/domain && npx tsc --noEmit
cd ../../apps/api && npx tsc --noEmit
cd ../../apps/web && npx tsc --noEmit
```

### Se mudou a API:
```bash
npm --workspace @reformaflow/api run build
```

### Se mudou o schema Prisma:
```bash
# 1. BACKUP OBRIGATÓRIO
cp prisma/dev.db prisma/dev.db.bak-$(date +%Y%m%d-%H%M%S)

# 2. Criar migration
cd apps/api && npx prisma migrate dev --name <descricao> --schema=../../prisma/schema.prisma
```

### Verificação de artefatos perdidos:
```bash
# Garante que nest build não gerou .js dentro de src/app (causa "Duplicate page")
find apps/web/src -name "page.js" -o -name "layout.js" | head -5
# Se encontrar algo: find apps/web/src -name "page.js" -delete
```

### ❌ Nunca commitar se:
- Qualquer `tsc --noEmit` retornar erros
- `nest build` retornar erros
- Existirem `console.log` de debug com dados de usuário
- O domain foi modificado mas `npm run build` não foi rodado

---

Monorepo Turbo (pnpm) com **Next 14 (App Router)** + **NestJS** + **Prisma/SQLite** + **Tailwind** + React Query + Zustand + recharts + dnd-kit.

## Layout

- `apps/api/` — NestJS, porta **3001**, DB: `prisma/dev.db` (SQLite). Módulos: `expense`, `cash-flow`, `dashboard`, `simulation`, `floor-plan`, `room`, `link-preview`, `price-compare`, `car-info`, `recurring-bill`, `maintenance`, `reminder`, `schedule`.
- `apps/web/` — Next.js, porta **3000**. Rotas dinâmicas em `src/app/projects/[projectId]/...`.
- `packages/domain/` — enums + regras de negócio (`ExpenseTypeLabels`, `ProjectType`, `getExpenseTypesForProject`, `PROJECT_FEATURES`, `hasFeature`). **Barrel-export only**: importar via `@reformaflow/domain`, nunca subpath. Após mudar, rodar `npm run build` em `packages/domain`.
- `packages/config/` — shared TS configs.

## Comandos

```bash
pnpm dev                                       # tudo (Turbo)
./start-api.sh                                 # API estável em background
pnpm --filter @reformaflow/web build           # build web
pnpm --filter @reformaflow/api build           # build api
pnpm --filter @reformaflow/web exec tsc --noEmit  # type-check rápido
```

## Tipos de projeto e features (em `packages/domain/src/config/project-features.ts`)

| Tipo | Módulos |
|---|---|
| REFORMA | dashboard, expenses, receipts, cashFlow, rooms, floorPlans, simulation, priceCompare |
| COMPRA | dashboard, expenses, receipts, cashFlow |
| CASA | dashboard, recurringBills, maintenance, reminders |
| CARRO | dashboard, recurringBills, maintenance, reminders, carInfo |

## Convenções de código

- **Mega-arquivos React (≤ 400 linhas / 20 KB)**. Páginas grandes vão em:
  - `apps/web/src/app/.../<rota>/_components/Foo.tsx` (Private Folders do Next, ignoradas pelo router)
  - `apps/web/src/app/.../<rota>/_types.ts`
- **Helpers de listas/labels de despesas**: `apps/web/src/lib/expense-options.ts` (`TIPO_DESPESA_OPTIONS`, `CATEGORIA_MAO_DE_OBRA_OPTIONS`, `FORMA_PAGAMENTO_OPTIONS`, `tipoLabel`, `formaLabel`, `catMaoLabel`).
- **`useProject` é um hook**: sempre dentro do componente, nunca no topo de módulo (causa "Invalid hook call"). Passe `projectId` como prop a sub-componentes ou chame `useProject` neles.

## Regras de ouro (cicatrizes — não repetir)

1. **NUNCA `prisma migrate reset`, `db push --force-reset`, `rm prisma/dev.db`.** O banco tem dados reais do usuário. Antes de migrações, faça `cp prisma/dev.db prisma/dev.db.bak-$(date +%Y%m%d-%H%M%S)`.
2. **CSS é frágil**: confirme classes Tailwind existentes antes de remover. Não troque utilitárias em massa "para limpar".
3. **`prisma.service.ts` aplica soft-delete via `$use`**: intercepta `delete` → `update` com `deletedAt`. Modelos **sem** `deletedAt` precisam estar em `modelsWithoutSoftDelete`: atualmente `SimulationValue`, `Simulation`, `FloorPlanRoom`, `RoomImage`.
4. **`$transaction` + `$use` são incompatíveis**: `findFirst` dentro de uma transação interativa ignora o middleware. Padrão: retornar o id da transaction, chamar `findById` fora.
5. **Build artifacts em `src/app`**: `nest build` / `tsc` às vezes geram `.js`/`.d.ts`/`.js.map` dentro de `apps/*/src/app`, causando "Duplicate page detected" no Next. Limpar com `find apps/*/src -name 'page.js' -delete` quando necessário.
6. **Gemini 2.5-flash usa thinking tokens** que contam para `maxOutputTokens` → usar **16K** + `responseMimeType: 'application/json'` (sem `responseSchema`). Repair de JSON truncado já existe em `gemini.service.ts`.
7. **Buscapé scraping** para preços BR funciona via `__NEXT_DATA__` script tag, sem API key. Google CSE retorna 403 (API não habilitada no projeto Cloud).
8. **CarInfo é 1:1 com Project**: endpoint usa `PUT` + Prisma `upsert`.
9. **Soft-delete em `FloorPlanRoom` foi removido**: já está em `modelsWithoutSoftDelete`. Em `reanalyze`, use `deleteMany({where})` simples (cascade do FK cuida do resto).
10. **API NestJS morre se o shell que a iniciou fechar**. Use `./start-api.sh` ou shell async detached.
11. **`react-zoom-pan-pinch`** precisa `disabled={drawingMode}` para deixar o mouse desenhar retângulos em plantas baixas.
12. **ServeStaticModule** serve `{cwd}/uploads/` em `/uploads/`. Floor plans: `uploads/floor-plans/`, room images: `uploads/room-images/`.

## Variáveis de ambiente esperadas

`DATABASE_URL`, `GOOGLE_API_KEY` (Gemini), `GOOGLE_SEARCH_ENGINE_ID` (opcional, CSE não habilitado), porta web 3000 / api 3001.

## Diretrizes para agentes (otimização de contexto)

- **Não cole stack traces brutos > 500 chars** — resuma em 5–10 linhas com a mensagem-chave + arquivo + linha.
- **Não releia páginas inteiras**: use `_components/` quando uma página passar de 400 linhas. Faça `edit` cirúrgico em vez de `view` completo.
- **Use `pnpm dev` em shell async** (e prefira sessões separadas para troca de tema grande: dashboard → simulação → compráveis → plantas baixas).
- **Após mudar `packages/domain/src/`**, lembre de `npm run build` em `packages/domain` antes do web ver os exports.
- **Plan mode (Shift+Tab)** para tarefas multi-passo grandes.
