# Landscape de agentes e skills — ReformaFlow

Atualizado em: **2026-08-05**

## 1. Objetivo deste documento

Este é o mapa canônico de:

- quais agentes e skills existem no repositório;
- quando usar cada um;
- quais lacunas existem no ciclo de vida do produto;
- quais agentes/skills devem ser criados;
- como combinar os papéis do pedido inicial até produção;
- como refazer esta auditoria sem confiar numa fotografia antiga.

> Este documento é uma **fotografia orientativa**, não uma nova fonte de verdade
> para listas mutáveis. Features, módulos, exceções Prisma e estado de deploy
> devem sempre ser lidos das fontes vivas indicadas na seção 12.

Na base desta revisão (`f1469959`), havia **22 agentes canônicos** em
`.claude/agents/`, todos em kebab-case e com `name` igual ao nome do arquivo, e
**7 skills versionadas** antes desta atualização. Agente é um papel despachável;
skill é um procedimento reutilizável; lente é um agente que avalia a mudança do
ponto de vista de um domínio/usuário; gate é uma dependência executável da CI.
Essas categorias não são intercambiáveis.

Esta revisão adiciona três experience owners read-only, totalizando **25 agentes**.
Eles decidem contratos e devolvem handoff ao Fleet PO; builders e verificadores
continuam sendo papéis separados.

## 2. Resumo executivo

O ReformaFlow já é uma plataforma ampla:

- monorepo Turbo com Next.js, NestJS, Prisma/SQLite e pacote de domínio;
- 50 modelos Prisma e 62 migrations na fotografia de 2026-08-03;
- mais de 40 módulos de API e 30 superfícies por projeto no web;
- multi-tenant, cadastro público, administração, jornadas, finanças, IA, voz,
  OCR, plantas e seis tipos de projeto;
- testes de domínio, API, web e Playwright;
- deploy automático da API no Fly e do web no Vercel.

O conjunto atual é forte para **projetar e escrever código**, mas ainda tem
lacunas para **operar um SaaS completo**:

| Área | Maturidade atual |
|---|---|
| Arquitetura e implementação | Forte |
| Regras financeiras | Forte |
| Testes unitários/integrados | Forte |
| QA da jornada real | Parcial |
| Segurança multi-tenant | Parcial |
| Release e pós-deploy | Fraco |
| Observabilidade da API | Fraco |
| Analytics de produto | Inicial |
| Suporte e resposta a incidentes | Inicial |
| Monetização/planos/assinaturas | Não implementado |
| Governança dos próprios agentes | Fraca |

**Direção recomendada:** consolidar o uso dos papéis já criados, manter o E2E
bloqueante, eliminar instruções duplicadas/obsoletas e fechar as lacunas
operacionais e de observabilidade ainda verificadas.

## 3. Arquitetura operacional atual

### 3.1 Orquestração

| Agente/skill | Responsabilidade | Quando usar |
|---|---|---|
| `fleet-po` | Coordena várias frentes, worktrees e PRs; verifica relatos; decide titularidade e ordem | Vários agentes/PRs simultâneos |
| `wizard` | Orquestra uma entrega complexa do entendimento ao PR | Feature, bug ou refactor multi-arquivo |
| `issue-maintainer` | Issues, épicos, labels e ledger de acceptance criteria | Antes da execução e no merge |

Regra:

- **Wizard** coordena uma entrega complexa.
- **Fleet PO** coordena várias entregas/Wizards em paralelo.
- O PO humano decide produto e faz o merge final.

### 3.2 Matriz canônica de ownership das experiências

Esta é a única matriz para escolher o owner primário de uma mudança de
experiência. Cada mudança tem **um** owner primário; os canais afetados entram
como owners secundários consultados. Fleet PO garante um owner por branch e por
arquivo.

