---
name: agent-contract-audit
description: Detecta drift entre agentes/docs e as fontes canônicas do ReformaFlow, além de arquivos de agente duplicados ou skills não portáveis.
allowed-tools: Read, Glob, Grep, Bash
---

# Auditoria de contratos dos agentes

## Fontes canônicas

- capacidade: `PROJECT_FEATURES`;
- autorização: `TYPE_MODULES`;
- navegação: `PROJECT_NAV`;
- soft-delete: `modelsWithoutSoftDelete`;
- docs: `docs/README.md`;
- estado: `origin/main`.

## Passos

### 1. Inventário

```bash
git ls-tree -r --name-only origin/main .claude/agents .claude/skills
find .claude/agents -maxdepth 1 -type f
find .claude/skills -name SKILL.md
```

### 2. Nome canônico

Todo agente:

- arquivo `<name>.md`;
- kebab-case minúsculo;
- `name:` igual ao arquivo;
- sem cópia com espaço, maiúscula ou `.agent.md`.

Liste colisões por nome normalizado (lowercase, sem espaço/hífen/sufixo).

### 3. Fatos mutáveis

Procure listas copiadas:

```bash
grep -R \"PROJECT_FEATURES\\|TYPE_MODULES\\|modelsWithoutSoftDelete\" .claude/agents
```

Aceitável: ponteiro para fonte. Suspeito: lista literal que pretende estar atualizada.

### 4. Links e skills

- skill `name:` deve igualar a pasta;
- todo caminho citado deve existir em `origin/main`;
- skill essencial não pode morar apenas em `.agents/` ignorado.

### 5. Gate determinístico

Quando o script já estiver exposto no `package.json`, execute o gate determinístico sem reproduzir
sua lógica nesta skill:

```bash
npm run test:agent-contracts
```

Até ele existir, reporte a ausência; não simule sucesso nem crie uma implementação paralela.

### 6. Relatório

```text
PASS | GAPS
- duplicate agents:
- stale copied contracts:
- broken paths:
- local-only skills:
- docs/code mismatches:
- proposed owner:
```

Não corrija automaticamente fatos cujo comportamento de produto seja ambíguo; reporte ao
orquestrador.
