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

- `apps/api/` — NestJS, porta **3001**, DB `prisma/dev.db`. Módulos principais: expense, cash-flow, dashboard, simulation, floor-plan, room, price-compare, car-info, recurring-bill, maintenance, reminder, schedule, receipt, project, tenant. Cockpit PESSOAL/financeiro: monthly-overview, tenant-financial, conciliacao, credit-card, bank-account, budget-allocation, category-budget. Assistente Maria: agent, tts, merchant-classifier. Infra: auth, users, common, prisma, notifications, link-preview, demo.
- `apps/web/` — Next.js, porta **3000**. Rotas dinâmicas em `src/app/projects/[projectId]/...` (cockpit em `.../monthly`).
- `packages/domain/` — enums + regras (`ExpenseTypeLabels`, `ProjectType`, `getExpenseTypesForProject`, `PROJECT_FEATURES`, `hasFeature`). **Barrel only**: importar via `@reformaflow/domain`. Após mudar, `npm run build`.

## Comandos

```bash
npm run dev                                       # tudo (Turbo: web + api)
./start-api.sh                                    # API estável em background (sobrevive ao shell); PORT=3011 ./start-api.sh p/ paralelo
npx turbo run build --filter=@reformaflow/web     # build de um app
cd apps/web && npx tsc --noEmit                   # type-check rápido (idem apps/api, packages/domain)
cd apps/api && npx jest                           # testes API (jest, *.spec.ts)
cd packages/domain && npx vitest run              # testes domínio (vitest, __tests__/*.test.ts)
npm run test:db:prepare                           # (raiz) aplica migrations no prisma/test.db descartável
```

> **Testes nunca tocam o `dev.db`.** Os três runners (jest da API, vitest do domínio e do web) carregam
> `scripts/test-db-env.cjs` como setup file, que sobrescreve `DATABASE_URL` para o `prisma/test.db` **do
> worktree atual** e aborta com erro legível se o alvo for um `dev.db` ou um arquivo fora do worktree.
> Vale de qualquer worktree, sem exportar nada. `npm run dev` não passa por essa trava e continua no `dev.db`.

## Tipos de projeto (em `packages/domain/src/config/project-features.ts` — fonte de verdade)

`PROJECT_FEATURES`/`hasFeature`. Gate de UI/rotas sempre por `hasFeature(tipo, 'x')`, nunca por tipo hard-coded.

| Tipo | Módulos (features) |
|---|---|
| REFORMA | dashboard, expenses, receipts, cashFlow, rooms, floorPlans, simulation, priceCompare |
| COMPRA | dashboard, expenses, receipts, cashFlow |
| CASA | dashboard, recurringBills, maintenance, reminders, **expenses** (avulsas), **financing** |
| CARRO | dashboard, recurringBills, maintenance, reminders, **expenses** (avulsas), **financing**, **vehicleDocuments** |
| PESSOAL | monthlyOverview, dashboard, expenses, receipts, cashFlow, creditCards, bankAccounts |
| PLANTAS | dashboard, maintenance, reminders, plantsAi |

> ⚠️ **Esta tabela é um resumo e envelhece.** Em 2026-07-31 ela estava sem `financing` (CASA/CARRO) e `vehicleDocuments` (CARRO), e foi usada como fonte de verdade num diagnóstico — que saiu errado por isso. **Confirme sempre em `type-modules.ts` / `project-features.ts` antes de concluir que um tipo não tem um módulo.**

> `carInfo` **não** é uma feature de `PROJECT_FEATURES` — é um endpoint/módulo 1:1 com `Project` (`PUT` + upsert), específico de CARRO. CASA e CARRO compartilham quase o mesmo conjunto; CARRO acrescenta `carInfo` e `vehicleDocuments`. Como CASA/CARRO têm `expenses`, suas despesas planejadas podem ser alvo de vínculo/rateio cross-project a partir do PESSOAL.
>
> **`expenses` como FEATURE ≠ `expenses` como ROTA.** Desde 2026-07-31 CASA/CARRO **não têm mais a rota `/expenses` no menu** (removida de `PROJECT_NAV`): a superfície única de despesa avulsa nesses tipos é a aba **Avulsas** dentro de `/bills`, e `/expenses` redireciona para lá. A **feature** continua em `PROJECT_FEATURES` e `TYPE_MODULES` de propósito — tirá-la de lá quebraria o gate do endpoint (`@RequireModule('expenses')`, que a própria aba Avulsas usa), o rateio (`hasFeature` no servidor, `expense.service.ts`) e os quatro seletores de alvo cross-project. Remover do produto = mexer em `PROJECT_NAV`; remover a capacidade = mexer em `PROJECT_FEATURES`. Não confundir.
>
> `TYPE_MODULES` (`packages/domain/src/config/type-modules.ts`) é o mapa de **autorização** compartilhado entre API e contexto de autenticação. `PROJECT_FEATURES` continua sendo o mapa de **capacidade/exposição do produto**. `PROJECT_NAV` (`module-navigator.ts`) é o que de fato **renderiza** a linha do menu. Não trocar um pelo outro.