| ID | Owner primário | Canais afetados | Consulta/lens viva | Plataforma/guardiões | Implementadores | Avaliadores/gates | Critério de conclusão |
|---|---|---|---|---|---|---|---|
| `web-desktop` | `web-experience-owner` | Browser/desktop; canais tocados são secundários | Issue + lens aplicável no registry | Impacto no diff; guardião aplicável no registry | Builder do módulo afetado | Harness Web + gates vivos do módulo | Decisão/handoff e gates PASS |
| `mobile-pwa` | `mobile-experience-owner` | `apps/web` em 375/390/PWA; Web é secundário quando compartilhado | Issue + lens aplicável no registry | Manifest/SW/permissões/release; guardião aplicável no registry | Builder de `apps/web` afetado | Harness Mobile + gates vivos do módulo | Decisão/handoff e gates PASS |
| `maria-cross-channel` | `maria-ai-owner` | Chat/voz e canais tocados; seus owners são secundários | Issue + lens e owners de canal no registry | Provider/model/tool/privacidade/release; guardião aplicável no registry | Builder do módulo afetado | Harness Maria + gates vivos de AI/Security/Journey | Baseline × candidate quando exigido e gates PASS |
| `multi-channel` | `maria-ai-owner` | Todos os canais declarados na issue; owners afetados são secundários | Issue + lens e owners de canal no registry | Impactos combinados; guardião aplicável no registry | Builders dos módulos afetados | Harnesses dos owners + gates vivos combinados | Um handoff, ownership de arquivo e gates PASS |
| `platform-only` | `fleet-po` | Nenhum por padrão; canal impactado é consultado | Issue + lens aplicável no registry | Impacto central; guardião aplicável no registry | Builder da plataforma afetada | Gates vivos de plataforma/release | Evidência de plataforma e gates PASS |

`Registry` significa o frontmatter vivo em [`.claude/agents/`](../.claude/agents/), não um roster
copiado. `Gates vivos` são os testes, scripts e runbooks apontados pelo owner e pelo módulo afetado.

Precedência obrigatória para casos sobrepostos:

1. `platform-only`;
2. Maria;
3. Mobile/PWA;
4. o restante é Web.

Os owners decidem e devolvem decisão/handoff ao Fleet PO. Não implementam, não
fazem auto-QA e não chamam subagentes.

Autoridades: o PO decide produto/merge; Fleet PO decide prioridade, owner,
branch, ordem e conflitos; lentes cobrem as regras de negócio; builders
existentes implementam; QA, Journey QA, AI Quality e Security verificam; Platform
SRE opera release. Finding blocking de Security continua blocking, e qualquer
mudança de número financeiro escala ao PO.

### 3.3 Design, implementação e verificação

| Agente | Responsabilidade | Quando usar |
|---|---|---|
| `architect` | Mapa do subsistema, invariantes, concorrência e especificação RED | Dinheiro, schema, auth, concorrência ou múltiplos módulos |
| `backend-expert` | NestJS, Prisma, migrations, regras, jobs e autorização | Mudança server-side |
| `frontend-expert` | Next.js, React, formulários, navegação, estado e responsividade | Mudança visível/client-side |
| `qa-engineer` | Testes, mutation mindset e cobertura dos critérios | Durante e depois da implementação |
| `journey-qa` | QA independente da aplicação rodando | Mudança visível, onboarding, importação, voz, navegação e lote de PRs |
| `platform-sre` | Release guardian, incident response e recovery | Migration, release, incidente e pós-deploy |
| `doc-librarian` | Documentação normativa, manual e índice | Mudança observável ou de regra |

`qa-engineer` valida código e testes. Ele **não substitui** QA da aplicação
rodando no navegador.

### 3.4 Lentes de domínio existentes

- `pessoal-lens`
- `reforma-lens`
- `compra-lens`
- `casa-lens`
- `carro-lens`
- `plantas-lens`
- `domain-user-lens` — template, não agente pronto

Todos os seis tipos de projeto têm lente própria. Essas lentes endurecem
requisitos antes do código e verificam o diff depois do GREEN. Elas não executam
a aplicação. As lentes transversais (`security-tenant-lens`, `new-user-lens`,
`admin-owner-lens` e `product-analytics-lens`) cobrem riscos que atravessam tipos
de projeto.

## 4. Skills atuais

### 4.1 Versionadas

| Skill | Uso |
|---|---|
| `wizard` | Ciclo completo para tarefa complexa |
| `agent-landscape-audit` | Refazer este landscape a partir das fontes vivas |
| `agent-contract-audit` | Detectar drift e duplicidade nos agentes/skills |
| `journey-qa-runbook` | Executar QA real com banco isolado e evidência runtime |
| `multi-agent-runtime` | Ativar e verificar descoberta do runtime multiagente |
| `release-verification` | Provar SHA, checks, deploy, migration e smoke |
| `repo-hygiene` | Auditar e reduzir branches/worktrees com segurança |
| `browser-use` | Navegação, formulário, screenshots e inspeção de runtime |
| `frontend-design` | Direção visual para UI nova/redesign |

