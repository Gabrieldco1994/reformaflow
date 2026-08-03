---
name: multi-agent-runtime
description: Activa y verifica el runtime multiagente de Copilot CLI para el roster local de ReformaFlow. Úsala cuando Fleet PO no pueda despachar subagentes o cuando se necesite comprobar agentes y skills descubiertos.
allowed-tools: Read, Glob, Grep, Bash, Agent
---

# Runtime multiagente de ReformaFlow

## Objetivo

Comprobar que Copilot CLI descubre el roster local, habilitar la ejecución paralela y diagnosticar
la diferencia entre “archivos de agentes existentes” y “herramienta de subagentes disponible”.

## Requisitos

- Copilot CLI reciente con `/fleet`, `/tasks` y `/subagents`.
- `fleet-po.md` con herramienta `Agent` y lista `agents`.
- agentes en `.claude/agents/`.
- skills en `.claude/skills/<nombre>/SKILL.md`.

## Activación interactiva

En una nueva sesión Copilot CLI:

```text
/agent fleet-po
/fleet
/subagents
/env
```

- `/agent fleet-po` selecciona el coordinador.
- `/fleet` activa la ejecución paralela.
- `/subagents` configura modelo/esfuerzo por subagente.
- `/tasks` muestra trabajos activos.
- `/env` confirma agentes, skills y herramientas cargadas.

`/fleet` es estado de la sesión; el repositorio no puede forzar un comando interactivo en una
sesión ya iniciada.

## Verificar skills

```bash
copilot skill list --json |
  jq -r '.[] | select(.source=="project") | [.name,.path] | @tsv'
```

## Verificar agente

```bash
copilot -C . --agent fleet-po -p \
  "Responde solamente FLEET_OK" --allow-all-tools --silent
```

Para comprobar subagente, pide al Fleet PO una tarea read-only que requiera `architect` y revisa
`/tasks`. No uses una mutación como prueba.

## Diagnóstico

### Agentes visibles, pero sin subagentes

1. revisar `tools: ... Agent`;
2. revisar `agents:` en Fleet PO;
3. iniciar una **nueva sesión** (las herramientas se fijan al iniciar);
4. ejecutar `/fleet`;
5. inspeccionar `/env`.

### Skills no visibles

1. nombre del folder = `name:` del frontmatter;
2. archivo exacto `SKILL.md`;
3. ubicación `.claude/skills/`, `.agents/skills/` o `.github/skills/`;
4. reiniciar la sesión después del merge/pull.

## Resultado

```text
MULTI_AGENT_READY | BLOCKED
- fleet-po discovered:
- Agent tool:
- allowed local agents:
- project skills:
- fleet mode:
- test task:
- blocker:
```

