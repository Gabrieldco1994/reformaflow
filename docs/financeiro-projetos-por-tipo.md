# Financeiro dos projetos por tipo — especificação (U6a)

> **Escopo:** especificar, **por tipo de projeto**, o que o tipo pode fazer com dinheiro
> (capacidade), o que é origem e o que é finalidade, qual é a identidade de cada recurso
> financeiro, quem o alcança (ACL) e o que um deep-link seleciona — inclusive quando não pode.
> Entrega documental da **U6a ([#455](https://github.com/Gabrieldco1994/reformaflow/issues/455))**.
>
> **Natureza: somente spec.** Nenhuma linha de produto ou runtime decorre deste documento.
> **U6b ([#456](https://github.com/Gabrieldco1994/reformaflow/issues/456)) permanece BLOQUEADA**
> até aprovação explícita de architect, lenses e PO. Este documento não escolhe fórmula, store,
> migration, backfill nem serviço — essas decisões continuam livres para o architect de U6b.
>
> **Método:** cada linha foi derivada do **código vivo** em `main` `9da93391`, não da descrição do
> plano. Onde o código e um doc/plano divergem, a divergência está registrada na §6 e escalada —
> nunca silenciada e nunca resolvida por conta própria.
>
> **Não reformula** os contratos normativos existentes:
> [estado do Cockpit PESSOAL](estado-atual-cockpit-pessoal.md),
> [caixa real §10](cockpit-caixa-real.md),
> [Conta e faturas](visao-conta-faturas.md),
> [quitação cross-project](quitacao-parcela-cross-project.md),
> [datas e timezone](politica-datas-timezone.md).
> Em divergência, esses vencem para fórmula e comportamento já entregue.
>
> **Status (2026-08-19):** proposta submetida ao PO. **Não normativo enquanto não aprovado.**
> Nenhuma promessa deste documento pode ser copiada para o manual antes de chegar ao runtime.
> O PO decidiu **A-1** (destino do `/financeiro`), **A-2** (CASA/CARRO seguem em Avulsas) e a
> **dispensa do gate de extinção do B2** — todas registradas na **§7**. **A-3 (invariante O8)
> segue em aberto** na §8 e não pode ser presumida.

---

## CONTRATO PROPOSTO (normativo somente após aprovação do PO)

### 0. As três fontes que não podem ser fundidas

O erro que esta spec existe para impedir é colapsar três mapas distintos num único "check de tipo".
Eles respondem perguntas diferentes e **divergem de verdade** (§1).

| Fonte | Arquivo | Responde | Consumido por |
|---|---|---|---|
| `PROJECT_FEATURES` | `packages/domain/src/config/project-features.ts:25` | O tipo **sabe fazer** isso? (capacidade de produto) | `hasFeature` no web; elegibilidade de alvo cross-project |
| `TYPE_MODULES` | `packages/domain/src/config/type-modules.ts:53` | Quem **alcança** o recurso? (gate de autorização) | `ModulesGuard` na API **e** `auth-context` no web — um mapa só, por design (#98) |
| `PROJECT_NAV` | `packages/domain/src/config/module-navigator.ts:21` | O que é **renderizado** como destino? | sidebar desktop e tab bar / "Mais" mobile |

**Invariante travado por teste:** todo `PROJECT_NAV[tipo].module` pertence a `TYPE_MODULES[tipo]`
(`packages/domain/__tests__/type-modules.test.ts:66-78`). O inverso **não** vale: um módulo pode ser
gated sem ser navegável, e uma capacidade pode existir sem rota.

**Módulo universal:** `dashboard` (`type-modules.ts:37`). Possuir **apenas** ele nunca concede um
tipo de projeto (`userHasAnyModuleForType`, `:110-113`; teste `type-modules.test.ts:86-90`).

**Regra de gate:** nunca comparar `projectType` literalmente para decidir capacidade.
**Exceção aceita e datada:** `resolveDashboardVariant`
(`apps/web/src/app/projects/[projectId]/dashboard/_lib/resolve-variant.ts:13-16,19,24`) mantém
comparação direta para PESSOAL e PLANTAS por não existir `ProjectFeature` correspondente a "é o
dashboard do Cockpit" / "é o dashboard de Plantas". Está registrada como exceção, não como drift;
U6b não deve "consertá-la" sem criar antes a feature que falta.

---

### 1. Matriz — capacidade por tipo

Deltas verificados entre as três fontes. `Δ gate` = está no gate mas não é capacidade.
`Δ nav` = é capacidade (ou gate) sem linha de navegação.

| Tipo | `PROJECT_FEATURES` | `TYPE_MODULES` | `PROJECT_NAV` (slugs) | Δ gate | Δ nav |
|---|---|---|---|---|---|
| **REFORMA** | `expenses`, `receipts`, `cashFlow`, `dashboard`, `rooms`, `floorPlans`, `simulation`, `priceCompare`, `pendencias` | os 9 + `schedule`, `creditCards` | `dashboard`, `expenses`, `receipts`, `cash-flow`, `schedule`, `pendencias`, `floor-plans`, `simulation`, `price-compare` | `schedule`, `creditCards` | `rooms` (capacidade + gate, **zero rota, zero controller**) |
| **COMPRA** | `expenses`, `dashboard`, `priceCompare` | os 3 + `creditCards` | `dashboard`, `expenses`, `price-compare` | `creditCards` | — |
| **CASA** | `dashboard`, `recurringBills`, `maintenance`, `reminders`, `expenses`, `financing` | idênticos | `dashboard`, `bills`, `financing`, `maintenance`, `reminders` | — | `expenses` (**intencional**, #369) |
| **CARRO** | idênticos aos de CASA | os 6 + `carInfo`, `vehicleDocuments` | `dashboard`, `car-info`, `bills`, `vehicle-documents`, `financing`, `maintenance`, `reminders` | `carInfo`, `vehicleDocuments` | `expenses` (**intencional**, #369) |
| **PESSOAL** | `monthlyOverview`, `dashboard`, `expenses`, `receipts`, `cashFlow`, `creditCards`, `bankAccounts`, `recurrences` | os 8 + `pendencias` | 14 linhas (`monthly`, `conta`, `dre`, `neutros`, `expenses`, `receipts`, `recorrentes`, `metas`, `planning`, `planejador`, `budget-allocation`, `cash-flow`, `credit-cards`, `bank-accounts`) | `pendencias` | `pendencias`; `recurrences` (ver §6 D-3) |
| **PLANTAS** | `dashboard`, `maintenance`, `reminders`, `plantsAi` | idênticos | `dashboard` (rotulado **"Cronograma"**), `plants-ai`, `plants`, `maintenance`, `reminders` | — | — |

#### 1.1 CASA/CARRO: `expenses` é capacidade retida, não rota

`expenses` **permanece** em `PROJECT_FEATURES` e em `TYPE_MODULES` de CASA e CARRO. O que saiu foi
apenas a **rota de produto**: `/projects/:id/expenses` redireciona para a aba **Avulsas** de
`/bills`. A condição é derivada, nunca um `type === 'CASA'`:

```ts
// apps/web/src/app/projects/[projectId]/expenses/page.tsx:32
const shouldRedirectToAvulsas = !hasNavRoute(type, 'expenses') && hasNavRoute(type, 'bills');
```

As **duas** condições são necessárias: PLANTAS também não tem `expenses` na nav, mas não tem `bills`
como destino válido — sem a segunda checagem, PLANTAS seria redirecionado para uma rota que não
expõe (`expenses/page.tsx:11-25`). A capacidade é retida porque ela é a âncora de vínculo/rateio
cross-project a partir do PESSOAL e a fonte das despesas de combustível (#289).

> **Qualquer spec que afirme "CASA não tem despesas" está errada.** CASA e CARRO têm despesas
> avulsas com taxonomia própria (`project-features.ts:121-145`), elegíveis como alvo de vínculo.

#### 1.2 PLANTAS: sem financeiro por design

PLANTAS não possui `expenses`, `receipts`, `cashFlow`, `creditCards`, `bankAccounts`,
`recurringBills`, `financing` nem `monthlyOverview` em nenhuma das três fontes, e
`getExpenseTypesForProject(PLANTAS)` retorna **lista vazia** (`project-features.ts:154`). É o único
tipo sem `expenses` no gate.

**Ausência deliberada é resposta de spec, não lacuna.** PLANTAS entra na matriz como
**"sem financeiro por design"**; U6b não deve criar superfície financeira para ele.

---

### 2. Matriz — origem e finalidade

Modelo aprovado (SDD §3): **Conta = origem** (de onde o dinheiro veio ou por onde saiu);
**Projeto = finalidade** (para que serviu). O consolidado autorizado conta cada ocorrência lógica
**uma única vez**.

| Tipo | Papel | Origem | Finalidade | Pode ser alvo de vínculo/rateio do PESSOAL? |
|---|---|---|---|---|
| **REFORMA** | finalidade | própria (cartão/conta do projeto) **ou** PESSOAL, via vínculo/rateio/quitação | obra: material, mão de obra, revestimento, marcenaria… (`project-features.ts:65-71`) | **Sim** (`hasFeature('expenses')`) |
| **COMPRA** | finalidade | idem | aquisição: entrada, financiamento, cartório, imposto, vistoria, mudança (`:73-79`) | **Sim** |
| **CASA** | finalidade | idem | operação do lar, em **duas naturezas**: recorrente (`RecurringBill`) e avulsa (`Expense`), mais `Financing` singleton | **Sim** |
| **CARRO** | finalidade | idem | operação do veículo: combustível, lavagem, estacionamento, IPVA, seguro (`:136-145`), mais `Financing` singleton | **Sim** |
| **PESSOAL** | **origem** (centro financeiro cross-project) | cartão, conta bancária ou **Carteira** | consolidado, DRE, faturas, planejamento | não se aplica (é a fonte) |
| **PLANTAS** | nenhum | — | — | **Não** (único tipo sem `expenses`) |

#### 2.1 Carteira

Movimento do PESSOAL **sem cartão e sem conta** pertence à **Carteira**
(`AGENTS.md:52`; `monthly-overview.service.ts:2284,2335,2775`). Ele **permanece visível** nas visões
de conta e nos totais.

> **Duas verdades em superfícies diferentes — não confundir.** A Carteira é visível dentro do
> PESSOAL, e **nunca é divulgada como origem cross-project**: `classifySource` devolve `null`
> quando não há cartão nem conta (`apps/api/src/expense/paid-origins.builder.ts:145-151`), o que
> corresponde ao invariante **O8** (`quitacao-parcela-cross-project.md:69`). Implementar uma e
> esquecer a outra quebra um contrato entregue. Ver decisão **ainda aberta** **A-3** (§8).

#### 2.2 Origem PESSOAL é read-only no alvo

O alvo exibe a origem, não a edita: a superfície é o contrato read-only
`GET .../expenses/paid-origins` (O1–O12, `quitacao-parcela-cross-project.md` §10). A derivação é
pura, sem Prisma e sem I/O (`paid-origins.builder.ts:15-20`). Nenhuma operação nova pode ser imposta
a todos os tipos por causa dessa exibição.

---

### 3. Matriz — identidade dos recursos

| Tipo | Recurso | Identidade real | Observação |
|---|---|---|---|
| REFORMA | `Expense`, `Receipt`, `CashFlowEntry`, `FloorPlan`, `Simulation`, `Pendencia`, `ScheduleTask` | `id` (cuid) | `Room.id` existe no schema (`prisma/schema.prisma:158`) sem rota nem controller |
| COMPRA | `Expense`, `PriceMonitorItem` | `id` | — |
| CASA | `RecurringBill`, `Expense` (avulsa), `MaintenanceLog`, `Reminder` | `id` | `Financing` é **singleton por projeto** |
| CARRO | os de CASA + `VehicleDocument` | `id` | **`CarInfo` é 1:1 e sua identidade é `projectId`** (`schema.prisma:136`), não um `id` próprio; API `PUT` + `prisma.carInfo.upsert` (`car-info.controller.ts:22`, `car-info.service.ts:16`). **Não é feature flag** — é recurso |
| PESSOAL | `Expense`, `Receipt`, `CreditCard`, `BankAccount`, ocorrência de fatura | `id`; a **fatura** recebe identidade emitida pelo servidor (`cardId`, `fingerprint`, `actions` em `cartoes[]`/`saidas[]`, `accountId` em `contas[]`) — B1a | ver `visao-conta-faturas.md` |
| PLANTAS | `Plant`, `PlantDiagnosisLog`, `MaintenanceLog`, `Reminder` | `id` | sem identidade financeira |

#### 3.1 Identidade do rateio — qual campo é autoritativo

**`RateioAllocation` é autoritativa** para o conjunto de alocações de uma fonte. Tem
`@@unique([targetExpenseId])` **global** (`prisma/schema.prisma:397`): um alvo pertence a no máximo
um rateio no tenant.

**`Expense.linkedExpenseId` reflete apenas o PRIMEIRO alvo** — campo 1:1 legado
(`schema.prisma:245`; `expense.service.ts:828-833`). Toda leitura que precise do conjunto **deve
enumerar `RateioAllocation`**, nunca inferir do `linkedExpenseId`. Isso já é regra em `AGENTS.md:53`.

Invariantes numéricos herdados, que esta spec **não** altera:

- as alocações somam o `valorTotal` da fonte (`AGENTS.md:52`);
- nas visões de conta do PESSOAL a fonte é contada **exatamente uma vez**, sua origem
  (Carteira/conta/cartão) é preservada, e **todo alvo pago é excluído** de `saidas`/`saiuMes`
  (`AGENTS.md:53`; `monthly-overview.service.ts:616-628,695,963`);
- o espelho (`linkedExpenseId` presente) conta no caixa **PESSOAL-only** e é deduplicado do
  consolidado via `isEspelho` (`monthly-overview.service.ts:214,220,240,275`);
- dinheiro em **centavos**, sempre.

#### 3.2 Regras de estabelecimento (merchant) — escopo real

`MerchantCategory` **nunca muta valor nem caixa**; altera apenas categoria (`schema.prisma:1044-1047`).

> **"Tenant-scoped" sozinho é materialmente incompleto.** `tenantId` é **nullable**:
> `null` = **regra GLOBAL**, promovida só por ADMIN (`schema.prisma:1049-1053`, chave
> `@@unique([tenantId, merchantKey])` em `:1062`). O lookup tenta o tenant primeiro e **só então**
> cai no global, e nunca cruza para outro tenant
> (`apps/api/src/merchant-classifier/merchant-classifier.service.ts:107-116`; mesma precedência em
> lote, `:157-166`). Uma spec que diga apenas "tenant-scoped" descreve metade do comportamento.

---

### 4. Matriz — ACL (quem alcança)

A autorização é composta por camadas. Nenhuma delas sozinha é a resposta.

| Camada | Onde | O que decide |
|---|---|---|
| Snapshot de grants | `User.allowedModules` / `allowedProjects` / `allowedProjectTypes` | foto tirada no signup por `deriveObjectiveAccess` (`onboarding-objectives.ts:19-30`), derivada **só** de `TYPE_MODULES` |
| Parser fail-closed | `apps/api/src/auth/grant-json.ts:23-46` | JSON corrompido/`null`/não-array **invalida a sessão (401)**; só `[]` literal é o coringa "sem restrição" |
| Reconciliação | `reconcileUserModules` (`reconcile-user-modules.ts:33-44`) | **união, nunca revogação**; roda em **dois** pontos — `AuthService.buildPublicUser` (`auth.service.ts:433`) e `JwtStrategy.validate`. Corrigir só um faz o menu aparecer e a API responder 403 |
| Gate por módulo/tipo | `ModulesGuard` (`modules.guard.ts:36-75`) | possui o módulo **E** o projeto é do tenant (`findFirst` id+tenantId, `:52-56`) **E** o tipo é acessível **E** `projectTypeHasModule(tipo, módulo)` |
| Gate por projeto | `ProjectAccessGuard` (`project-access.guard.ts:60-83`) | opt-in: `allowedProjects` vazio = sem restrição; colhe `projectId`/`sourceProjectId`/`targetProjectId` de params, query e body (`:15`) |
| Gate por recurso | `userCanAccessProjectModule` (`access-rules.ts:90-102`) | fail-closed em três condições E — impede que um módulo **não relacionado** do mesmo tipo libere o recurso (#480 SEC-1) |
| Escopo de agregação | `resolveAccessibleProjectScope` (`access-rules.ts:155-185`) | resolve IDs; com `requiredModule` devolve `[]` **antes** de qualquer leitura quando o módulo falta |

**Bypass por papel:** ADMIN e OWNER atravessam os gates de módulo, tipo e projeto — na API
(`isFullAccessRole`, `access-rules.ts:69-71`; `ModulesGuard` pula a checagem de módulo em
`modules.guard.ts:36-48`) e no web
(`auth-context.tsx:152,164`: `hasModule: (slug) => isAdmin || allowed.has(slug)`).

> **`@Roles('ADMIN')` não é um gate administrativo em lugar nenhum do app** —
> [#497](https://github.com/Gabrieldco1994/reformaflow/issues/497).
> O convidado de demonstração é criado com **`role: 'ADMIN'`**
> (`apps/api/src/auth/auth.service.ts:324-327`) e o `RolesGuard` **nunca lê `isGuest`** —
> devolve `true` já em `isFullAccessRole(user.role)` (`roles.guard.ts:25`). Logo o convidado
> atravessa `@Roles('ADMIN')`, o `ModulesGuard` e o `hasModule` do web.
> **Esta spec não pode usar "admin-only" como fronteira de segurança**, e U6b tampouco.
> A fronteira que continua valendo é a de **tenant**, que independe de papel: o `ModulesGuard`
> resolve o projeto por `findFirst({ id, tenantId })` (`:52-56`), de modo que o convidado alcança
> superfícies administrativas **apenas sobre o próprio tenant efêmero** — é um problema de
> alcance de superfície, não de vazamento entre tenants. O repositório já conhece a armadilha em
> um ponto isolado, onde checa `isGuest` à mão antes do papel (`auth.service.ts:225-232`); é
> defesa ad hoc por rota, não sistêmica.

**Branch legado:** quando `allowedProjectTypes` está **vazio**, os tipos acessíveis são derivados dos
módulos possuídos (`accessibleProjectTypes`, `access-rules.ts:57-64`). Contas antigas ainda caem
nesse caminho.

| Tipo | Alcança quem possui (não-admin) | Nota |
|---|---|---|
| REFORMA | qualquer módulo não-universal de `TYPE_MODULES[REFORMA]` | `creditCards` concede alcance sem superfície (§6 D-4, #495) |
| COMPRA | idem COMPRA | idem |
| CASA / CARRO | idem | `expenses` alcança a API mesmo sem rota de nav (#369) |
| PESSOAL | idem | `pendencias` concede alcance sem superfície |
| PLANTAS | `plantsAi`, `maintenance` ou `reminders` | sem recurso financeiro a alcançar |
| **cross-project `/tenant/financial/*`** | `financialDashboard` — **que nenhum usuário possui** | alcançável só por ADMIN/OWNER reais e por **convidado de demo** (#497); ver §6 D-2 e §7.1 |

---

### 5. Deep-link e fallback

#### 5.1 Regra herdada de U3 — não pode ser contrariada

**Um deep-link só pode selecionar item já retornado por uma resposta scoped**
(SDD [`plano-centro-financeiro-sdd.md`](plano-centro-financeiro-sdd.md) § E3, entrada U3 #452, `:279-280`). Deep-link **não amplia escopo**: ele seleciona
dentro do que a ACL já devolveu. Nenhuma superfície por tipo pode transformar um identificador de
URL em critério de busca fora do escopo do solicitante.

#### 5.2 O que acontece hoje

O shell do projeto deriva o slug do pathname e o procura na navegação **do tipo**:

```ts
// apps/web/src/app/projects/[projectId]/_components/AppShell.tsx:110-114
const slug = pathname.replace(basePath + '/', '').split('/')[0];
const current = navItems.find((n) => n.slug === slug);
if (current && !hasModule(current.module as ModuleSlug)) {
  router.replace('/no-permission');
}
```

Comportamento efetivo, verificado:

1. **Slug na nav do tipo + módulo ausente** → `/no-permission`.
2. **Slug na nav do tipo + módulo presente** → renderiza.
3. **Slug fora da nav do tipo** → `current` é `undefined` → **nenhum redirect do shell**; a página é
   renderizada e passa a ser a única responsável pelo próprio fallback.
4. Antes disso, tipo inacessível ou projeto fora de `allowedProjects` → `/no-permission`
   (`AppShell.tsx:97-104`).

O caso 3 é a razão de `/expenses` precisar de redirect próprio em CASA/CARRO (#369, §1.1): o shell
não o cobre.

**Detalhe que importa para deep-link: slug ≠ label.** Em PLANTAS a linha de slug `dashboard` é
rotulada **"Cronograma"** (`module-navigator.ts:73`). Deep-link casa por **slug**; qualquer
resolução por rótulo quebra nesse tipo.

#### 5.3 Fallback — decisão deixada ao architect de U6b

Esta spec **registra as opções e não escolhe**. As três candidatas, com a consequência de cada uma:

| Opção | Consequência |
|---|---|
| **404** | Não revela existência do recurso — melhor postura de disclosure; pior orientação para o usuário legítimo que perdeu o módulo. |
| **`/no-permission`** | Consistente com o comportamento atual dos casos 1 e 4; **revela que o recurso existe** e que falta permissão. |
| **Home do tipo** | Melhor continuidade de navegação; mascara o erro e dificulta diagnóstico, além de divergir dos casos 1 e 4. |

Restrições que a escolha **deve** respeitar, quaisquer que sejam: a regra de U3 (§5.1); o precedente
`/expenses` (#369), que resolve por `hasNavRoute` derivado e nunca por tipo literal; e o casamento
por slug (§5.2).

---

## Referência de implementação

| Assunto | Arquivo:linha |
|---|---|
| Capacidade de produto | `packages/domain/src/config/project-features.ts:25,56,147` |
| Gate de autorização | `packages/domain/src/config/type-modules.ts:37,53,98,110` |
| Navegação renderizada | `packages/domain/src/config/module-navigator.ts:21,85,97` |
| Invariante nav ⊆ gate | `packages/domain/__tests__/type-modules.test.ts:66-78` |
| Redirect `/expenses` (#369) | `apps/web/src/app/projects/[projectId]/expenses/page.tsx:11-42` |
| Guarda de deep-link | `apps/web/src/app/projects/[projectId]/_components/AppShell.tsx:95-115` |
| Gate por módulo/tipo | `apps/api/src/common/guards/modules.guard.ts:24-78` |
| Gate por projeto | `apps/api/src/common/guards/project-access.guard.ts:44-85` |
| Predicados de ACL | `apps/api/src/common/access-rules.ts:37-185` |
| Reconciliação (união, 2 pontos) | `packages/domain/src/config/reconcile-user-modules.ts:33-44`; `apps/api/src/auth/auth.service.ts:425-436` |
| Parser fail-closed de grants | `apps/api/src/auth/grant-json.ts:23-46` |
| Origem read-only no alvo (O1–O12) | `apps/api/src/expense/paid-origins.builder.ts:15-37,145-151`; `canSeeOrigin` `:153-165` |
| Espelho / dedupe consolidado | `apps/api/src/monthly-overview/monthly-overview.service.ts:214,220,240,275` |
| Carteira | `apps/api/src/monthly-overview/monthly-overview.service.ts:2284,2335,2775` |
| Rateio (conjunto autoritativo) | `prisma/schema.prisma:373-401`; `apps/api/src/expense/expense.service.ts:828-841` |
| Regras de merchant | `prisma/schema.prisma:1043-1066`; `apps/api/src/merchant-classifier/merchant-classifier.service.ts:107-116` |
| `carInfo` (1:1, PUT+upsert) | `apps/api/src/car-info/car-info.controller.ts:22`; `car-info.service.ts:9-25` |
| Variante de dashboard (exceção aceita) | `apps/web/src/app/projects/[projectId]/dashboard/_lib/resolve-variant.ts:13-26` |

---

## 6. Divergências entre código, docs e plano

Registradas como achado, não corrigidas por esta spec. **A divergência é a entrega mais valiosa da
U6a**: sem ela, U6b implementaria a crença em vez da realidade.

**D-1 — Status do programa estava estagnado.** Corrigido neste PR em
`plano-centro-financeiro-sdd.md` e `docs/README.md`: B0 (#447) **CLOSED**; **B1a mergeado** em `main`
(`5bbe5d69` #477, `720ff1fc` #478, `890b89b0` #479); **#448 segue OPEN** (B1b); **W1 (#214) OPEN**;
**B2 (#449) não iniciado**. Também mergeados e fechados em 2026-08-19: #480, #481, #483, #484, #486.
O **gate de extinção do B2 foi dispensado por evidência** pelo PO em 2026-08-19 — ver §7.3.

**D-2 — A superfície `/financeiro` está morta para todo usuário comum.** → **[#494](https://github.com/Gabrieldco1994/reformaflow/issues/494)**
`financialDashboard` **não é um slug de `TYPE_MODULES`** — tem **0 ocorrências** no mapa — e
**0 dos 48 usuários do snapshot de produção o possuem**
(`SELECT COUNT(*) FROM users WHERE allowed_modules LIKE '%financialDashboard%'` → **0**, verificado
pelo PO em 2026-08-19). **Nenhum usuário de autocadastro pode recebê-lo**: `deriveObjectiveAccess` deriva `allowedModules`
**exclusivamente** de `TYPE_MODULES` (`onboarding-objectives.ts:19-30`) e `reconcileUserModules` só
adiciona slugs desse mesmo mapa. A única via seria concessão manual de admin
(`apps/api/src/users/dto/create-user.dto.ts:34`). Estão portanto inalcançáveis para usuário comum:
a rota `apps/web/src/app/financeiro/` (gate em `layout.tsx:18,23`), o card "Saúde financeira
consolidada" (`apps/web/src/app/projects/page.tsx:209`), os links "← Visão Geral" desktop e mobile
(`apps/web/src/app/projects/[projectId]/dashboard/page.tsx:617,634`) e toda a API
`GET /tenant/financial/*` (`tenant-financial.controller.ts:25`).
**Precisão — quem ainda alcança:** ADMIN/OWNER reais, por bypass de papel (§4); e, por força de
[#497](https://github.com/Gabrieldco1994/reformaflow/issues/497), **todo convidado de
demonstração**, que é criado com `role: 'ADMIN'` (`auth.service.ts:324-327`) e portanto satisfaz
`hasModule('financialDashboard')` em `auth-context.tsx:164`. O resultado é o pior dos dois mundos:
a superfície é invisível para **todo usuário pagante** e visível para a classe **menos confiável**
do produto. É uma superfície inteira já morta para a base real — não uma lacuna desta spec.

**D-3 — Slugs concedidos e não aplicados.** `recurrences` e `rooms` estão em `TYPE_MODULES` (logo são
concedidos no signup e reconciliados para todos) mas **nenhum controller os exige**:
`@RequireModule('recurrences')` e `@RequireModule('rooms')` têm **zero** ocorrências na API. Na
prática `projects/:projectId/recurrences` é gated por **`expenses`**
(`apps/api/src/recurrence/recurrence.controller.ts:26-27`) — decisão
consciente, explicada em `module-navigator.ts:45-47` (a permissão é foto do signup; quem já tinha
conta não teria `recurrences` e a linha sumiria do menu). O CRUD de `Room` vive sob **`floorPlans`**
(`apps/api/src/floor-plan/floor-plan.controller.ts:81-108`).
**Registrado como granted-but-unenforced. Revogação NÃO é proposta aqui:** `reconcileUserModules` é
união e nunca revoga, então tirar um slug do mapa não o retira de quem já o tem, e não há rollback
automático. A questão vai para follow-up, fora desta spec.

**D-4 — `creditCards` gated em REFORMA/COMPRA sem superfície.** → **[#495](https://github.com/Gabrieldco1994/reformaflow/issues/495)**
Está em `type-modules.ts:64,67`, ausente das features e da nav. **Não é inerte:** `canSeeOrigin`
exige `projectTypeHasModule(sourceProjectType, 'creditCards')`
(`paid-origins.builder.ts:153-165`), então a concessão sustenta a "Origem do pagamento na REFORMA"
(#424, `estado-atual-cockpit-pessoal.md:127-131`). Removê-la quebraria contrato entregue.

**D-5 — Capacidade e gate têm vocabulários diferentes, por design.** `schedule`, `carInfo`,
`vehicleDocuments` e `financialDashboard` **não são `ProjectFeature`**. `carInfo` é recurso 1:1
(§3), não flag. Fundir os vocabulários quebraria os dois lados.

**D-6 — `pendencias` gated para PESSOAL** (`type-modules.ts:76`) sem feature e sem linha de nav:
API alcançável, produto inexistente.

**D-7 — Exceção aceita ao "nunca hard-code o tipo"** em `resolve-variant.ts:13-16,19,24` (§0).
Registrada como aceita, com motivo, não como drift.

**D-8 — Deep-link é guardado só para slugs conhecidos da nav** (§5.2). Rotas fora da nav do tipo caem
na página sem redirect do shell.

**D-9 — `CarInfoService` ignora o `tenantId` que recebe.** → **[#498](https://github.com/Gabrieldco1994/reformaflow/issues/498)**
`findUnique({ where: { projectId } })` e `upsert({ where: { projectId } })`
(`car-info.service.ts:10-12,16-24`) não filtram por tenant; a segurança depende inteiramente dos
guards (`modules.guard.ts:52-56`, `project-access.guard.ts:64-70`). **Não explorável pela rota HTTP
hoje** — é dívida de defesa em profundidade, agravada por ser um `upsert` (escreve, não só lê).

**D-10 — Carteira tem duas verdades em superfícies diferentes** (§2.1). Visível dentro do PESSOAL,
nunca divulgada como origem cross-project (O8). Nenhum doc as coloca lado a lado — é o item com
maior risco de U6b implementar uma e quebrar a outra.

**D-11 — "Regras de merchant são tenant-scoped" é incompleto** (§3.2): `tenantId` nullable, `null` =
regra global de ADMIN, lookup tenant-first com fallback global.

**D-12 — ACL tem branch legado e falha fechada** (§4): `allowedProjectTypes` vazio deriva tipos dos
módulos; grant JSON corrompido invalida a sessão.

**D-13 — Autoridade da identidade do rateio** (§3.1): `RateioAllocation` é autoritativa;
`linkedExpenseId` é só o primeiro alvo. O plano fala em "ocorrência única" sem dizer qual campo
manda; esta spec diz.

**D-14 — Estagnação residual não tocada.** `docs/visao-conta-faturas.md:13-17` ainda descreve B1a
como "esta PR, pendente de merge". É doc normativo de contrato e não estava no escopo autorizado
deste PR; fica registrado para o D0 (#458) corrigir.

---

## 7. Decisões do PO — registradas como decididas (2026-08-19)

As decisões abaixo foram tomadas pelo PO em 2026-08-19 e **deixam de ser questões abertas**. Ficam
registradas com a razão, porque em seis meses ninguém lembrará por que foram assim.

### 7.1 A-1 — `/financeiro`: aproveitar o reaproveitável, aposentar o resto — **DECIDIDA**

Contexto: §6 D-2 / [#494](https://github.com/Gabrieldco1994/reformaflow/issues/494).

**Decisão:** analisar o que da superfície `/financeiro` é reaproveitável, **aposentar o restante**, e
executar a aposentadoria. A opção "reviver o slug" foi **descartada** — colocá-lo em `TYPE_MODULES`
ampliaria acesso para a base existente via `deriveObjectiveAccess` + reconciliação, e a superfície
não vale essa ampliação. A opção "manter admin-only" foi **descartada** porque, por
[#497](https://github.com/Gabrieldco1994/reformaflow/issues/497), "admin-only" não é uma fronteira
real: o convidado de demonstração também a alcança.

> **A execução da aposentadoria não pertence a esta spec nem à U6b.** Está delegada a um agente
> próprio. O que a U6a entrega é a lista abaixo, que é a **entrada** desse trabalho.

#### Lista absorver / aposentar

Seis capacidades, uma linha cada. O critério é único: **existe outra superfície que já é a fonte
daquela verdade?** Se existe, é duplicação — e duplicar verdade financeira é pior que não tê-la,
porque cria uma segunda fórmula que diverge em silêncio.

| Capacidade (`/tenant/financial/*`) | Decisão | Razão |
|---|---|---|
| `overview` — KPIs consolidados | **APOSENTAR** | duplicada **duas vezes**: por projeto em `projects/:projectId/dashboard` e cross-project no cockpit PESSOAL (`monthly-overview`, cuja rota é literalmente "Visão consolidada **cross-project**"). Mantém uma **segunda fórmula de caixa** fora do motor canônico |
| `cash-flow` — série mensal consolidada | **APOSENTAR** | mesma duplicação: `saldoAcumuladoMensal`/`despesasMensal` já existem por projeto (`dashboard.service.ts:147-166`) e o mês a mês consolidado é do PESSOAL (`account-view-yearly`, `dre-overview`) |
| `by-category` — distribuição por tipo de despesa | **APOSENTAR** | o dashboard por projeto já devolve o corte por categoria; o corte consolidado é do DRE do PESSOAL |
| `by-project` — breakdown por projeto | **ABSORVER (reformulada)** | como tabela cross-project duplica a lista de projetos. O que vale é o **agrupamento por tipo** — que é exatamente o assunto desta spec. Não copiar o contrato atual: seu union `ProjectType` (`_types.ts:1`) tem **5 tipos e omite PLANTAS**; U6b deve derivar de `PROJECT_FEATURES`/`TYPE_MODULES` |
| `upcoming` — próximos vencimentos | **ABSORVER** | **não é duplicada.** `pendencias` é outro conceito (módulo por projeto, `projects/:projectId/pendencias`), não agregação de vencimentos |
| `top-suppliers` — fornecedores agregados | **ABSORVER** | **sem equivalente em lugar nenhum** — é a única agregação por `fornecedor` do backend. Aposentar isto perderia capacidade de verdade |

**Duas advertências para quem executar a aposentadoria:**

1. **Não apagar `resolveAccessibleProjectScope`.** O controller o usa
   (`tenant-financial.controller.ts:34-48`), mas ele é consumido por **outros 10 arquivos**
   (expense, agent, credit-card, bank-account, monthly-overview, notifications…). É a máquina de
   escopo do app, não da superfície.
2. **Remover também os pontos de entrada**, ou sobram links mortos: `projects/page.tsx:209`,
   `dashboard/page.tsx:617,634`, a entrada de nav e o slug em `auth-context.tsx:34,57`.

### 7.2 A-2 — CASA/CARRO seguem em Avulsas, por ora — **DECIDIDA**

Contexto: §1.1, #369.

**Decisão:** CASA e CARRO **mantêm o formato atual** — `/expenses` redireciona para a aba Avulsas de
`/bills`. **Não haverá visão financeira de primeira classe por tipo para eles na U6b.**

Isto é uma **escolha deliberada e revisitável** — não uma limitação do produto e não uma lacuna
desta spec. A superfície única de despesas entregue em #369 continua sendo a resposta certa
enquanto CASA/CARRO não tiverem volume que justifique um corte próprio.

**A mecânica precisa ser preservada exatamente como está** (é o ponto mais fácil de "simplificar"
errado numa próxima leitura):

- O redirect é guardado pela **condição dupla derivada**
  `!hasNavRoute(type,'expenses') && hasNavRoute(type,'bills')` (`expenses/page.tsx:32`) —
  **nunca** por `type === 'CASA'`. A segunda condição existe para que PLANTAS, que não expõe
  `bills`, não seja redirecionada para uma rota que não tem.
- A capacidade `expenses` **permanece intencionalmente concedida** a CASA e CARRO em
  `TYPE_MODULES`. Ela é o que dá alcance à API; só a **rota de navegação** é que não existe.

> **Não escrever, em doc ou código, que "CASA não tem expenses".** É falso: CASA tem a capacidade e
> tem a API. O que CASA não tem é a **entrada de menu**. Confundir as duas coisas quebraria o gate.

**O que precisaria ser verdade para revisitar:** (a) CASA/CARRO passarem a ter volume de lançamentos
que torne a aba Avulsas insuficiente para separar o que é do imóvel/veículo; (b) surgir demanda por
um recorte financeiro **específico do tipo** que Avulsas não expresse — p.ex. custo por veículo
frente a `carInfo`; ou (c) a U6b provar que a visão por tipo dos demais tipos é reaproveitável para
estes sem reabrir `expenses` como rota. Enquanto nenhuma dessas for verdade, a decisão se mantém.

### 7.3 B2 — o gate de extinção foi dispensado por evidência — **DECIDIDA**

**Decisão:** o gate de extinção do **B2 (#449)** está **dispensado**. O B2 vai **direto para o
congelamento read-only** do Budget Allocation.

**A evidência, registrada aqui porque em seis meses ninguém lembrará por que o gate foi pulado** —
consulta ao snapshot de produção pelo PO em 2026-08-19:

| Tabela / recorte | Linhas |
|---|---|
| `budget_allocations` | **0** |
| `cash_flow_entries` com `categoria = 'ALOCACAO_ORCAMENTO'` | **0** |
| `category_budgets` | **0** |

**Budget Allocation nunca foi usado.** O gate existia para proteger dados reais de uma extinção
apressada; não há dado real a proteger. A dispensa é sobre o **gate**, não sobre o cuidado: o
congelamento read-only continua sendo o caminho, e continua sendo trabalho do B2 — não desta spec.

---

## 8. Decisão ainda aberta — exige o PO

> Esta seção não foi respondida na rodada de 2026-08-19. Ela **não pode ser presumida** por U6b.

### A-3 — O invariante O8 (Carteira nunca é origem divulgada) vale dentro da nova superfície?

Contexto: §2.1, §6 D-10, `quitacao-parcela-cross-project.md:69`.

| Opção | Consequência |
|---|---|
| **Manter O8** | mantém a intenção de privacidade do contrato entregue; a nova superfície exibirá alvos cujo pagador aparece como "não divulgado" |
| **Relaxar dentro do tipo** | melhora a explicação de "para onde foi"; **muda um invariante de disclosure já entregue** e exige revisão security explícita, com o risco de expor movimento pessoal em projeto compartilhado |

**Por que ainda importa:** O8 é hoje um `return null` explícito em `classifySource`
(`paid-origins.builder.ts:145-151`). Qualquer superfície nova que mostre origem cross-project ou
respeita esse `null` ou o contradiz — não há terceira via, e a escolha não é técnica.

---

## Apêndice histórico

- **2026-08-19 — U6a (#455).** Documento criado. Matriz derivada do código vivo em `main`
  `9da93391`, não da descrição do plano. Achados D-2 e D-4 extraídos para os issues #494 e #495 por
  serem achados de autorização, não de UX; D-9 já estava registrado em #498. D-3, D-7, D-11, D-12
  e D-13 registrados como leitura fiel de comportamento aceito; PLANTAS documentado como "sem
  financeiro por design"; fallback de deep-link deixado explicitamente ao architect de U6b. Três
  decisões (A-1, A-2, A-3) escaladas ao PO com opções e consequências, sem escolha prévia.
- **2026-08-19 (mesma data, após a escalada) — decisões do PO.** **A-1** decidida (aproveitar o
  reaproveitável do `/financeiro` e aposentar o resto, com a lista absorver/aposentar da §7.1),
  **A-2** decidida (CASA/CARRO seguem em Avulsas, escolha deliberada e revisitável) e **gate de
  extinção do B2 dispensado** por evidência de uso zero. **A-3 permanece aberta.** Incorporado
  #497: `@Roles('ADMIN')` não é gate administrativo, o que altera a leitura de ACL da §4.
- **Precedentes citados:** #98 (mapa único de gate, cliente e servidor), #289 (combustível),
  #291 (dieta de COMPRA), #369 (superfície única de despesas em CASA/CARRO), #424 (origem do
  pagamento na REFORMA), #423/#428 (leitura canônica de rateio), #480/#484 (escopo prometido ×
  escopo aplicado), #447/B0 e #448/B1a (identidades e child ACL).