As duas últimas foram promovidas nesta atualização. `browser-use` inclui as duas
referências relativas e não contém segredo; a integração cloud requer chave
apenas quando usada. `frontend-design` inclui sua licença referenciada.

### 4.2 Disponível localmente, mas bloqueada para versionamento

| Skill | Uso |
|---|---|
| `excalidraw-diagram` | Diagramas técnicos e de fluxo; pacote local incompleto |

`excalidraw-diagram` não foi copiada parcialmente: seu `SKILL.md` exige
`README.md`, `references/color-palette.md`, `references/element-templates.md`,
`references/render_excalidraw.py` e o ambiente `uv` da pasta `references/`, mas
nenhum desses arquivos existe no diretório local inspecionado. Até recuperar o
pacote completo, ela continua não portável por clone limpo.

## 5. Lacunas verificadas

### P0 — E2E bloqueia build/deploy ✅

Até o PR #399, `e2e-web` rodava em paralelo, mas os builds não dependiam dele.
Desde o merge `147c276c`, `build-web` e `build-api` incluem `e2e-web` em `needs`;
o deploy depende dos dois builds. Portanto:

> E2E vermelho bloqueia os builds e, por consequência, o deploy.

O próprio workflow do PR provou a ordem: Playwright terminou antes de ambos os
builds iniciarem.

### P0 — agentes duplicam fatos mutáveis e apodrecem

Foram encontradas divergências entre agentes e fontes reais:

- lentes de tipos com mapas de módulos antigos;
- `backend-expert` com lista incompleta de modelos sem soft-delete;
- `doc-librarian` afirmando que não existe índice de docs;
- documentação de onboarding descrevendo fluxo antigo.

Regra de arquitetura:

> Agente deve apontar para a fonte viva, não copiar listas que mudam.

Fontes:

- produto/capacidade: `PROJECT_FEATURES`;
- autorização: `TYPE_MODULES`;
- navegação: `PROJECT_NAV`;
- soft-delete: `modelsWithoutSoftDelete`;
- estado atual: Git + docs normativos.

### P0 — Fleet PO duplicado, resolvido

Na auditoria de 2026-08-03 existia um `Fleet PO.agent.md` local não versionado e
atrasado. Na fotografia atual ele não existe mais: há somente
`.claude/agents/fleet-po.md`, com `name: fleet-po`. A duplicidade fica registrada
apenas como histórico; não é lacuna ativa.

### P1 — operação de produção insuficiente

Existem Clarity, Speed Insights e error boundaries, mas não foram encontrados:

- tracing estruturado da API;
- métricas e alertas operacionais;
- Sentry/OpenTelemetry;
- backup automático e teste periódico de restore;
- release verification automatizada.

### P1 — pressão de branches/worktrees

Histórico, não estado atual: antes da limpeza de 2026-08-03 havia:

- 254 branches locais;
- 89 worktrees;
- 45 branches locais já mergeadas.

A auditoria conservadora removeu worktrees limpos que eram ancestrais de `main`
ou cujo tip era exatamente o head de um PR mergeado. O total caiu para **33**,
sem `--force`; dirty, detached e não mergeados foram preservados. Branches de
PR squash-mergeado também foram preservadas.

Fotografia final de 2026-08-04, após `fetch` de `origin/main`:

- 253 branches locais (252 antes de criar a branch desta auditoria);
- 182 entradas em `git branch -r`: 181 branches remotas mais `origin/HEAD`;
- 12 worktrees (11 antes de criar o worktree desta auditoria);
- 0 worktrees prunable;
- 40 branches locais mergeadas em `origin/main`.

Os números históricos **89 → 33** descrevem aquela limpeza, não o estado atual.

### P1 — hotspots de manutenção

Arquivos acima de 50 KB concentram risco, principalmente:

- `monthly-overview.service.ts`;
- `agent-tools.service.ts`;
- `ExpensesView.tsx`;
- `bank-account.service.ts`;
- `MovimentacoesSection.tsx`;
- `floor-plans/page.tsx`.

Refactor só deve ocorrer quando uma mudança real tocar o hotspot; não criar
programa de abstração especulativo.

