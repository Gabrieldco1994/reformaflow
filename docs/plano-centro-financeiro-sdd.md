# Centro Financeiro multi-tenant — SDD canônico

> **PLANEJAMENTO APROVADO — IMPLEMENTAÇÃO DE PRODUTO/RUNTIME NÃO INICIADA; BASELINE
> TEST-ONLY S0.3 EM ANDAMENTO.**
>
> Este documento versiona o design do programa
> [#436](https://github.com/Gabrieldco1994/reformaflow/issues/436). A publicação desta
> especificação é a entrega documental S0.1; ela não entrega Centro Financeiro, nova UX, Maria
> agent-first, U6b nem hardening H1–H5.

**Status do design:** architect concluído; security PASS condicionado aos gates incorporados
abaixo.

**Base original da análise:** `ece5032c398cc050fc037959a1f8fc0cc7f05bea`.

**Regra de execução:** antes de começar **cada** task, buscar a `main` corrente, revalidar as
suposições e rebasear a branch da task. A base acima registra proveniência; não autoriza construir
sobre código antigo.

## 1. Escopo e fontes de verdade

Este é o destino canônico das decisões, ondas, dependências, riscos e mudanças de decisão do
programa #436. O estado de execução vivo continua nos issues nativos; qualquer merge de uma onda
deve atualizar este documento pelo D0 ([#458](https://github.com/Gabrieldco1994/reformaflow/issues/458)).

O programa **não substitui nem reformula** os contratos financeiros existentes:

- [estado entregue do Cockpit/Conta](estado-atual-cockpit-pessoal.md);
- [caixa real e consolidado, inclusive §10](cockpit-caixa-real.md);
- [Conta e faturas](visao-conta-faturas.md);
- [quitação de parcela cross-project](quitacao-parcela-cross-project.md);
- [datas e timezone](politica-datas-timezone.md);
- [contrato atual da Maria](maria-ia.md);
- [manual do comportamento atualmente visível](manual-do-aplicativo.md).

Em caso de divergência:

1. os docs normativos acima vencem para fórmulas e comportamento já entregue;
2. este SDD vence para o planejamento aprovado do programa #436;
3. o issue da task e a `main` corrente precisam ser revalidados antes do build;
4. nenhuma promessa deste documento pode ser copiada para o manual antes de chegar ao runtime.

> **ATENÇÃO — PRODUÇÃO `NOT_COLLECTED` (decisão PO de 2026-08-17):** a admissão da Fly Machine
> de S0.2 falhou antes de qualquer acesso ao banco. Agregados, cardinalidades e anomalias de
> produção não foram coletados e nunca devem ser interpretados como zero. Código, histórico do
> GitHub e as 63 migrations commitadas até `20260810234344` descrevem somente o estado esperado;
> não são evidência de dados de runtime nem de migrations efetivamente aplicadas em produção.
> Nova tentativa de S0.2 exige primeiro a telemetria do suporte Fly e depois nova autorização
> explícita.

## 2. Vocabulário de status

| Status | Significado neste documento |
|---|---|
| **ENTREGUE** | Existe na base atual fora do programa #436 e está descrito pelos docs de estado/contrato. |
| **APROVADO — NÃO INICIADO** | Decisão aceita para o programa, mas sem implementação de produto. |
| **BLOQUEADO** | Pode ser construído apenas depois das dependências e gates indicados. |
| **FUTURO — NOVO PO GATE** | Não está autorizado para build; exige dependências completas e nova decisão explícita do PO. |

### 2.1 ENTREGUE hoje

Na base original, e **não como resultado deste programa**:

- PESSOAL já funciona como Cockpit financeiro cross-project; Conta, caixa, faturas, Carteira,
  vínculos, rateios e settlements seguem os contratos normativos existentes;
- REFORMA, COMPRA, CASA e CARRO já existem como projetos de finalidade/operação;
- Planning e Planejador existem com persistências distintas; a iniciativa #271 entregou o
  Planejador, mas não os unificou com Planning;
- a Maria já possui a superfície e as capacidades registradas em
  [maria-ia.md](maria-ia.md). Isso **não** significa que E5/M0–M3 estejam entregues;
- versionar este SDD não entrega nenhuma task do programa #436. **O que já foi entregue, por
  execução independente e não pela publicação deste documento:** B0 (#447), via PR #476, com o
  issue **CLOSED**; e a fatia **B1a**, mergeada em `main` (`5bbe5d69` #477, `720ff1fc` #478,
  `890b89b0` #479); a fatia **B1b**, mergeada via PR #499 (`67d80d06`); e **B2 (#449)**, mergeado
  via PR #500 (`f6ab06d9`). **#448 permanece OPEN pela fatia web** (PR #503). As demais tasks
  S0/U1–U6/V0/D0/R0/A0/M0–M3/H1–H5 continuam sem implementação de produto.

### 2.2 APROVADO, mas não iniciado ou bloqueado

- O modelo de produto e as ondas E0–E4 estão aprovados.
- S0.1 ([#444](https://github.com/Gabrieldco1994/reformaflow/issues/444)) é somente a
  canonicalização documental.
- U6a está em [`financeiro-projetos-por-tipo.md`](financeiro-projetos-por-tipo.md), **spec mergeada
  (#506)** com A-1/A-2/A-3 decididas e **matriz re-ratificada contra `1da83286`**. A **U6b build 1**
  (lente `by-type` — agrupamento por `project.type`, **frontend-only, read-only em `/conta`**, sem
  endpoint/query/mutation novos) tem **design fechado** (architect + 8 lentes + security PASS) e
  **RED spec definido**, mas **aguarda autorização de implementação do PO** — nada em produção.
  Os endpoints `upcoming`/`top-suppliers` são **follow-up aprovado e não entregue (#635)**, backend
  não autorizado nesta rodada. Continua zero fórmula/store/migration/backfill.
- E6/H1–H5 é um envelope aprovado de hardening, mas cada item continua bloqueado por nova revisão
  architect+security e pelos gates de dados/PO/SRE aplicáveis.

**Matriz de decisão E0 — 2026-08-17**

| Item | Estado sincronizado | Dependência e limite |
|---|---|---|
| S0.1 [#444](https://github.com/Gabrieldco1994/reformaflow/issues/444) | **CONCLUÍDA (documental)** | Libera S0.2 e S0.3. |
| S0.2 [#445](https://github.com/Gabrieldco1994/reformaflow/issues/445) | **BLOQUEADA/DEFERIDA; produção `NOT_COLLECTED`** | Próxima tentativa somente após telemetria do suporte Fly e nova autorização explícita. |
| S0.3 [#446](https://github.com/Gabrieldco1994/reformaflow/issues/446) | **READY sob exceção PO; test-only em andamento** | Pode construir, testar e fazer merge sem aguardar a conclusão de #445; não toca produto/runtime. |
| B0 [#447](https://github.com/Gabrieldco1994/reformaflow/issues/447) | **ENTREGUE — PR #476, produção** | Auth, grants e scope financeiro em produção. E0/#437 permanece incompleta pelo seu próprio gate de inventário (#445); isso não desfaz a entrega de B0. |
| B1a [#448](https://github.com/Gabrieldco1994/reformaflow/issues/448) | **ENTREGUE — mergeado em `main`** (`5bbe5d69` #477, `720ff1fc` #478, `890b89b0` #479) | Child ACL, identidades de fatura, ações server-provided, guard de duplicidade; zero schema/UX. |
| B1b [#448](https://github.com/Gabrieldco1994/reformaflow/issues/448) | **ENTREGUE — mergeado em `main`** (`67d80d06`, PR #499) | Endurecimento do legado: `last4` ambíguo responde **409** (`resolveUniqueLegacyMatch`) em vez de resolver em silêncio, e `GET :id/rateio` vira **source-only** — detalhe só com todos os participantes autorizados e soma exata; caso contrário devolve o payload de uma compra nunca rateada, ancorado no id pedido. `hidden*` count/sum REMOVIDOS. #448 permanece OPEN pela fatia web (W1). |

E0 [#437](https://github.com/Gabrieldco1994/reformaflow/issues/437) permanece incompleta enquanto
#445 estiver aberta. A exceção de #446 não conclui E0 nem dispensa o gate de produção.

### 2.3 FUTURO — depende de novo PO gate

E5 e M0–M3 são apenas planejamento futuro. Maria agent-first só pode ser reavaliada depois de
U3, U4 e U6b entregues, seguida de novo PO gate. Não há autorização implícita para implementar,
medir conteúdo financeiro ou retirar a navegação atual.

## 3. Modelo de negócio aprovado

1. **Conta = origem:** mostra de onde o dinheiro veio ou por onde saiu.
2. **Projeto = finalidade:** REFORMA, COMPRA, CASA e CARRO continuam sendo lentes de uso e
   operação.
3. **Cockpit conta uma vez:** cada ocorrência financeira lógica aparece uma única vez no
   consolidado autorizado.
4. **Auditoria explica:** expõe origem, finalidade, vínculo, datas e ações autorizadas; não
   recalcula nem cria um segundo ledger.

Consequências:

- o PESSOAL é o centro financeiro; nenhum Hub pode somar silenciosamente outro PESSOAL;
- a arquitetura de informação desejada é **Hoje, Movimentações, Planejamento e Projetos**;
  Resultado/Auditoria ficam como áreas secundárias;
- Planning e Planejador serão agrupados visualmente, sem misturar `localStorage`, tabelas ou
  endpoints;
- Cash-flow permanece auditoria técnica; não vira o saldo bancário nem substitui o caixa real;
- Budget Allocation sai do discovery. Seus dados históricos são preservados e o acesso torna-se
  administrativo/read-only antes de qualquer discussão de retirada definitiva;
- rotas, slugs, bookmarks, query params e storage keys existentes permanecem durante o rollout;
- Maria reutilizará futuramente os mesmos cards, serviços, actions e ACLs. Ela não terá modelo
  financeiro, persistência ou autorização paralelos.

## 4. Contratos globais obrigatórios

Esta seção registra gates do programa, não uma nova versão das fórmulas canônicas.

### 4.1 Dinheiro, dados e compatibilidade

- Caixa §10, faturas, Carteira, DRE por competência, cash-flow zero-based, vínculo, rateio e
  settlement não mudam numericamente. Consultar sempre as fontes da [seção 1](#1-escopo-e-fontes-de-verdade).
- Diferença de **R$ 0,01** para o mesmo scope bloqueia merge e rollout.
- B0, B1, B2 e U1–U6 são ondas **zero-schema, zero-backfill, zero-delete e
  zero-transformação de dados**. Exceção exige nova task/gate explícitos; não pode ser absorvida
  pela onda.
- Rotas e stores antigos permanecem. API/web em versões mistas falham fechado quando não puderem
  executar com segurança.
- Signup continua persistindo `USER`; o programa não cria nem persiste `OWNER` e não introduz
  `accessRole` como fonte autoritativa de autorização.
- Não improvisar auditoria, repair ou pending state em string de `UserActivityLog`. Auditoria
  financeira estruturada pertence exclusivamente ao H3, futuro, schema-backed e sujeito aos
  gates próprios.

### 4.2 Tenant, scope e ACL

- Tenant vem da sessão/banco. Produção não aceita override de tenant.
- `allowedProjects=[]` mantém a semântica atual de wildcard por ID, limitada ao tenant, aos tipos
  e aos módulos autorizados e materializada em IDs concretos.
- JSON inválido de grants falha fechado em Auth e JWT; nunca vira `[]`.
- O Hub exige um PESSOAL explícito e autorizado; não escolhe nem agrega outro PESSOAL
  silenciosamente.
- Scope é aplicado **antes** de buscar, agregar, deduplicar ou produzir metadados.
- **GAP LEGADO — FECHADO EM B1b (#448):** a contagem/soma agregada de alvos de rateio ocultos era
  o comportamento do runtime legado. `AGENTS.md`, [estado-atual-cockpit-pessoal.md](estado-atual-cockpit-pessoal.md)
  e [manual-do-aplicativo.md](manual-do-aplicativo.md) já descrevem o contrato novo: `GET :id/rateio`
  é **tudo-ou-nada**: a lista só existe quando TODOS os participantes estão autorizados E a soma
  dos vivos fecha exatamente o total. Caso contrário devolve source-only — payload idêntico ao de
  uma compra nunca rateada, com `rateadoCents: 0` e `removedTargetsCount: 0` (que passa a ser
  estruturalmente sempre 0). Lista filtrada não fecharia o vazamento: com a soma imposta na escrita,
  `total − Σ(itens visíveis)` É a soma oculta, em centavos exatos.
- No contrato futuro #436, projeto oculto ou cross-tenant não muda linha, total, contagem, série,
  tooltip, flag, metadata nem telemetria.
- Parent explícito same-tenant fora do scope responde `403`; child oculto, cross-tenant ou
  inexistente responde `404` indistinguível; identidade last4 ambígua responde `409`; ausência de
  sessão responde `401`.
- Novas identidades de fatura/pagamento usam `projectId`, `cardId`, `accountId` e `dueMonth`;
  settlement nunca é resolvido apenas por `tenantId+last4`.
- Não criar endpoint financeiro universal. URL ou evidência financeira só pode ser servida por
  endpoint autenticado, parent-scoped e type-specific; nunca por URL estática ou sem autorização
  do parent.
- **CONTRATO FUTURO APROVADO PARA #436:** B0/B1 e o novo Hub só substituem a fonte quando todos os
  participantes do rateio estão autorizados e a soma fecha exatamente. Caso contrário, retornam
  source-only, sem flag, contagem, soma, metadata ou qualquer inferência sobre participantes
  ocultos.

### 4.3 Mobile e acessibilidade

Toda UX do programa precisa passar em **375 px, 390 px e desktop**:

- alvo de toque de pelo menos 44 px;
- texto de pelo menos 11 px e valores de pelo menos 15 px com `nowrap`;
- safe-area, teclado, landscape/altura reduzida, foco, reduced motion e hit-testing reais;
- nenhum módulo autorizado desaparece do “Mais” e nenhum overlay simultâneo ou retângulo zero
  pode passar;
- “mobile” significa a experiência responsiva/PWA existente, não um aplicativo nativo.

## 5. Mapa E0–E6 e dependency map

### 5.1 Caminho crítico

```text
S0.1 (#444) → S0.2 (#445 bloqueada/deferida)
S0.1 (#444) → S0.3 (#446 test-only, exceção PO)
[B0 (#447) ENTREGUE via PR #476]
[B1a #448 MERGEADO: #477, #478, #479] → [B1b #448 MERGEADO: #499] → [B2 #449 MERGEADO: #500]
[fatia web de #448: PR #503, aberto — não bloqueia E2]
B2 + security verify → U1 (#450) → U2 (#451)
U2 → U3 (#452) → U4 (#453)
U2 → U5 (#454)
U3 → U6a (#455)
U4 + U6a + lenses/architect/PO → U6b (#456)
```

V0 acompanha desde S0.3; D0 acompanha toda mudança visível; A0 acompanha U1–U5; R0 aceita cada
onda e, no release final, depende de B0+B1+B2+U1+U2+U3+U4+U5+U6b. E5 é futuro. E6 é uma trilha
separada e só entra no critical path quando uma exposição consumidora for demonstrada.

### 5.2 Epics

| Epic | Status do design | Conteúdo e dependência |
|---|---|---|
| [E0 #437](https://github.com/Gabrieldco1994/reformaflow/issues/437) | **INCOMPLETA**; S0.1 concluída, S0.2 bloqueada/deferida e S0.3 READY test-only | E0 permanece incompleta pelo seu próprio gate #445 de inventário de produção; B0 já foi entregue independentemente. |
| [E1 #438](https://github.com/Gabrieldco1994/reformaflow/issues/438) | **CONCLUÍDA — B0, B1a, B1b e B2 mergeados** | B0 via PR #476; B1a via #477/#478/#479; B1b via #499 (`67d80d06`); B2 via #500 (`f6ab06d9`). Resta a fatia **web** de #448 (identidades explícitas na tela de pagar fatura, PR #503), que destrava caso legado de `last4` duplicado. **O STOP de E1 sobre E2 está satisfeito.** |
| [E2 #439](https://github.com/Gabrieldco1994/reformaflow/issues/439) | **BLOQUEADO** | B0+B1+B2 → U1 → U2; reorganização reversível de desktop/mobile. |
| [E3 #440](https://github.com/Gabrieldco1994/reformaflow/issues/440) | **BLOQUEADO** | U3/U4/U5; U6a é spec e U6b tem gate humano adicional. |
| [E4 #441](https://github.com/Gabrieldco1994/reformaflow/issues/441) | **BLOQUEADO/cross-cutting** | V0, D0, R0 e A0 acompanham as ondas, não um mutirão tardio. |
| [E5 #442](https://github.com/Gabrieldco1994/reformaflow/issues/442) | **FUTURO — NOVO PO GATE** | Maria M0 → M1 → M2 → M3, somente após U3+U4+U6b. |
| [E6 #443](https://github.com/Gabrieldco1994/reformaflow/issues/443) | **BLOQUEADO/separado** | H1–H5 exigem fresh architect+security pass; não são entregues pelo Hub. |

### 5.3 Tasks e contratos de saída

#### E0 — baseline antes do código

Decisão PO de **2026-08-17**: depois de S0.1, S0.2 e S0.3 podem avançar independentemente.
A independência vale somente para construir, testar e fazer merge de #446 test-only; #445 e #446
continuam gates conjuntos do inventário de produção de E0 (B0 já foi entregue via PR #476).

- [S0.1 #444](https://github.com/Gabrieldco1994/reformaflow/issues/444): este SDD, ToC e higiene
  dos planos; zero runtime.
- [S0.2 #445](https://github.com/Gabrieldco1994/reformaflow/issues/445): inventário
  privacy-safe, somente contagens agregadas por tenant e **zero writes**. Está
  **BLOQUEADA/DEFERIDA**: a Fly Machine falhou antes do banco, portanto produção segue
  `NOT_COLLECTED`, nunca zero; nova tentativa depende de telemetria do suporte Fly e nova
  autorização explícita.
- [S0.3 #446](https://github.com/Gabrieldco1994/reformaflow/issues/446): baseline sintética
  determinística test-only, com estes sete temas de aceitação:
  1. dois tenants, matriz de personas/grants sem `OWNER`, dois PESSOAL, ocultos e colisões;
  2. relações exatas de rateio, espelho, neutro, cartão-paga-cartão, Planning e Planejador;
  3. centavos literais canônicos de Caixa (`983928`), Carteira (`2994`) e rateio (`30029`), além
     de totais/status de fatura fixados;
  4. mutação autorizada altera o oracle, enquanto mutação cross-tenant não altera o observável;
  5. payload local de Planning e Planejador server permanecem independentes;
  6. execução pelas 63 migrations commitadas até `20260810234344`, em SQLite de teste guardado
     dentro do worktree, abortando URL não-file ou escape por symlink;
  7. resultados idênticos em UTC e America/Sao_Paulo, com evidência dos limites da fixture.

#446 não certifica B0, segurança, dados de produção nem migration aplicada em produção, e não
conclui #445. As migrations e o histórico versionado usados na fixture representam estado
esperado, não evidência de runtime.

#### E1 — B0/B1/B2 antes de qualquer UX

- [B0 #447](https://github.com/Gabrieldco1994/reformaflow/issues/447): **ENTREGUE via PR #476.**
  Auth, grants, scope e todos os reads financeiros em produção.
- [B1 #448](https://github.com/Gabrieldco1994/reformaflow/issues/448): identidades completas,
  parent/child ACL, releitura no commit, actions fornecidas pelo servidor e deep-links
  type-specific sem ampliar scope. **B1a mergeado (#477, #478, #479) e B1b mergeado (#499).**
  #448 permanece OPEN pela fatia **web** (PR #503): a tela ainda enviava só `last4`, então o 409
  do B1b chegou a produção sem a contraparte cliente e deixou sem saída quem tem dois cartões de
  mesmo final.
- [B2 #449](https://github.com/Gabrieldco1994/reformaflow/issues/449): Budget Allocation
  administrativo/read-only, somente requisitante **full-access e não-convidado** autenticado do
  tenant (`isFullAccessRole(role) && !isGuest` — ADMIN ou OWNER); relações legadas cross-tenant
  redigidas e bytes históricos intocados.
  **Gate de extinção DISPENSADO pelo PO em 2026-08-19.** A razão **não é ausência de uso**: é que
  **B2 é congelamento read-only com histórico preservado, não extinção** — nenhuma linha é
  apagada. O gate protegia contra uma **extinção** apressada, e não há extinção. A dispensa é do
  gate, não do cuidado; o B2 vai direto ao congelamento.
  **Evidência real de produção**, medida em 2026-08-19 com
  `fly ssh console -a reformaflow-api -C "sqlite3 -readonly /data/dev.db ..."`: **200 usuários**,
  **196 tenants**, `budget_allocations` **6 no total / 4 vivas** somando **R$ 235.000,00**
  (`23500000` centavos), `cash_flow_entries` `ALOCACAO_ORCAMENTO` vivas **4**, `category_budgets`
  **0**, e **todas as alocações vivas concentradas em 1 único tenant — `dev-tenant-1`, o tenant de
  desenvolvimento — de 196**. O efeito visível do congelamento é estreito e conhecido: as linhas
  `ALOCACAO_ORCAMENTO` somem da tela de Recebimentos **desse tenant de dev**.
  > **Budget Allocation FOI usado — não escrever o contrário.** Uma versão anterior deste plano
  > afirmou "uso zero", número lido de **`prisma/dev.db`** (banco local do repositório), **não de
  > produção** — que é o volume Fly em `/data/dev.db` (`apps/api/fly.toml:5,11`). Qualquer
  > evidência de uso real mede-se no volume Fly.
  **Atenção ao desenho do "somente ADMIN":** por
  [#497](https://github.com/Gabrieldco1994/reformaflow/issues/497), `@Roles('ADMIN')` **não é um
  gate administrativo** — o convidado de demo é criado com `role: 'ADMIN'` e o `RolesGuard` nunca
  lê `isGuest`, de modo que esse gate entregaria o Budget a todo convidado.

**STOP — SATISFEITO em 2026-08-20.** B1a (#477/#478/#479), B1b (#499) e B2 (#500) estão
mergeados e em produção. O STOP era sobre a fundação backend; a fatia **web** restante de #448
(PR #503) corrige um caso legado de `last4` duplicado e **não** reabre o gate. U1 (#450) está
liberada para desenho e implementação.

#### E2 — arquitetura de informação e shell

- [U1 #450](https://github.com/Gabrieldco1994/reformaflow/issues/450): reorganizar a navegação
  desktop sem remover capacidade; preservar scope, mês, rotas e parâmetros compatíveis.
- [U2 #451](https://github.com/Gabrieldco1994/reformaflow/issues/451): dock, “Mais” e um único
  launcher/overlay em 375/390; Maria permanece na superfície secundária atual, sem capacidade
  nova.

#### E3 — jornadas unificadas, sem segundo ledger

- [U3 #452](https://github.com/Gabrieldco1994/reformaflow/issues/452): card/detalhe comum e
  actions server-provided; deep-link só seleciona item já retornado por resposta scoped.
- [U4 #453](https://github.com/Gabrieldco1994/reformaflow/issues/453): Movimentações/Conta como
  Hub, contando a fonte uma vez e mantendo rotas antigas e paridade em todos os campos
  observáveis.
- [U5 #454](https://github.com/Gabrieldco1994/reformaflow/issues/454): agrupar Planning e
  Planejador apenas visualmente; `localStorage` e API continuam independentes, e navegar não
  produz mutation.
- [U6a #455](https://github.com/Gabrieldco1994/reformaflow/issues/455): matriz por tipo,
  capacidade, origem/finalidade, identidade, ACL e deep-link/fallback. Somente spec.
  **Mergeada (#506) em [`financeiro-projetos-por-tipo.md`](financeiro-projetos-por-tipo.md); A-1/A-2/A-3
  decididas (2026-08-19); matriz re-ratificada contra `1da83286` (2026-08-31).**
- [U6b #456](https://github.com/Gabrieldco1994/reformaflow/issues/456): **NÃO implementada.**
  **Build 1** = lente `by-type` (agrupamento por `project.type`, **frontend-only, read-only em
  `/conta`**, sem endpoint/query/mutation novos): design fechado (architect + 8 lentes + security
  PASS), RED spec definido, **aguardando autorização de implementação do PO** — nada em produção.
  `upcoming`/`top-suppliers` → **follow-up aprovado e não entregue
  ([#635](https://github.com/Gabrieldco1994/reformaflow/issues/635))**, classificação ABSORVER
  conforme A-1, backend não autorizado nesta rodada (criam superfície HTTP nova, exigem architect +
  security novos). Zero fórmula/store/migration/backfill.

#### E4 — qualidade, docs, release e analytics

- [V0 #457](https://github.com/Gabrieldco1994/reformaflow/issues/457): matriz tenant/ACL/centavos
  e RED/GREEN/VERIFY por PR, em UTC e America/Sao_Paulo, com 375/390/desktop.
- [D0 #458](https://github.com/Gabrieldco1994/reformaflow/issues/458): atualizar estado, manual,
  contratos afetados e este SDD no mesmo PR que mudar comportamento.
- [R0 #459](https://github.com/Gabrieldco1994/reformaflow/issues/459): SHA testado = SHA
  implantado, CI/Fly/Vercel e smokes comprovados, mixed-version fail-closed e rollback ensaiado.
- [A0 #460](https://github.com/Gabrieldco1994/reformaflow/issues/460): instrumentação no Clarity
  existente, com allowlist e privacidade da [seção 6](#6-analytics-privacy-safe).

#### E5 — Maria agent-first (FUTURO)

- [M0 #461](https://github.com/Gabrieldco1994/reformaflow/issues/461): consultas usam serviços
  determinísticos scoped; o LLM não calcula dinheiro.
- [M1 #405](https://github.com/Gabrieldco1994/reformaflow/issues/405): proposta revisável,
  confirmação explícita, reautorização no commit e idempotência. A issue existente foi
  reaproveitada, não duplicada.
- [M2 #462](https://github.com/Gabrieldco1994/reformaflow/issues/462): texto, voz, OCR e upload
  convergem nos mesmos contratos de auth, confirmação, actions e idempotência.
- [M3 #463](https://github.com/Gabrieldco1994/reformaflow/issues/463): qualidade, custo,
  observabilidade, SLO/budget e privacidade antes de escala.

Todas permanecem **FUTURE**, bloqueadas por U3+U4+U6b e novo PO gate.

#### E6 — hardening pós-Hub (não entregue)

- [H1 #464](https://github.com/Gabrieldco1994/reformaflow/issues/464): imports/uploads/OCR;
- [H2 #465](https://github.com/Gabrieldco1994/reformaflow/issues/465): evidências autenticadas e
  parent-scoped;
- [H3 #466](https://github.com/Gabrieldco1994/reformaflow/issues/466): auditoria financeira
  schema-backed e transacional;
- [H4 #467](https://github.com/Gabrieldco1994/reformaflow/issues/467): identidades, constraints,
  expand/backfill/enforce e reparo histórico;
- [H5 #468](https://github.com/Gabrieldco1994/reformaflow/issues/468): atomicidade/idempotência de
  import commit/undo e consistência dos reads anuais.

H1–H5 não vêm “de carona” em B0/B1 ou em uma onda zero-schema. Cada um exige threat model,
RED, rollback, fresh architect+security pass e, para qualquer data-write, PO/SRE gate com
backup, restore e verificação de integridade.

## 6. Analytics privacy-safe

Usar somente o Clarity já instalado; não adicionar dependência ou infraestrutura.

- North star: conclusão semanal de tarefa em sessões expostas ao Centro Financeiro.
- Eventos permitidos: `rf_finance_eligible`, `rf_finance_center_exposed`,
  `rf_finance_today_reached`, `rf_finance_movements_reached`, `rf_finance_create_opened`,
  `rf_finance_planning_reached`, `rf_finance_projects_reached`,
  `rf_finance_secondary_reached`, `rf_finance_task_started/completed`,
  `rf_finance_cross_project_started/completed`,
  `rf_finance_planning_change_started/completed`,
  `rf_finance_deeplink_resolved/fallback` e `rf_finance_error_shown`.
- Tags permitidas:
  `device_class={mobile_le_375,mobile_376_390,mobile_other,desktop}`,
  `entry_kind={direct,internal,deep_link,legacy_redirect}`,
  `fallback_kind={no_personal,denied,not_found,load_failed}`,
  `error_class={acl_denied,not_found,load_failed,mutation_failed,storage_failed}` e
  `planning_store={planning_local,purchase_planner_server}`.
- Emitir um evento por ação lógica, nunca por render, card, linha ou item.
- Não registrar dinheiro, saldos, parcelas, limites, descrições, títulos, nomes, last4,
  categoria/status financeiro, contagens de objetos financeiros, OCR, voz, chat, URL, query
  string, IDs de usuário/tenant/projeto/recurso, texto livre, erros livres ou stacks.
- Não incluir Maria ID nem action ID.
- Clarity indisponível não bloqueia a tarefa do usuário.
- Segurança/privacidade, payload proibido e duplicação bloqueiam rollout. Baixa adoção isolada é
  observação de produto e não aciona rollback.
- Guardrails: erro/exposição ≤2% e aumento ≤1 ponto percentual contra 14 dias; conclusão não cai
  mais de 5 pontos percentuais; deep-link ≥98%; zero duplicação; dead taps <5%; mobile não fica
  mais de 10 pontos percentuais abaixo de desktop com `n≥30`.
- A leitura de 24h/72h/D14, estendida até D28 quando a amostra for baixa, e qualquer delta da
  allowlist devem ser revalidados no [issue A0 #460](https://github.com/Gabrieldco1994/reformaflow/issues/460)
  e na `main` da onda.

## 7. SDD por task: RED → GREEN → VERIFY

Cada task do programa é uma unidade revisável:

1. **Revalidar:** atualizar a referência da `main`, confirmar dependências/gates e registrar
   qualquer delta desde `ece5032c398cc050fc037959a1f8fc0cc7f05bea`.
2. **RED:** provar o gap com fixture/teste/inspeção autorizada antes de alterar comportamento.
3. **GREEN:** implementar apenas o contrato da task; preservar rotas, stores, números e
   compatibilidade declarados.
4. **VERIFY:** repetir matriz tenant/ACL/centavos, timezone, mixed-version e 375/390/desktop
   conforme a onda.
5. **D0/A0/R0:** atualizar docs no mesmo PR, inspecionar telemetria permitida e anexar
   SHA/deploy/rollback quando aplicável.
6. **Merge ledger:** o issue-maintainer marca ACs apenas no merge; nenhum agente faz auto-merge.

## 8. Riscos e rollback

| Risco | Gate/mitigação | Rollback |
|---|---|---|
| Vazamento cross-tenant por fetch/agregação antes do scope | B0, fixture de dois tenants e campo observável invariável | Forward-fix de segurança; não reabrir leitura insegura para “voltar”. |
| Outro PESSOAL somado silenciosamente | Âncora explícita/autorizada e IDs concretos | Desligar Hub/rota nova; manter rotas legadas seguras. |
| Colisão last4 ou child fora do parent | Identidade completa, 403/404/409 e releitura no commit | Bloquear ação insegura; preservar chave legada somente para leitura compatível. |
| Segundo ledger ou diferença de centavos | Reuso dos contratos canônicos e gate de R$ 0,01 | Reverter UI/query da onda; nunca ajustar ledger manualmente. |
| Perda de histórico do Budget | B2 read-only, checksum e zero transformação | Reverter rota/UI; nunca reabrir writes como rollback automático. |
| Mistura de Planning e Planejador | U5 visual-only, testes independentes de store/API | Reverter agrupamento visual; dados/stores ficam intocados. |
| Deep-link amplia scope | Item deve existir na resposta scoped e a rota continua type-specific | Fallback sem revelar existência; desabilitar deep-link novo. |
| Regressão mobile/acessível | Browser real em 375/390/desktop, foco e hit-test | Reverter shell/feature da onda mantendo rotas antigas. |
| Telemetria contém dado financeiro | Allowlist, masking/supressão e security review | Remover instrumentação; o produto continua funcional sem Clarity. |
| Maria vira autoridade por prompt | Serviços/actions/ACL determinísticos e confirmação server-side futura | Desligar actions/Maria; fluxos diretos permanecem. |
| Migration/backfill entra em onda crítica | Zero-schema explícito; gate PO/SRE separado | Parar a onda. Data-write futuro exige backup/restore/integridade próprios. |
| API/web mixed-version executa ação insegura | Contract tests fail-closed e rollout R0 | Pausar rollout ou desabilitar a feature, sem afrouxar ACL. |

## 9. Maria futura: preservação do planejamento histórico

O commit local histórico `fc6f57d7` (`docs/planejamento-futuro-maria.md`) foi usado somente como
entrada. Ele **não** é fonte de estado entregue e não deve ser cherry-picked nem promovido como
uma segunda spec.

Informação útil preservada e roteada:

- respostas futuras são tipadas (`reply`, blocos, proveniência, actions e metadata), mas todo
  número vem de serviço determinístico — M0/U3;
- a navegação atual só poderá ser rebaixada após evidência real de substituição, nunca para forçar
  adoção — novo PO gate de E5;
- proposta, confirmação, cancelamento, undo e idempotência independem do modelo/canal — M1;
- texto, voz, OCR e upload convergem no mesmo fluxo validado — M2;
- qualidade, latência, custo por usuário/tenant, capacidade do TTS e observabilidade exigem nova
  baseline; preços e estimativas datados no plano antigo são hipóteses, não SLO nem orçamento
  aprovado — M3;
- achados históricos de cobertura parcial da Maria, confirmação baseada em prompt, idempotência,
  parsing monetário, rótulos de runway/gráfico anual, ano selecionado e diferenças mobile/desktop
  precisam ser revalidados na `main` da task. Este SDD não os declara corrigidos nem autoriza
  mudar os motores financeiros;
- runway ancorado em caixa e resultado anual zero-based são conceitos diferentes. Uma futura
  revisão pode corrigir rótulos/estado apenas depois de revalidar o código; não deve igualar as
  fórmulas por conveniência.

O contrato normativo continua em [maria-ia.md](maria-ia.md); o roadmap futuro está nesta seção e
no [epic E5 #442](https://github.com/Gabrieldco1994/reformaflow/issues/442).

## 10. Planos concorrentes e histórico

- [plano-visao-conta-hub-2026-07.md](plano-visao-conta-hub-2026-07.md) é histórico do ciclo v1.
  Seu ledger congelado contém estados intermediários e não governa #436.
- [plano-ux-v2-2026-07.md](plano-ux-v2-2026-07.md) é histórico do ciclo v2. Itens ou referências
  de PR ainda abertos/stale devem ser revalidados, não tratados como roadmap ativo.
- `fc6f57d7` é input histórico da Maria, absorvido pela [seção 9](#9-maria-futura-preservação-do-planejamento-histórico).
- Notas soltas `PLANO_*`, `BRIEF_*`, `DIAGNOSTICO_*` e `RELATORIO_*` na raiz não são canônicas e
  não entram no ToC.

Os dois planos versionados foram mantidos no lugar, com marcação explícita de histórico, para
preservar links e contexto sem fingir que seus ledgers continuam vivos.

## 11. Registro de decisões finais

| ID | Decisão final aprovada | Estado de produto |
|---|---|---|
| D-001 | PESSOAL é o Centro Financeiro; Conta=origem, Projeto=finalidade, Cockpit conta uma vez, Auditoria explica. | **NÃO INICIADO por #436** |
| D-002 | B0+B1+B2, deploy B0 e security verify precedem qualquer UX. | **SATISFEITO — B0 (#476), B1a (#477/#478/#479), B1b (#499) e B2 (#500) mergeados e em produção.** Resta a fatia web de #448 (PR #503), que não bloqueia E2 |
| D-003 | Fórmulas de Caixa §10, faturas/Conta, timezone e quitação cross-project não serão reescritas. | Contratos atuais **ENTREGUES**; mudança do programa **NENHUMA** |
| D-004 | Navegação alvo: Hoje, Movimentações, Planejamento, Projetos; Resultado/Auditoria secundários. | **APROVADO — NÃO INICIADO** |
| D-005 | Planning e Planejador só se agrupam visualmente; stores permanecem separados. | **APROVADO — BLOQUEADO** |
| D-006 | Budget sai do discovery e fica ADMIN/read-only com histórico preservado. | **APROVADO — BLOQUEADO em B2. Gate de extinção DISPENSADO pelo PO em 2026-08-19 — não por uso zero, mas porque B2 é congelamento read-only com histórico preservado, não extinção** (nenhuma linha é apagada). Evidência real medida no volume Fly via `fly ssh console` em 2026-08-19: 200 usuários, 196 tenants, `budget_allocations` 6 total / **4 vivas somando R$ 235.000,00**, `ALOCACAO_ORCAMENTO` vivas 4, `category_budgets` 0, **todas as vivas concentradas em 1 tenant — `dev-tenant-1`, de desenvolvimento**. Efeito visível: as linhas `ALOCACAO_ORCAMENTO` somem da tela de Recebimentos desse tenant de dev. **Budget FOI usado; a leitura anterior de "uso zero" veio de `prisma/dev.db`, banco local, não de produção (`apps/api/fly.toml:5,11`).** Desenho do gate precisa considerar #497 — `@Roles('ADMIN')` não barra convidado de demo. |
| D-007 | Mobile 375/390/desktop e acessibilidade são contrato de merge. | **APROVADO — BLOQUEADO** |
| D-008 | Analytics usa Clarity existente e allowlist sem conteúdo financeiro. | **APROVADO — BLOQUEADO em A0** |
| D-009 | U6b só existe depois de U6a+lenses+architect+PO. | **NÃO IMPLEMENTADA. Build 1 (lente `by-type`, frontend-only, read-only em `/conta`): design fechado (architect + 8 lentes + security PASS), RED spec definido, aguardando autorização de implementação do PO — nada em produção. `upcoming`/`top-suppliers` → follow-up aprovado e não entregue ([#635](https://github.com/Gabrieldco1994/reformaflow/issues/635)), ABSORVER conforme A-1, backend não autorizado nesta rodada** |
| D-010 | Maria agent-first reutiliza serviços/cards/actions/ACLs e requer novo PO gate. | **FUTURO; NÃO ENTREGUE** |
| D-011 | H1–H5 ficam separados e gated; não entram automaticamente no critical path. | **BLOQUEADO; NÃO ENTREGUE** |
| D-012 | Sob exceção PO de 2026-08-17, #446 pode avançar test-only sem #445; #445 concluída/revisada + #446 verde seguem obrigatórias para o gate de produção/inventário de E0. Produção permanece `NOT_COLLECTED`. | **S0.3 EM ANDAMENTO; E0 INCOMPLETA (gate #445); B0 ENTREGUE (PR #476, CLOSED); B1a MERGEADO (#477, #478, #479); B1b CLOSED (#499); B2 CLOSED (#500); W1 (#214) CLOSED. U6a spec MERGEADA (#506); U6b build 1 (lente `by-type`) com design fechado, NÃO IMPLEMENTADA — aguardando autorização do PO; `upcoming`/`top-suppliers` são follow-up aprovado e não entregue ([#635](https://github.com/Gabrieldco1994/reformaflow/issues/635))** |

## 12. Changelog

| Data | Versão | Mudança |
|---|---|---|
| 2026-08-31 | U6a re-ratificada; U6b build 1 desenhada | Canário §10 recuperado (#634 — 2 motores, sem gate congelado). Matriz U6a **re-ratificada contra `1da83286`** — conteúdo dos mapas de capacidade inalterado onde verificado; **spec U6a MERGEADA (#506)**. **U6b build 1 = lente `by-type`** (agrupamento por `project.type`, derivado de `PROJECT_FEATURES`/`TYPE_MODULES`, **frontend-only, read-only em `/conta`**, sem endpoint/query/mutation novos): **design fechado** (architect + 8 lentes + security PASS), **RED spec definido**, **NÃO IMPLEMENTADA — aguardando autorização de implementação do PO**; nada em produção. **`upcoming`/`top-suppliers` → follow-up aprovado e não entregue ([#635](https://github.com/Gabrieldco1994/reformaflow/issues/635))**, classificação ABSORVER conforme A-1, backend não autorizado nesta rodada (criam superfície HTTP nova, exigem architect + security novos). A metade "retirar HTTP + tela + slug" do `/financeiro` **foi feita em #501** (`ce27736b`): rota web e controller HTTP removidos, slug `financialDashboard` fora do `ModuleSlug`; `TenantFinancialService` sobrevive como provider interno. B1b (#499), B2 (#500) e W1 (#214) **CLOSED**. Convidado de demo deixou de ser `role:'ADMIN'` (#518/#505). **Nota B4:** transaction clients não podem depender do `$use` para segurança de tenant/soft-delete (`$use` roda em `$transaction` mas o middleware atual só intercepta findMany/findFirst/delete/deleteMany; findUnique nunca é interceptado); toda query transacional futura aplica tenantId/deletedAt/ACL explicitamente com teste próprio. U6b/by-type não cria transação/query/mutation → B4 N/A para o PR frontend, guardrail do follow-up backend (#635). |
| 2026-08-19 | B1a mergeado; U6a especificada | **B1a mergeado em `main`** via #477 (`5bbe5d69`), #478 (`720ff1fc`) e #479 (`890b89b0`); **#448 permanece OPEN pela fatia B1b**, **W1 (#214) aberto** e **B2 (#449) não iniciado**. Também mergeados e fechados: #480, #481, #483, #484, #486 — `main` em `9da93391`. **U6a (#455)** publicada em [`financeiro-projetos-por-tipo.md`](financeiro-projetos-por-tipo.md): matriz por tipo (capacidade, origem/finalidade, identidade, ACL, deep-link/fallback) derivada do código vivo, divergências código×doc e três decisões escaladas ao PO. Somente spec: zero código, fórmula, store, migration ou backfill. Achados de autorização extraídos para #494 e #495 (D-9 já registrado em #498). **Decisões do PO na mesma data:** A-1 decidida (aproveitar o reaproveitável do `/financeiro` e aposentar o resto — lista absorver/aposentar na §7.1 da spec), A-2 decidida (CASA/CARRO seguem em Avulsas, escolha deliberada e revisitável) e **gate de extinção do B2 dispensado** — por B2 ser congelamento read-only com histórico preservado, **não por uso zero**. **A-3 decidida: o invariante O8 vale e U6b não o renegocia.** Incorporado #497 (`@Roles('ADMIN')` não é gate administrativo). **Correção de evidência no mesmo dia:** os números que sustentavam "uso zero" vinham de `prisma/dev.db` (banco local), não de produção; medição correta no volume Fly (`fly ssh console`) dá 200 usuários, 196 tenants, **4 alocações vivas somando R$ 235.000,00 concentradas no tenant de desenvolvimento `dev-tenant-1`**, `category_budgets` 0 e **0 de 200** usuários com `financialDashboard`. **U6b (#456) segue BLOQUEADA.** |
| 2026-08-18 | B0 entregue; B1a implementado | B0 (#447) entregue via PR #476 (produção, SHA `389d8e6e`). B1a (#448) implementado e, naquela data, pendente de merge: child ACL em `settleTargetParcela`, identidades de fatura (`cardId`/`fingerprint`/`actions` em `cartoes[]`+`saidas[]`; `accountId` em `contas[]`), `cardId`/`accountId` opcionais em `payInvoice`/`undoInvoicePayment`, guard de duplicidade ativa 409, `roomId`/`sourcePriceItemId` scoped. Zero schema, zero UX, zero fórmula numérica alterada. #448 permanece OPEN. Sequência após merge de B1a: W1 → B1b → B2. |
| 2026-08-17 | Exceção PO S0.3 | #446 liberada para build/test/merge test-only independente de #445; #445 registrada como bloqueada/deferida e produção `NOT_COLLECTED`; gates conjuntos de #447/B0, limites da baseline sintética e distinção entre estado esperado e evidência de runtime explicitados. |
| 2026-08-17 | Revisão S0.1 | Guardrails de papel, endpoint/evidência e auditoria estreitados; transição do rateio legado para source-only explicitada. |
| 2026-08-17 | S0.1 inicial | Design/security consolidado no repositório; status, contratos, E0–E6, dependências, analytics, riscos, rollback, decisões e histórico canonicalizados a partir da base `ece5032c398cc050fc037959a1f8fc0cc7f05bea`. Nenhuma implementação de produto iniciada. |
