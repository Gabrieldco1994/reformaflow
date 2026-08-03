---
name: release-verification
description: Verifica se o SHA testado foi realmente publicado no Fly/Vercel, se migrations rodaram e se produção responde aos smokes esperados.
allowed-tools: Read, Glob, Grep, Bash
---

# Verificação de release

## 1. Fixar o SHA esperado

```bash
git fetch origin
git rev-parse origin/main
git log --oneline -1 origin/main
```

Nunca valide um workflow apenas pelo nome; compare `headSha`.

## 2. Verificar workflow do main

```bash
gh run list --branch main --limit 5 --json databaseId,headSha,status,conclusion,displayTitle
gh run view <run-id> --json jobs
```

Exija:

- lint/typecheck;
- testes domínio/API/web;
- E2E Playwright;
- builds;
- deploy API.

`skipping` é aceitável para deploy em PR, não para o push publicado em `main`.

## 3. Verificar API e web

Faça smokes de rotas conhecidas:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://reformaflow-api.fly.dev/auth/me
curl -sL -o /dev/null -w '%{http_code}\n' https://reformaflow.vercel.app/login
```

Em rota protegida, 401 prova que existe e está protegida; 404 indica rota ausente. Use o método
HTTP real do controller.

## 4. Migration

Confirme no job/log do Fly que o entrypoint executou `prisma migrate deploy`. Para migration nova,
confirme o nome explicitamente. Não escreva no DB de produção durante verificação.

## 5. Jornada pós-deploy

Execute o `journey-qa-runbook` no ambiente publicado para a principal jornada alterada. Para fluxo
autenticado, use conta de QA autorizada; nunca dados de cliente.

## Saída

```text
READY | BLOCKED
expected_sha:
workflow_head_sha:
checks:
fly:
vercel:
migration:
smokes:
journey:
rollback_sha:
```