## 6. Agentes recomendados

### P0 — criados

#### `journey-qa` ✅

QA independente da jornada real.

Usar em:

- qualquer mudança visível;
- onboarding;
- importação;
- voz;
- navegação;
- fluxos multi-etapa;
- lotes de PRs que interagem.

Contrato mínimo:

1. banco copiado para `/tmp` e gate `lsof`;
2. usuário criado pelo cadastro real;
3. 375/390px e desktop;
4. console errors e respostas 404;
5. contagem de elementos duplicados;
6. `getBoundingClientRect` e `elementFromPoint`;
7. screenshots antes/depois;
8. repetição no `main` combinado após merges.

#### `platform-sre` ✅

Dois modos:

- **release guardian:** CI, migrations, deploy, smoke, HEAD correto;
- **incident responder:** logs, impacto, rollback/revert, backup e postmortem.

Usar em migration, auth/tenant, release com vários PRs, incidente de produção,
uploads e jobs.

### P1 — criados

#### `security-tenant-lens` ✅

Usar em auth/JWT, cadastro, admin, tenant override, uploads, endpoints
cross-project e promoção de regras globais.

#### `ai-quality-engineer` ✅

Usar em Maria/voz, OCR, merchant classifier, plantas, Gemini e TTS.

Responsabilidades:

- datasets e evals;
- regressão de prompt/tool calling;
- JSON truncado;
- custo/tokens;
- fallback;
- segurança de conteúdo;
- comparação de versões.

#### `plantas-lens` ✅

Completa a cobertura de lentes por tipo de projeto. Cobre diagnóstico por IA,
toxicidade, espécie, imagens, manutenção, lembretes e privacidade.

#### `new-user-lens` ✅

Usar em signup, objetivos, primeiro projeto, jornada, permissões iniciais e
empty states.

#### `admin-owner-lens` ✅

Usar em `/admin/users`, editor de jornadas, tenant, regras globais, analytics,
override e ações destrutivas.

### P2 — criados

#### `product-analytics-lens` ✅

Define e verifica ativação, retenção, abandono e taxonomia de eventos.

#### `support-triage` ✅

Transforma feedback, Clarity e relato do usuário em reprodução determinística,
impacto, frequência e issue estruturada.

### Não criar ainda

Não criar agente de billing antes de existir decisão real sobre:

- planos;
- trial;
- entitlements;
- cobrança;
- cancelamento;
- upgrade/downgrade;
- inadimplência.

## 7. Skills recomendadas

### P0 — versionadas

| Skill | Função |
|---|---|
| `journey-qa-runbook` | Ambiente isolado, cadastro real, viewports, screenshots, 404/console/duplicatas |
| `release-verification` | Checks do HEAD, migrations, Fly, Vercel e smoke |
| `agent-contract-audit` | Comparar agentes com fontes canônicas e detectar drift |
| `repo-hygiene` | Inventário e limpeza conservadora de branches/worktrees |
| `multi-agent-runtime` | Ativar `/agent fleet-po`, `/fleet`, `/subagents` e verificar descoberta |

### P1

| Skill | Função |
|---|---|
| `financial-invariant-matrix` | Paga/planejada × conta/cartão/carteira × mensal/anual |
| `incident-triage` | Reprodução, logs, blast radius e revert vs fix-forward |
| `db-change-safety` | Backup, migration, generate, deploy e restore drill |

### Skills globais úteis

| Skill | Quando |
|---|---|
| `007` | Threat modeling e auditoria de segurança |
| `accesslint-scan` / `accesslint-diff` | Mudanças visíveis |
| `advanced-evaluation` | Evals de IA |
| `code-review` | Review independente |
| `fix-ci` | Checks vermelhos |
| `troubleshoot` | Comportamento inesperado da sessão |

Operações Git como commit/PR são skills utilitárias; não precisam virar agentes.

## 8. Fluxo-alvo do ciclo de vida

```text
PO
 │
 ▼
Fleet PO ─────────────── coordena iniciativas e prioridades
 │
 ▼
Issue Maintainer ─────── issue + critérios de aceite
 │
 ▼
Architect + lentes ───── requisitos, invariantes, riscos
 │
 ├── Backend Expert
 ├── Frontend Expert
 └── QA Engineer
        │
        ▼
Security / AI / Finance review (quando aplicável)
        │
        ▼
Journey QA ───────────── produto real, não componente isolado
        │
        ▼
PR + review independente
        │
        ▼
Platform SRE ─────────── deploy + smoke + migrations + rollback
        │
        ▼
Produção
 │
 ├── Support Triage
 ├── Incident Response
 └── Product Analytics
        │
        ▼
Fleet PO / próximo ciclo
```