## Convenções

- **Páginas ≤ 400 linhas / 20 KB** (convenção-alvo; algumas páginas legadas excedem, ex. `floor-plans/page.tsx` — tratar como dívida a quebrar). Quebrar em `<rota>/_components/Foo.tsx` (private folders) + `<rota>/_types.ts` + `<rota>/_hooks/useFoo.ts` + `<rota>/_lib/*.ts`.
- **Labels/options de despesas**: helpers de forma de pagamento e categoria de mão de obra em `apps/web/src/lib/expense-options.ts` (`FORMA_PAGAMENTO_OPTIONS`, `CATEGORIA_MAO_DE_OBRA_OPTIONS`, `tipoLabel`, `formaLabel`, `catMaoLabel`). **Options de tipo de despesa** vêm de `getExpenseOptions(projectType)` em `apps/web/src/app/projects/[projectId]/expenses/_types.ts`.
- **`useProject` é hook**: chamar dentro do componente, nunca no topo do módulo.
- **Mudou comportamento visível de uma tela**: atualizar a seção correspondente de `docs/manual-do-aplicativo.md` no **mesmo PR** (mesma disciplina do `estado-atual`).

## Regras de ouro (cicatrizes — não repetir)

1. **NUNCA** `prisma migrate reset` / `db push --force-reset` / `rm prisma/dev.db` — há dados reais. Backup antes de migration.
2. CSS Tailwind é frágil — confirme classes antes de remover; não faça swaps em massa.
3. `prisma.service.ts` aplica soft-delete via `$use` (delete → update `deletedAt`). Modelos sem `deletedAt` precisam estar em `modelsWithoutSoftDelete` (atualmente: `SimulationValue`, `Simulation`, `FloorPlanRoom`, `RoomImage`, `FloorPlanMarker`, `CarInfo`, `MerchantCategory`, `CrossProjectSettlement`, `RateioAllocation`, `PlantDiagnosisLog`). Modelo novo sem `deletedAt` → atualizar essa lista na mesma mudança.
4. `$transaction` ignora `$use` — em tx, retornar id e chamar `findById` fora.
5. `nest build`/`tsc` às vezes geram `.js`/`.d.ts` dentro de `apps/*/src/app` → "Duplicate page". Limpar: `find apps/*/src -name 'page.js' -delete`.
6. `CarInfo` é 1:1 com `Project` → endpoint usa `PUT` + Prisma `upsert`.
7. Em `FloorPlanRoom.reanalyze`, use `deleteMany({where})` simples — FK cascade cuida do resto (não há soft-delete nesse modelo).
8. **API NestJS morre se o shell que iniciou fechar.** Use `./start-api.sh` ou `bash` async detached. O script (corrigido em 2026-07-29) é seguro para worktree: carrega o `.env` **do próprio diretório dele**, respeita um `DATABASE_URL` já exportado, imprime um resumo (diretório · `.env` · `DATABASE_URL` · porta · log) **antes** de subir, aceita `PORT`/`$1`, grava log por instância (`/tmp/reformaflow-api-<worktree>-<porta>.log`) e **aborta** se a porta estiver ocupada (nunca mata a API de outro agente). Em worktree **sem `.env` próprio** ele reaproveita as chaves do checkout principal mas **ignora o `DATABASE_URL` dele** e aborta pedindo um explícito — foi exatamente assim que em 2026-07-29 uma API de agente abriu o `dev.db` REAL (76 projetos / 2098 despesas / 48 usuários) e gravou 6 jornadas de bootstrap. Em worktree: `export DATABASE_URL="file:$PWD/prisma/dev.db"` ou crie um `.env` local.
9. **EMU bloqueia `gh`/`git push` no repo pessoal.** Solução: `unset GH_TOKEN && gh auth switch -u Gabrieldco1994` antes de operações no GitHub.
10. **NUNCA apagar `apps/web/src/app/prototype/agent-monitor/**` nem `tools/agent-monitor/**`.** É a página de monitoramento de agentes em produção (`/prototype/agent-monitor`, pública no `middleware.ts`), não um protótipo descartável apesar do nome da pasta. Já foi apagada sem querer por um checkpoint automático de sessão — se algum diff/checkout/limpeza remover esses arquivos, restaure antes de commitar.

