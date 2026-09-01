# Financeiro dos projetos por tipo — especificação (U6a)

> **Escopo:** especificar, **por tipo de projeto**, o que o tipo pode fazer com dinheiro
> (capacidade), o que é origem e o que é finalidade, qual é a identidade de cada recurso
> financeiro, quem o alcança (ACL) e o que um deep-link seleciona — inclusive quando não pode.
> Entrega documental da **U6a ([#455](https://github.com/Gabrieldco1994/reformaflow/issues/455))**.
>
> **Natureza: somente spec.** Nenhuma linha de produto ou runtime decorre deste documento.
> **U6b ([#456](https://github.com/Gabrieldco1994/reformaflow/issues/456)) NÃO foi implementada.**
> A **build 1** é a lente `by-type` — agrupamento por `project.type` **frontend-only, read-only,
> dentro de `/conta`**, sem endpoint, query ou mutation novos. Estado: **design fechado**
> (architect + 8 lentes + security PASS), **RED spec definido**, **aguardando autorização de
> implementação do PO**; nada em produção. Os endpoints `upcoming` e `top-suppliers` **não fazem
> parte da build 1** — são follow-up aprovado e rastreado em
> [#635](https://github.com/Gabrieldco1994/reformaflow/issues/635), backend não autorizado nesta
> rodada. Continua sendo **zero fórmula, store, migration ou backfill**.
>
> **Método:** cada linha foi derivada do **código vivo** em `main` (`9da93391` na redação original;
> **matriz re-ratificada pelo architect (v2) contra `1da83286`** em 2026-08-31, conteúdo dos mapas
> de capacidade inalterado onde verificado). Onde o código e um doc/plano divergem, a divergência
> está registrada na §6 e escalada — nunca silenciada e nunca resolvida por conta própria.
>
> **Não reformula** os contratos normativos existentes:
> [estado do Cockpit PESSOAL](estado-atual-cockpit-pessoal.md),
> [caixa real §10](cockpit-caixa-real.md),
> [Conta e faturas](visao-conta-faturas.md),
> [quitação cross-project](quitacao-parcela-cross-project.md),
> [datas e timezone](politica-datas-timezone.md).
> Em divergência, esses vencem para fórmula e comportamento já entregue.
>
> **Status (2026-08-31):** spec **mergeada** (#506); **A-1/A-2/A-3 decididas** em 2026-08-19
> (destino do `/financeiro`; CASA/CARRO seguem em Avulsas; o invariante O8 vale e U6b não o
> renegocia), além da **dispensa do gate do B2** — todas registradas na **§7**. A **matriz foi
> re-ratificada contra `1da83286`**. A **U6b build 1** (lente `by-type`, frontend-only, read-only
> em `/conta`) tem **design fechado** (architect + 8 lentes + security PASS) e **RED spec
> definido**, mas **aguarda autorização de implementação do PO** — nada em produção. Os endpoints
> `upcoming`/`top-suppliers` são follow-up aprovado (#635), fora desta rodada. Nenhuma promessa
> deste documento chega ao manual antes do runtime.
>
> **Nota (B4 — `$use`/transação):** transaction clients não podem depender do `$use` para
> segurança de tenant/soft-delete. `$use` roda dentro de `$transaction`, mas o middleware atual só
> intercepta findMany/findFirst/delete/deleteMany; findUnique nunca é interceptado. Toda query
> transacional futura aplica tenantId, deletedAt e ACL explicitamente e ganha teste próprio.
> U6b/by-type não cria transação, query nem mutation, portanto B4 é N/A para o PR frontend e
> permanece guardrail do follow-up backend (#635).

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
| **PESSOAL** | `monthlyOverview`, `dashboard`, `expenses`, `receipts`, `cashFlow`, `creditCards`, `bankAccounts`, `recurrences` | os 8 + `pendencias` | **9 linhas** (`monthly`, `conta`, `dre`, `neutros`, `recorrentes`, `metas`, `planning`, `planejador`, `cash-flow`) | `pendencias` | `pendencias`; `recurrences`, `receipts`, `creditCards`, `bankAccounts` (capacidade/gate sem linha de nav — ver §1.3 e §6 D-3) |
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

#### 1.3 PESSOAL: nav colapsada de 13 → 9, com redirect que preserva query

`PROJECT_NAV[PESSOAL]` tinha 13 linhas na redação original; hoje tem **9**. Saíram as cinco rotas
financeiras de drill-down — `expenses`, `receipts`, `credit-cards`, `bank-accounts` (U4 #528, "nav
13→9") e `budget-allocation` (B2 #500, §7.3) — e **cada uma redireciona para `/conta`** preservando
`?mes`, query e deep-link (#528, #633). As **features** `receipts`, `creditCards`, `bankAccounts` e
o slug `recurrences` **permanecem** em `PROJECT_FEATURES`/`TYPE_MODULES`: continuam alcançáveis por
API e por deep-link para `/conta`; o que sumiu é só a **linha de menu**. Despesas/Recebimentos são
drill-downs da Conta (`conta/_components/MovimentacoesSection.tsx`) e seguem no sheet "Mais".

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
> esquecer a outra quebra um contrato entregue. Ver **A-3**, decidida (§7.4): **O8 vale**.

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
> [#497](https://github.com/Gabrieldco1994/reformaflow/issues/497). A fronteira real é sempre
> **tenant**, nunca papel.
> **Correção (#518/#505, mergeados):** o convidado de demonstração **não é mais `role: 'ADMIN'`**.
> `AuthService` cunha o convidado com `role: SELF_SERVICE_ROLE` (`'USER'`) + `isGuest: true` +
> `allowedModules` de `deriveObjectiveAccess(GUEST_PROJECT_TYPES)` (âncora simbólica
> `registerGuest` em `auth.service.ts`). Portanto `isFullAccessRole(convidado)` = **false** e toda
> frase antiga do tipo "o convidado atravessa `@Roles('ADMIN')` / `hasModule('financialDashboard')`"
> está **obsoleta**: `/financeiro` está morto para **100 % da base, convidados inclusive**.
> **Esta spec não pode usar "admin-only" como fronteira de segurança**, e U6b tampouco.
> A fronteira que continua valendo é a de **tenant**, que independe de papel: o `ModulesGuard`
> resolve o projeto por `findFirst({ id, tenantId })` (`:52-56`). Um ADMIN/OWNER **real** ainda
> atravessa os gates de módulo, mas apenas sobre o próprio tenant — alcance de superfície, não
> vazamento entre tenants.

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
| **cross-project `/tenant/financial/*`** | **ninguém** — rota web e controller HTTP não existem mais (#501/`ce27736b`) | superfície **morta por execução**: `apps/web/src/app/financeiro/` removido, `tenant-financial.controller.ts` deletado (0 rota HTTP), `financialDashboard` fora do `ModuleSlug`. `TenantFinancialService` sobrevive como provider interno (Maria). A reexposição de `getUpcoming`/`getTopSuppliers` sob gate `monthlyOverview` é follow-up aprovado e não entregue (#635), fora da U6b build 1. Ver §6 D-2 (resolvido) e §7.1 |

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
// apps/web/src/app/projects/[projectId]/_components/AppShell.tsx
// (âncora simbólica — o bloco `const slug = pathname...` / `hasModule` / `router.replace('/no-permission')`;
//  as linhas se deslocaram, não citar número)
const slug = pathname.replace(basePath + '/', '').split('/')[0];
const current = navItems.find((n) => n.slug === slug);
if (current && !hasModule(current.module as ModuleSlug)) {
  router.replace('/no-permission');
}
```

> As quatro rotas colapsadas do PESSOAL (`expenses`, `receipts`, `credit-cards`, `bank-accounts`)
> têm **redirect próprio para `/conta` preservando a query** (#529/#633) — isto entra como
> restrição da decisão de fallback (§5.3), não como caso do shell.

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

#### 5.3 Fallback — DECIDIDA pelo architect de U6b (2026-08-31)

**Decisão:** o fallback depende do **nível** do identificador:

- **nível de ITEM** (`?item=` apontando para algo fora do payload escopado) → **hub silencioso**,
  sem revelar a existência do recurso — seleção simplesmente não acontece;
- **nível de ROTA** (slug/rota sem módulo) → **`/no-permission`**, inalterado (casos 1 e 4 da §5.2).

A escolha respeita a regra de U3 (§5.1), o precedente `/expenses` (#369, resolução por
`hasNavRoute` derivado) e o casamento por slug (§5.2), além do redirect que preserva query das
quatro rotas colapsadas do PESSOAL (#529/#633).

Registro das opções consideradas e a consequência de cada uma:

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

> **D-2, D-9 e D-14 foram RESOLVIDOS** (por execução em #501/#596 e por atualização de doc) e o
> detalhe histórico de cada um está no **Apêndice histórico → "Divergências resolvidas"**.
> As entradas abaixo ficam apenas como ponteiro.

**D-1 — Status do programa estava estagnado.** RESOLVIDO: B0 (#447) **CLOSED**; **B1a mergeado**
(`5bbe5d69` #477, `720ff1fc` #478, `890b89b0` #479); **B1b CLOSED** (PR #499);
**B2 (#449) CLOSED** (PR #500 — removeu `budget-allocation` da nav); **W1 (#214) CLOSED**.
O **gate de extinção do B2 foi dispensado** pelo PO em 2026-08-19 — ver §7.3.

**D-2 — RESOLVIDO POR EXECUÇÃO (#501/`ce27736b`).** A superfície `/financeiro` foi **morta por
execução**, não só inalcançável: `apps/web/src/app/financeiro/` não existe, `tenant-financial.controller.ts`
foi deletado (0 rota HTTP) e `financialDashboard` saiu do `ModuleSlug`. `TenantFinancialService`
**sobrevive** como provider interno (Maria). A reexposição de `getUpcoming`/`getTopSuppliers` sob
gate `monthlyOverview` é follow-up aprovado e não entregue (#635), fora da U6b build 1. Detalhe
histórico movido para o Apêndice.

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

**D-6 — MUDOU.** `pendencias` **está agora em `PROJECT_FEATURES[REFORMA]`** (array REFORMA em
`project-features.ts`) e em `PROJECT_NAV[REFORMA]` — para REFORMA deixou de ser gated-sem-superfície.
Para **PESSOAL** o estado permanece: gated em `TYPE_MODULES` sem feature e sem linha de nav (API
alcançável, produto inexistente).

**D-7 — Exceção aceita ao "nunca hard-code o tipo"** em `resolve-variant.ts:13-16,19,24` (§0).
Registrada como aceita, com motivo, não como drift.

**D-8 — Deep-link é guardado só para slugs conhecidos da nav** (§5.2). Rotas fora da nav do tipo caem
na página sem redirect do shell.

**D-9 — RESOLVIDO.** #498 CLOSED, corrigido em #596: `car-info.service.ts` agora faz
`ensureProject(tenantId, projectId)` antes de ler/gravar. Detalhe histórico movido para o Apêndice.

**D-10 — Carteira tem duas verdades em superfícies diferentes** (§2.1). Visível dentro do PESSOAL,
nunca divulgada como origem cross-project (O8). Nenhum doc as coloca lado a lado — era o item com
maior risco de U6b implementar uma e quebrar a outra. **Resolvido em A-3 (§7.4): as duas metades
valem juntas e U6b herda a restrição.**

**D-11 — "Regras de merchant são tenant-scoped" é incompleto** (§3.2): `tenantId` nullable, `null` =
regra global de ADMIN, lookup tenant-first com fallback global.

**D-12 — ACL tem branch legado e falha fechada** (§4): `allowedProjectTypes` vazio deriva tipos dos
módulos; grant JSON corrompido invalida a sessão.

**D-13 — Autoridade da identidade do rateio** (§3.1): `RateioAllocation` é autoritativa;
`linkedExpenseId` é só o primeiro alvo. O plano fala em "ocorrência única" sem dizer qual campo
manda; esta spec diz.

**D-14 — RESOLVIDO.** `docs/visao-conta-faturas.md` já diz "B1a MERGEADO" (âncora simbólica no
bloco de status do topo); o alvo stale que o D-14 apontava não existe mais.

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

**Duas advertências que guiaram a aposentadoria** (executada em #501 — ver "Estado de execução" abaixo):

1. **Não apagar `resolveAccessibleProjectScope`.** O controller o usa
   (`tenant-financial.controller.ts:34-48`), mas ele é consumido por **outros 10 arquivos**
   (expense, agent, credit-card, bank-account, monthly-overview, notifications…). É a máquina de
   escopo do app, não da superfície.
2. **Remover também os pontos de entrada**, ou sobram links mortos: `projects/page.tsx:209`,
   `dashboard/page.tsx:617,634`, a entrada de nav e o slug em `auth-context.tsx:34,57`.

#### Estado de execução (2026-08-31)

**A metade "APOSENTAR" foi feita em #501 (`ce27736b`):** rota web, controller HTTP e slug
`financialDashboard` removidos; `overview`/`cash-flow`/`by-category` saíram junto. As **6 tools da
Maria foram preservadas** — `TenantFinancialService` continua como provider interno.

A metade "retirar HTTP + tela + slug" **já foi feita em #501**. A metade "ABSORVER" se divide em
duas entregas distintas, sobre dados já tenant/ACL-scoped e deduplicados pelo motor:

| Capacidade | Entrega | Estado |
|---|---|---|
| `by-project` → **agrupamento por `project.type`** | **U6b build 1** — lente `by-type`, **frontend-only, read-only em `/conta`** (deriva de `PROJECT_FEATURES`/`TYPE_MODULES`, inclui PLANTAS como "sem financeiro"); sem endpoint, query ou mutation novos | **design fechado** (architect + 8 lentes + security PASS), **RED spec definido**, **aguardando autorização de implementação do PO**; nada em produção |
| `upcoming` — próximos vencimentos | **follow-up [#635](https://github.com/Gabrieldco1994/reformaflow/issues/635)** — reexpõe `getUpcoming` (ex.: `@Get('upcoming')` sob gate `monthlyOverview`); classificação **ABSORVER** conforme A-1 | **aprovado, NÃO entregue.** Cria superfície HTTP nova → exige architect + security novos. **Backend não autorizado nesta rodada.** |
| `top-suppliers` — fornecedores agregados | **follow-up [#635](https://github.com/Gabrieldco1994/reformaflow/issues/635)** — reexpõe `getTopSuppliers`; classificação **ABSORVER** conforme A-1 | idem — **aprovado, NÃO entregue**, backend não autorizado nesta rodada |

##### Controle de ativação — U6b build 1

A lente `by-type` é ativada via **variável de ambiente build-time** (Next.js/Vercel):

- **Nome:** `NEXT_PUBLIC_FEATURE_CONTA_LENTE_POR_TIPO`
- **Ativação:** habilitada somente quando `=== '1'`
- **Padrão (ausente ou qualquer outro valor):** desabilitada
- **Escopo:** variável pública Next.js; **não é `ProjectFeature`, `ModuleSlug` ou nav capability** — não entra em `PROJECT_FEATURES`, `TYPE_MODULES` ou `PROJECT_NAV`
- **Mecanismo:** build-time (Vercel/Next); **não substitui gates server-side** de autorização ou capacidade
- **Impacto de mudança:** alteração exige novo build e deploy da aplicação

Esta variável é **somente e exclusivamente** para renderização de UI frontend; não altera autorização, scope de dados, rota HTTP nem comportamento persistido.

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

### 7.3 B2 — o gate de extinção foi dispensado, e **não por uso zero** — **DECIDIDA**

**Decisão:** o gate de extinção do **B2 (#449)** está **dispensado**. O B2 vai **direto para o
congelamento read-only** do Budget Allocation.

**A razão da dispensa não é ausência de uso.** É que **B2 é congelamento read-only com histórico
preservado, não extinção**: nenhuma linha é apagada. O gate existia para proteger dados reais de uma
**extinção** apressada, e não há extinção a proteger. A dispensa é sobre o **gate**, não sobre o
cuidado — o congelamento continua sendo o caminho, e continua sendo trabalho do B2, não desta spec.

#### Evidência de produção — medida em 2026-08-19

Medição pelo PO com `fly ssh console -a reformaflow-api -C "sqlite3 -readonly /data/dev.db ..."`:

| Métrica | Valor |
|---|---|
| `users` | 200 |
| `tenants` | 196 |
| `budget_allocations` (total) | 6 |
| `budget_allocations` vivas (`deleted_at is null`) | **4** |
| soma das vivas | **R$ 235.000,00** (`23500000` centavos) |
| `cash_flow_entries` `ALOCACAO_ORCAMENTO` vivas | 4 |
| `category_budgets` | **0** |
| tenants com alocação viva | **1 — `dev-tenant-1`** |
| usuários com `financialDashboard` em `allowed_modules` | **0 de 200** |

**Leitura correta destes números — e a leitura errada que eles convidam.** Budget Allocation **foi
usado**: há **R$ 235.000,00 em 4 alocações vivas**. Mas elas estão **concentradas em um único
tenant — `dev-tenant-1`, o tenant de desenvolvimento — de 196 tenants**. O efeito visível do
congelamento é estreito e conhecido: as linhas `ALOCACAO_ORCAMENTO` deixam de aparecer na tela de
Recebimentos **desse tenant de dev**. `category_budgets` é de fato **0**.

> **Não escrever, em lugar nenhum, que "Budget Allocation nunca foi usado".** É falso, e uma versão
> anterior deste documento chegou a afirmá-lo. O dado que sustenta a dispensa é a **concentração em
> um tenant de desenvolvimento**, combinada com o fato de que o B2 **preserva o histórico** — não a
> inexistência de uso.

> #### `prisma/dev.db` não é produção
>
> A afirmação de uso zero veio de uma leitura de **`prisma/dev.db`**, o banco **local do repositório**.
> Produção é um **volume Fly**: `DATABASE_URL = "file:/data/dev.db"` montado em
> `apps/api/fly.toml:5,11` (app `reformaflow-api`). Os dois arquivos têm o mesmo nome e conteúdos
> completamente diferentes.
>
> **Qualquer evidência de uso real mede-se no volume Fly**, via `fly ssh console`. Nenhuma decisão de
> produto deve citar contagem vinda de `prisma/dev.db`. Esta é exatamente a classe de erro que este
> documento existe para impedir: um número que parece medido, mas foi medido no lugar errado.

### 7.4 A-3 — O invariante O8 **vale**, e U6b não pode presumir o contrário — **DECIDIDA**

Contexto: §2.1, §6 D-10, `quitacao-parcela-cross-project.md:69`.

**Decisão:** **o invariante O8 vale.** A **Carteira** permanece **visível nas account views do
PESSOAL** e **nunca** é divulgada como **origem cross-project**. É **contrato vigente** em
`AGENTS.md:52-53`, não uma pergunta em aberto. **U6b herda a restrição — não a renegocia.**

As duas metades continuam valendo juntas, e implementar uma esquecendo a outra quebra o contrato:

1. **Visível dentro do PESSOAL** — movimentos sem cartão e sem conta pertencem à Carteira e
   **devem permanecer visíveis** nas account views e nos totais (`AGENTS.md:52-53`).
2. **Nunca divulgada para fora** — `classifySource` devolve `null` para fonte sem cartão e sem
   conta (`paid-origins.builder.ts:145-151`), de modo que a Carteira **não emite origem**
   cross-project (`quitacao-parcela-cross-project.md:69`).

Consequência prática para U6b, já decidida: uma superfície nova que mostre origem cross-project
**respeita o `null`** — alvos pagos pela Carteira aparecem com pagador **não divulgado**. Não há
terceira via, e essa não é uma escolha que o architect de U6b possa reabrir.

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
  extinção do B2 dispensado**. **A-3 permanece aberta.** Incorporado
  #497: `@Roles('ADMIN')` não é gate administrativo, o que altera a leitura de ACL da §4.
- **2026-08-19 (correção de evidência, mesmo dia) — os números de produção estavam errados.** A
  contagem que sustentava o "uso zero" do Budget Allocation viera de **`prisma/dev.db`**, o banco
  local do repositório, **não de produção** (volume Fly, `apps/api/fly.toml:5,11`). Medição correta
  via `fly ssh console`: **200 usuários**, **196 tenants**, **4 alocações vivas somando
  R$ 235.000,00**, todas concentradas em **um único tenant de desenvolvimento (`dev-tenant-1`)**;
  `category_budgets` segue **0**. A frase "Budget Allocation nunca foi usado" foi **removida por
  ser falsa**, e a dispensa do gate foi reancorada na razão correta: **B2 é congelamento read-only
  com histórico preservado, não extinção**. A conclusão sobre `/financeiro` sobreviveu e ficou mais
  forte: **0 de 200**. Registrada a nota permanente de que `prisma/dev.db` não é produção (§7.3).
  **A-3 respondida e fechada** (§7.4): o invariante **O8 vale** e U6b não o renegocia; a §8 de
  pergunta aberta deixou de existir.
- **2026-08-31 — re-ratificação (v2) e estado de execução.** Matriz re-ratificada pelo architect
  contra `1da83286`; conteúdo dos mapas de capacidade inalterado onde verificado. Status do topo e
  §7 atualizados: spec mergeada (#506), A-1/A-2/A-3 decididas. **U6b build 1** (lente `by-type`,
  frontend-only, read-only em `/conta`): design fechado (architect + 8 lentes + security PASS), RED
  spec definido, **aguardando autorização de implementação do PO** — nada em produção. `upcoming`/
  `top-suppliers` → follow-up aprovado e não entregue (#635), ABSORVER conforme A-1, backend não
  autorizado nesta rodada. §1 corrigida: `PROJECT_NAV[PESSOAL]`
  de 13 → **9 linhas** (U4 #528; B2 #500 removeu `budget-allocation`), 5 rotas financeiras
  redirecionam para `/conta` preservando query (#528/#529/#633). Fallback (§5.3) **decidido**:
  ITEM → hub silencioso, ROTA → `/no-permission`.
- **2026-08-31 — Divergências resolvidas (movidas de §6).**
  - **D-2 (#494) — RESOLVIDO POR EXECUÇÃO (#501/`ce27736b`).** Detalhe histórico: `financialDashboard`
    tinha 0 ocorrência em `TYPE_MODULES` e 0 de 200 usuários de produção o possuíam; a rota
    `apps/web/src/app/financeiro/`, o card "Saúde financeira consolidada", os links "← Visão Geral"
    e toda a API `GET /tenant/financial/*` estavam inalcançáveis para usuário comum e visíveis só a
    ADMIN/OWNER reais (e, à época, ao convidado de demo com `role:'ADMIN'`). #501 removeu a rota web,
    o controller HTTP e o slug; `TenantFinancialService` sobrevive como provider interno.
  - **D-9 (#498) — RESOLVIDO (#596).** Detalhe histórico: `CarInfoService.findUnique/upsert` filtravam
    só por `projectId`, ignorando o `tenantId` recebido; segurança dependia inteiramente dos guards.
    #596 adicionou `ensureProject(tenantId, projectId)`.
  - **D-14 — RESOLVIDO.** `visao-conta-faturas.md` já registra "B1a MERGEADO"; o stale que o D-14
    apontava ("esta PR, pendente de merge") não existe mais.
- **Precedentes citados:** #98 (mapa único de gate, cliente e servidor), #289 (combustível),
  #291 (dieta de COMPRA), #369 (superfície única de despesas em CASA/CARRO), #424 (origem do
  pagamento na REFORMA), #423/#428 (leitura canônica de rateio), #480/#484 (escopo prometido ×
  escopo aplicado), #447/B0 e #448/B1a (identidades e child ACL).