## 9. Guia rápido de despacho

| Tipo de trabalho | Combinação recomendada |
|---|---|
| Copy simples | Frontend + teste direcionado |
| UI visível | Experience owner primário + Frontend + frontend-design + journey-qa + accesslint |
| Feature multi-arquivo | Wizard → Architect → builders → QA |
| Dinheiro/KPI | Architect + PESSOAL lens + matriz financeira + QA + aval do PO |
| Auth/tenant/admin | Architect + backend + security-tenant + 007 |
| IA/voz/OCR | Maria AI Owner + Backend/frontend + AI quality + eval |
| Migration | Backend + db-change-safety + platform-sre |
| Vários PRs | Fleet PO + QA do `main` combinado |
| Incidente em produção | Platform SRE + troubleshoot + issue-maintainer |
| Mudança observável | Doc librarian + manual no mesmo PR |

## 10. Plano de implantação do landscape

### Imediato

1. ✅ Fazer E2E bloquear deploy — PR #399 / `147c276c`.
2. ✅ Remover o Fleet PO duplicado.
3. ✅ Auditar e atualizar agentes obsoletos.
4. ✅ Criar `journey-qa`.
5. ✅ Criar `platform-sre`.
6. ✅ Versionar skills essenciais.
7. ✅ Auditar e reduzir worktrees (histórico: 89 → 33; fotografia atual: 12).

### Próximo ciclo concluído

1. ✅ Criar `security-tenant-lens`.
2. ✅ Criar `ai-quality-engineer`.
3. ✅ Criar `plantas-lens`.
4. ✅ Criar `new-user-lens`.
5. ✅ Criar `admin-owner-lens`.
6. ✅ Criar `product-analytics-lens`.
7. ✅ Criar `support-triage`.
8. ✅ Corrigir agentes/docs contra mapas reais.

### Quando entrar em comercialização

1. Taxonomia de eventos.
2. Funil de ativação/retenção.
3. Planos e entitlements.
4. Billing.
5. Suporte operacional e SLAs.

## 11. Cadência de revisão

Revisar este landscape:

- mensalmente;
- após adicionar/remover um agente ou skill;
- após incidente relevante;
- antes de iniciar um novo ciclo de produto;
- quando `PROJECT_FEATURES`, `TYPE_MODULES`, CI ou deploy mudarem;
- quando houver mais de 25 worktrees ou acúmulo de branches mergeadas.

## 12. Como refazer a auditoria

Use a skill versionada `agent-landscape-audit`.

Fontes obrigatórias:

| Assunto | Fonte canônica |
|---|---|
| Status do produto | `docs/estado-atual-cockpit-pessoal.md` + Git |
| Regras financeiras | `docs/cockpit-caixa-real.md`, `docs/visao-conta-faturas.md` |
| Capacidade por tipo | `packages/domain/src/config/project-features.ts` |
| Autorização por tipo | `packages/domain/src/config/type-modules.ts` |
| Navegação | `module-navigator.ts` |
| Soft-delete | `apps/api/src/prisma/prisma.service.ts` |
| Agentes | `.claude/agents/*.md` |
| Skills | `.claude/skills/**/SKILL.md`, `.agents/skills/**/SKILL.md` |
| CI/deploy | `.github/workflows/ci.yml`, `DEPLOY.md` |
| Tracker | `gh issue list`, `gh pr list` |
| Operação Git | `git worktree list`, branches locais/remotas |

Nunca conclua a partir do checkout compartilhado sem comparar com `origin/main`.

## 13. Veredito

O roster atual é bom para **construir software**, mas incompleto para **operar um
SaaS**.

A ordem correta agora é:

1. preservar o gate de E2E que bloqueia build e deploy;
2. impedir que os próprios agentes apodreçam;
3. despachar `journey-qa` e `platform-sre` nas mudanças aplicáveis;
4. usar as coberturas já criadas de segurança, IA e analytics;
5. só criar billing quando houver produto comercial definido.