11. **PR sempre com `--base main`.** O PR #86 foi squash-mergeado numa branch já morta por omitir o `--base` — o código ficou órfão e fora do ar até resgate manual. Após criar, confirme `baseRefName=main` (`gh pr view <n> --json baseRefName`).
12. **Agentes trabalham em worktree próprio** — `git worktree add ../rf-<nome> -b <branch> origin/main` **antes da primeira edição**, não depois. NUNCA editar, commitar, trocar branch ou dar `reset` no checkout principal (`/Users/gabrielbarbosa/reformaflow`): outros agentes o usam simultaneamente e há trabalho não commitado no working tree dele a qualquer momento (aconteceu 2× em 2026-07-13 e de novo em 2026-07-29). O incidente de 2026-07-29 mostra a cadeia inteira: um agente commitou na `main` do checkout principal, depois um `reset` (mixed) para `origin/main` deixou o **índice com o tree antigo** — as adições de um PR já mergeado ficaram staged como **deleção**, e qualquer `git commit` ali reverteria aquele PR em produção. Se você já commitou na `main` por engano, NÃO use `reset --hard` (há trabalho alheio no working tree): `git branch backup/<algo> main && git reset --soft origin/main`, e confira `git diff --cached` antes de qualquer commit.
13. **Mudou UI? QA visual real é obrigatória antes do PR**: login real + dados reais, mobile 375/390px e desktop, screenshots no PR. **O agente NÃO consegue anexar imagem ao PR** — a API do GitHub não expõe upload; o anexo é passo humano. Portanto: salve os screenshots num diretório e **cite o caminho no corpo do PR** (nunca commite PNG no repo — binário versionado é peso permanente; em 2026-07-29 um agente commitou 651 KB de imagem por isso). tsc/testes verdes NÃO bastam (5 bugs só apareceram em QA real). Piso tipográfico: nada <11px, valores de lista ≥15px, alvos de toque ≥44px; **valor monetário nunca divide a largura da linha com outro elemento variável** (badge/chip/outro valor) — rótulo à esquerda, valor `nowrap` à direita (erro corrigido 4× no mesmo mês). **`MovimentacaoRow` é o layout canônico de linha financeira** — novas listas financeiras do app copiam esse padrão (título + metadados separados, valor nowrap, status textual abaixo do valor).

