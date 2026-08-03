---
name: agent-landscape-audit
description: Audita agentes, skills, CI, operação Git e cobertura do ciclo de vida SaaS do ReformaFlow. Use ao revisar a estrutura de agentes, após incidentes ou antes de um novo ciclo de produto.
allowed-tools: Read, Glob, Grep, Bash
---

# Auditoria do landscape de agentes e skills

## Objetivo

Atualizar `docs/landscape-agentes-skills-saas.md` com evidência do repositório
real, separando:

- agentes existentes;
- skills existentes;
- gates automatizados;
- lacunas de desenvolvimento e operação;
- recomendações por prioridade.

## Regra central

Não copie listas mutáveis para instruções sem necessidade. Compare todo texto
com a fonte canônica e prefira apontar para a fonte viva.

Exemplos:

- features → `PROJECT_FEATURES`;
- autorização → `TYPE_MODULES`;
- navegação → `PROJECT_NAV`;
- soft-delete → `modelsWithoutSoftDelete`;
- status → Git + docs normativos.

## Procedimento

### 1. Confirmar a realidade Git

```bash
git fetch origin
git status --short
git log --oneline -20 origin/main
git worktree list
git branch --merged origin/main
```

O checkout compartilhado pode estar atrasado ou sujo. Use `origin/main` para
afirmações de estrutura.

### 2. Inventariar agentes e skills

```bash
git ls-tree -r --name-only origin/main .claude/agents
git ls-tree -r --name-only origin/main .claude/skills .agents/skills
find .claude/agents -maxdepth 1 -name '*.md'
find .claude/skills .agents/skills -name SKILL.md 2>/dev/null
```

Detecte:

- arquivo duplicado com nome diferente;
- skill local ignorada pelo Git;
- agente-template tratado como pronto;
- descrição que não corresponde ao corpo.

### 3. Auditar drift de contratos

Compare os agentes com:

```bash
git show origin/main:packages/domain/src/config/project-features.ts
git show origin/main:packages/domain/src/config/type-modules.ts
git show origin/main:apps/api/src/prisma/prisma.service.ts
```

Procure especialmente:

- mapas de módulos copiados nos agentes;
- listas de exceções Prisma;
- rotas e endpoints descritos em texto;
- docs que afirmam fluxo antigo.

### 4. Mapear o ciclo de vida SaaS

Classifique a cobertura atual:

1. descoberta/roadmap;
2. issues e critérios;
3. arquitetura;
4. implementação;
5. testes;
6. QA de jornada;
7. segurança;
8. release/deploy;
9. observabilidade/incidente;
10. analytics/feedback;
11. monetização/billing;
12. documentação/governança.

Não invente maturidade. Cite arquivos, workflows, módulos e ausência de código.

### 5. Auditar CI e deploy

Leia `.github/workflows/ci.yml` como grafo:

- quais jobs bloqueiam build;
- quais bloqueiam deploy;
- E2E é dependência ou apenas paralelo;
- migration é aplicada onde;
- há smoke pós-deploy;
- o HEAD validado é o HEAD publicado.

### 6. Medir pressão operacional

```bash
git branch --format='%(refname:short)' | wc -l
git branch -r --format='%(refname:short)' | wc -l
git worktree list | wc -l
git worktree list --porcelain | grep -c '^prunable'
git branch --merged origin/main --format='%(refname:short)' | wc -l
```

Liste hotspots apenas como evidência; não recomende refactor especulativo.

### 7. Atualizar o documento

Atualize:

- data;
- snapshot;
- divergências encontradas;
- agentes atuais;
- agentes recomendados;
- skills recomendadas;
- prioridades;
- fluxo-alvo;
- matriz de despacho.

Preserve a distinção:

- **agente:** papel persistente com autoridade/limite;
- **skill:** procedimento invocável;
- **gate:** automação determinística;
- **lente:** crítico read-only de um domínio/persona.

## Critério de saída

O relatório está pronto quando:

- toda afirmação estrutural tem uma fonte viva;
- fatos obsoletos foram nomeados;
- recomendações têm prioridade e gatilho de uso;
- não há agente proposto para resolver algo que um gate determinístico deveria
  resolver;
- o plano cobre o ciclo do pedido até operação em produção.

