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
- nenhuma task S0/B0–B2/U1–U6/V0/D0/R0/A0/M0–M3/H1–H5 do programa #436 está entregue como
  implementação de produto apenas porque este SDD foi versionado.

### 2.2 APROVADO, mas não iniciado ou bloqueado

- O modelo de produto e as ondas E0–E4 estão aprovados.
- S0.1 ([#444](https://github.com/Gabrieldco1994/reformaflow/issues/444)) é somente a
  canonicalização documental.
- U6a é uma futura especificação por tipo. U6b permanece bloqueada até U6a, lenses, architect e
  aprovação explícita do PO.
- E6/H1–H5 é um envelope aprovado de hardening, mas cada item continua bloqueado por nova revisão
  architect+security e pelos gates de dados/PO/SRE aplicáveis.

**Matriz de decisão E0 — 2026-08-17**

| Item | Estado sincronizado | Dependência e limite |
|---|---|---|
| S0.1 [#444](https://github.com/Gabrieldco1994/reformaflow/issues/444) | **CONCLUÍDA (documental)** | Libera S0.2 e S0.3. |
| S0.2 [#445](https://github.com/Gabrieldco1994/reformaflow/issues/445) | **BLOQUEADA/DEFERIDA; produção `NOT_COLLECTED`** | Próxima tentativa somente após telemetria do suporte Fly e nova autorização explícita. |
| S0.3 [#446](https://github.com/Gabrieldco1994/reformaflow/issues/446) | **READY sob exceção PO; test-only em andamento** | Pode construir, testar e fazer merge sem aguardar a conclusão de #445; não toca produto/runtime. |
| B0 [#447](https://github.com/Gabrieldco1994/reformaflow/issues/447) | **BLOQUEADO** | Merge/deploy exige conjuntamente #445 concluída/revisada e #446 verde. |

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
- **ESTADO ATUAL / GAP LEGADO:** `AGENTS.md`, [estado-atual-cockpit-pessoal.md](estado-atual-cockpit-pessoal.md)
  e [manual-do-aplicativo.md](manual-do-aplicativo.md) documentam a contagem/soma agregada de
  alvos de rateio ocultos ou removidos. Esse relato continua válido para o runtime atual e deve
  ser preservado até B0/B1 serem realmente mergeados; ele não é o contrato do novo Hub.
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
S0.2 concluída/revisada + S0.3 verde → merge/deploy B0 (#447) → B1 (#448) → B2 (#449)
B2 + deploy B0 + security verify → U1 (#450) → U2 (#451)
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
| [E0 #437](https://github.com/Gabrieldco1994/reformaflow/issues/437) | **INCOMPLETA**; S0.1 concluída, S0.2 bloqueada/deferida e S0.3 READY test-only | #446 pode avançar sem #445; #445 concluída/revisada + #446 verde são gates conjuntos obrigatórios para merge/deploy de B0. |
| [E1 #438](https://github.com/Gabrieldco1994/reformaflow/issues/438) | **BLOQUEADO** | B0 → B1 → B2. Os três e security verify ficam verdes antes de UX. |
| [E2 #439](https://github.com/Gabrieldco1994/reformaflow/issues/439) | **BLOQUEADO** | B0+B1+B2 → U1 → U2; reorganização reversível de desktop/mobile. |
| [E3 #440](https://github.com/Gabrieldco1994/reformaflow/issues/440) | **BLOQUEADO** | U3/U4/U5; U6a é spec e U6b tem gate humano adicional. |
| [E4 #441](https://github.com/Gabrieldco1994/reformaflow/issues/441) | **BLOQUEADO/cross-cutting** | V0, D0, R0 e A0 acompanham as ondas, não um mutirão tardio. |
| [E5 #442](https://github.com/Gabrieldco1994/reformaflow/issues/442) | **FUTURO — NOVO PO GATE** | Maria M0 → M1 → M2 → M3, somente após U3+U4+U6b. |
| [E6 #443](https://github.com/Gabrieldco1994/reformaflow/issues/443) | **BLOQUEADO/separado** | H1–H5 exigem fresh architect+security pass; não são entregues pelo Hub. |

### 5.3 Tasks e contratos de saída

#### E0 — baseline antes do código

Decisão PO de **2026-08-17**: depois de S0.1, S0.2 e S0.3 podem avançar independentemente.
A independência vale somente para construir, testar e fazer merge de #446 test-only; #445 e #446
continuam gates conjuntos para o merge/deploy de B0.

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

- [B0 #447](https://github.com/Gabrieldco1994/reformaflow/issues/447): Auth, grants, scope e
  todos os reads financeiros são uma unidade inseparável; materializar IDs concretos, ancorar o
  PESSOAL autorizado e manter o caminho tenant-financial legado com semântica segura.
- [B1 #448](https://github.com/Gabrieldco1994/reformaflow/issues/448): identidades completas,
  parent/child ACL, releitura no commit, actions fornecidas pelo servidor e deep-links
  type-specific sem ampliar scope.
- [B2 #449](https://github.com/Gabrieldco1994/reformaflow/issues/449): Budget Allocation
  administrativo/read-only, somente ADMIN autenticado do tenant; relações legadas cross-tenant
  redigidas e bytes históricos intocados.

**STOP:** não iniciar U1–U6 até B0, B1 e B2 verdes, B0 deployado inteiro e security verify PASS.

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
- [U6a #455](https://github.com/Gabrieldco1994/reformaflow/issues/455): escrever matriz por tipo,
  capacidade, origem/finalidade, identidade, ACL e deep-link/fallback. É somente spec.
- [U6b #456](https://github.com/Gabrieldco1994/reformaflow/issues/456): **não entregue e
  bloqueada**. Só materializa o contrato U6a aprovado por architect, lenses e PO; zero fórmula,
  store, migration ou backfill não aprovados.

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
| D-002 | B0+B1+B2, deploy B0 e security verify precedem qualquer UX. | **BLOQUEADO** |
| D-003 | Fórmulas de Caixa §10, faturas/Conta, timezone e quitação cross-project não serão reescritas. | Contratos atuais **ENTREGUES**; mudança do programa **NENHUMA** |
| D-004 | Navegação alvo: Hoje, Movimentações, Planejamento, Projetos; Resultado/Auditoria secundários. | **APROVADO — NÃO INICIADO** |
| D-005 | Planning e Planejador só se agrupam visualmente; stores permanecem separados. | **APROVADO — BLOQUEADO** |
| D-006 | Budget sai do discovery e fica ADMIN/read-only com histórico preservado. | **APROVADO — BLOQUEADO em B2** |
| D-007 | Mobile 375/390/desktop e acessibilidade são contrato de merge. | **APROVADO — BLOQUEADO** |
| D-008 | Analytics usa Clarity existente e allowlist sem conteúdo financeiro. | **APROVADO — BLOQUEADO em A0** |
| D-009 | U6b só existe depois de U6a+lenses+architect+PO. | **BLOQUEADO; NÃO ENTREGUE** |
| D-010 | Maria agent-first reutiliza serviços/cards/actions/ACLs e requer novo PO gate. | **FUTURO; NÃO ENTREGUE** |
| D-011 | H1–H5 ficam separados e gated; não entram automaticamente no critical path. | **BLOQUEADO; NÃO ENTREGUE** |
| D-012 | Sob exceção PO de 2026-08-17, #446 pode avançar test-only sem #445; #445 concluída/revisada + #446 verde seguem obrigatórias para merge/deploy de B0. Produção permanece `NOT_COLLECTED`. | **S0.3 EM ANDAMENTO; E0 INCOMPLETA; B0 BLOQUEADO** |

## 12. Changelog

| Data | Versão | Mudança |
|---|---|---|
| 2026-08-17 | Exceção PO S0.3 | #446 liberada para build/test/merge test-only independente de #445; #445 registrada como bloqueada/deferida e produção `NOT_COLLECTED`; gates conjuntos de #447/B0, limites da baseline sintética e distinção entre estado esperado e evidência de runtime explicitados. |
| 2026-08-17 | Revisão S0.1 | Guardrails de papel, endpoint/evidência e auditoria estreitados; transição do rateio legado para source-only explicitada. |
| 2026-08-17 | S0.1 inicial | Design/security consolidado no repositório; status, contratos, E0–E6, dependências, analytics, riscos, rollback, decisões e histórico canonicalizados a partir da base `ece5032c398cc050fc037959a1f8fc0cc7f05bea`. Nenhuma implementação de produto iniciada. |