14. **Toda movimentação do PESSOAL sem cartão/conta pertence à pseudo-origem Carteira e DEVE aparecer na Visão Conta e nos totais** (`getAccountView`). Nunca filtrar `origin:'none'` para fora silenciosamente — item invisível = dinheiro sumido no consolidado. Frontend exibe chip "Sem conta" clicável (→ fluxo de vínculo). Docs: `docs/visao-conta-faturas.md §11`.
15. **Fila "Precisa de você" agrega fontes existentes (`GET /projects/:id/pendencias/financeiras`) e não cria mutação nova.** Cada pendência deve apenas rotear para um modal já existente (vincular, pagar fatura, quitar parcela, editar despesa/recebimento). Nova pendência = nova fonte no agregador, não fluxo paralelo.
16. **Regra de categoria (`MerchantCategory`) só muda CATEGORIA, nunca valor/caixa.** Auto-aplicação no ingest só para regra manual confirmada; PIX PF nunca auto-aplica sem regra prévia. Retroativo (se habilitado) deve ser transacional.
17. **Nenhum runner de teste pode enxergar o `dev.db`.** Worktrees não têm `.env` próprio e a API lê `process.env.DATABASE_URL` puro (sem ConfigModule/dotenv) — em 2026-07-28 uma rodada de testes aplicou migration e materializou linhas no banco real, quase levando a um `prisma migrate reset` (proibido pela #1). A trava é `scripts/test-db-env.cjs`, carregado como `setupFiles` do jest (apps/api) e do vitest (packages/domain, apps/web) e por `scripts/prepare-test-db.mjs`. **Runner novo ou script avulso que instancie `PrismaClient` fora do runtime da API tem que carregar essa trava antes do `new PrismaClient()`** (ver os `__tests__/e2e.test.ts` de credit-card e bank-account). Ferramentas que DEVEM mesmo escrever no dev.db (`prisma/seed.ts`, `scripts/*.mjs` de backfill, e2e do Playwright contra a API rodando) ficam de fora — são intencionais e não são a suíte.
18. **`git stash` é PROIBIDO neste repo.** A stash list é do **repositório**, compartilhada entre TODOS os worktrees — um `stash`/`stash pop` alcança trabalho de outra sessão. Em 2026-07-29 um `pop` colidiu com uma entrada antiga de outro agente e um diff foi perdido. Para guardar trabalho temporário use patch nomeado, que é por-worktree: `git diff > /tmp/<descritivo>.patch`, `git checkout -- <arquivo>`, e depois `git apply /tmp/<descritivo>.patch`.

19. **O snapshot de autorização tem DOIS pontos de leitura — corrigir só um é pior que o bug.** `User.allowedModules` é uma **foto tirada no signup** (`deriveObjectiveAccess`); módulo novo em `TYPE_MODULES` **não alcança quem já tem conta**. Em 2026-07-31, 37 de 46 usuários estavam defasados (`recurrences` 36, `pendencias` 19, `financing` 1) e o backfill existente cobria só CARRO por ter a lista de tipos **escrita à mão** (`if (!projectTypes.includes('CARRO')) return []`) — CASA nunca foi coberta. A correção é reconciliar em **tempo de leitura** via `reconcileUserModules` (`packages/domain`), derivando do próprio `TYPE_MODULES`, em **`AuthService.buildPublicUser`** (alimenta o gate do web/menu) **E** em **`JwtStrategy.validate`** (alimenta o `request.user` do `ModulesGuard`). A primeira versão do fix mexeu só no `buildPublicUser`: o login já devolvia o módulo, o menu aparecia, e o endpoint seguia em **403** — só apareceu porque o QA testou o endpoint, não só o login. A lógica de parse é duplicada nos dois arquivos, que é exatamente por que passou despercebido. **União, nunca substituição** (módulo concedido pelo suporte não pode ser revogado por reconciliação automática), e usuário sem `allowedProjectTypes` não é tocado (legado, deriva por `accessibleProjectTypes`).

20. **Checkpoint automático de sessão versiona lixo e ressuscita código velho — `git status` do checkout compartilhado antes de confiar em qualquer leitura.** Em 2026-07-31 um `grep` no checkout principal indicou que `emitProjectCreated` não tinha nenhum chamador, e eu concluí que **nenhuma jornada de onboarding disparava em produção**. Era falso: o arquivo estava **modificado e não commitado** por outro agente, e a alteração dele removia justamente essa chamada. Na `main` real o gatilho sempre funcionou. Leitura de arquivo em checkout sujo não é evidência — confirme contra `origin/main` (`git --no-pager grep <termo> origin/main -- <path>`) antes de afirmar que algo não existe. Os mesmos checkpoints também versionaram 6,7 MB de CSV/XLSX em `data/livelo_ci_csv/` sem nenhum consumidor no app, inflando o PR #366 para +107.521 linhas (o código real eram ~1.500) e tornando-o irrevisável. `.gitignore` ganhou `data/`, `*.xlsx` e `~$*` — havia até um `~$transactions_full.xlsx` (lock temporário do Excel) versionado.

21. **`getBoundingClientRect()` com os QUATRO valores zerados = caixa NÃO GERADA, não elemento escondido.** `visibility:hidden` e `opacity:0` produzem rect **não-zero**; zero em tudo aponta para `display:none` em algum **ancestral**. E `getComputedStyle` no próprio elemento **mente**: devolve `display:flex` mesmo com ancestral em `display:none`. Por isso análise estática do CSS do elemento dá "tudo verde" com o bug ativo — é preciso caminhar a **cadeia de ancestrais** em runtime. Foi assim que o FAB de Despesas ficou invisível em PESSOAL: o `ExpensesView` é renderizado dentro de `hidden lg:block` (só-desktop) e o FAB é `md:hidden` (só-mobile) — botão só-de-celular dentro de container só-de-desktop, **nasceu impossível, não regrediu**. Teste unitário passava (o componente isolado sempre esteve certo); só um teste de **runtime na árvore real** pega isso (ver `e2e/expenses-fab-runtime.spec.ts`).

## Trabalhando com vários agentes em paralelo

Quando a sessão for coordenar mais de um agente, use o agente **`fleet-po`**
(`.claude/agents/fleet-po.md`). Ele carrega a dinâmica que este repo exige:
**verificar no código o que cada agente reporta** antes de repassar (relatos de boa-fé
erram o suficiente para checar sair mais barato), um dono por branch, proteção do
working tree compartilhado, os cinco padrões de bug recorrentes daqui, e o formato de
prompt auto-contido com pontos de parada explícitos para agentes sem contexto.

Ele decide titularidade, ordem de merge e escopo; **não implementa e não mergeia** —
prontidão é dito, o merge é do PO.

## Notas técnicas (consulte quando tocar o módulo)

- **Decisão de produto pendente — `ImportLauncher`**: existe em `wip/import-launcher-preservado` (commit `64363829`), **fora de qualquer PR**. Componente de 205 linhas que seria um botão "Importar" dedicado na tela de Despesas. **Nunca foi renderizado** (só `import`, sem `<ImportLauncher />` no JSX) e a capacidade dele já existe: hoje importa-se fatura/extrato por **"Lançar" → "Foto (print ou foto de fatura/extrato)"** (`ExpensesView.tsx`, `onImportCard`/`onImportAccount`), e o `NovaDespesaLauncher` usa os mesmos dois modais. É **conveniência (um clique a menos), não capacidade** — nada quebrado enquanto não se decide. Opções: descartar / integrar de verdade / manter parado.

- **Status consolidado do Cockpit PESSOAL**: ver `docs/estado-atual-cockpit-pessoal.md` antes de qualquer análise de escopo.
- **Visão Conta / Faturas de cartão**: regra de neutros, agregação de fatura, casamento pagamento→fatura (`matchPaidInvoices`, por valor+janela) e "cartão paga cartão" (`settlesInvoiceKey` + `computePaidInvoiceKeys`) estão documentados em `docs/visao-conta-faturas.md`. Caixa real §10 em `docs/cockpit-caixa-real.md`.
- **Navegação do PESSOAL (PR-4)**: bottom nav mobile mora em `apps/web/src/app/projects/[projectId]/_components/mobile-nav.ts` + `MobileTabBar.tsx` (Cockpit · Conta · [+] · Maria · Cartões). Sidebar desktop mora em `DesktopSidebar.tsx` (grupos Cockpit/Conta/Cartões/Planejamento/Análises). Despesas/Recebimentos são drill-downs da Conta no PESSOAL (links em `conta/_components/MovimentacoesSection.tsx`) e continuam acessíveis no sheet "Mais".
- **Gemini 2.5-flash**: thinking tokens contam para `maxOutputTokens`. Usar `16K` + `responseMimeType:'application/json'` (sem `responseSchema`). Repair de JSON truncado já existe em `gemini.service.ts`.
- **Price compare**: Buscapé via `__NEXT_DATA__` (sem API key). Google CSE retorna 403 (não habilitado).
- **Floor plans**: `react-zoom-pan-pinch` precisa `disabled={drawingMode}` para permitir desenho.
- **Static uploads**: `ServeStaticModule` serve `{cwd}/uploads/` em `/uploads/`. Floor plans em `uploads/floor-plans/`, room images em `uploads/room-images/`.
- **Rateio (ratear compra)**: distribuir 1 compra parcelada do PESSOAL entre N despesas planejadas de outro projeto. Motor em `conciliacao.service.ts` (`ratearSource`/`unratearSource`); as allocations DEVEM somar o `valorTotal` da fonte (senão dinheiro some do consolidado). Fonte vira espelho (`linkedExpenseId=firstTarget`). `RateioAllocation` não tem `deletedAt`. Endpoints `POST/DELETE :id/ratear`. Modal `RatearCompraModal.tsx` (só PESSOAL).
- **Voz/Maria (assistente)**: `valor` nas tools é **string** (parseada por `parseSpokenMoney` em `agent/tools/money-parse.ts`, vírgula=decimal; ×100 só no `expense.create`) — evita o bug 100x. Tool `update_expense` completa data/tipo faltantes. TTS via VibeVoice no Modal (`deploy/modal/`).
- **Cronograma**: tarefas/etapas exibidas em ordem cronológica (data+predecessoras) via `sortScheduleByDate` em `@reformaflow/domain` — aplicado no backend (`getGanttData`) e no front (`recalcAll`), não pela ordem de inserção.

## Variáveis de ambiente

`DATABASE_URL`, `GOOGLE_API_KEY` (Gemini), `GOOGLE_SEARCH_ENGINE_ID` (opcional), `AUTH_ENABLE_REGISTER`, `AUTH_ENABLE_GUEST`, `APP_MODE` e `ALLOW_TENANT_OVERRIDE`. Em produção, mantenha `ALLOW_TENANT_OVERRIDE="0"`. Portas: web 3000, api 3001.
