---
name: journey-qa-runbook
description: Procedimento reproduzível para QA de uma jornada real do ReformaFlow com banco isolado, desktop/mobile, screenshots, console/HTTP, duplicatas e hit-testing.
allowed-tools: Read, Glob, Grep, Bash
---

# Runbook de QA de jornada

## Entrada

Receba:

- jornada em linguagem de negócio;
- resultado esperado;
- branch/SHA;
- projeto/tipo necessário;
- se exige conta nova, antiga ou configuração admin.

Não receba o diff como guia de cliques.

## 1. Preparar ambiente isolado

```bash
cp prisma/dev.db /tmp/dev.qa-<slug>.db
```

Escolha portas exclusivas. Inicie a API apontando explicitamente para a cópia e valide:

```bash
lsof -p <pid> | grep '\.db'
```

Critério: somente `/tmp/dev.qa-<slug>.db`. Se aparecer o `dev.db` real, encerre o PID e aborte.

Para o web, use `.env.local` somente no worktree QA:

```text
NEXT_PUBLIC_API_URL=http://localhost:<api-port>
```

Remova o arquivo antes de rodar Playwright/Vitest da suíte.

## 2. Executar a jornada

Execute em 390×844 e 1280×800:

1. cadastro/login real;
2. criação/seleção do projeto;
3. abertura da funcionalidade;
4. todos os passos intermediários;
5. confirmação;
6. tela final;
7. reload/resume se a jornada persistir estado.

## 3. Coletar evidência

Em cada tela relevante:

- screenshot;
- URL;
- `document.title`;
- console errors;
- respostas HTTP 4xx/5xx;
- rótulos dos botões;
- caixas de CTAs;
- elemento no topo do ponto clicável.

Snippets:

```js
const labels = [...document.querySelectorAll('button')]
  .map((button) => button.textContent?.trim())
  .filter(Boolean);
const repeated = labels.filter((label, index) => labels.indexOf(label) !== index);
```

```js
const rect = element.getBoundingClientRect();
const top = document.elementFromPoint(
  rect.left + rect.width / 2,
  rect.top + rect.height / 2,
);
const clickable = top === element || element.contains(top);
```

## 4. Regressão antes/depois

1. Crie a conta/dados uma vez na cópia.
2. Duplique essa cópia para “antes” e “depois”.
3. Mantenha viewport e script iguais.
4. Troque apenas o checkout/SHA.
5. Compare dados mensuráveis e screenshots.

## 5. Limpeza

- mate apenas PIDs conhecidos;
- remova scripts, logs, `.env.local` e DBs temporários;
- preserve screenshots;
- confirme `git status --short`.

## Gate

PASS exige:

- zero 404/500 inexplicados;
- zero exceção de console;
- zero ação duplicada;
- CTA primário visível, ≥44px em mobile e clicável;
- tenant/projeto corretos;
- fluxo concluído;
- screenshots citados.

