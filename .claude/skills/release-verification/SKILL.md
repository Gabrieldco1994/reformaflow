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
Use sempre o SHA completo, sem prefixo abreviado.

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

O lock de concorrência evita sobreposição, mas não garante ordem. Confirme no log que, já dentro do
lock e imediatamente antes do deploy, o job comparou o SHA completo do run com o SHA completo atual
de `main`. Run stale deve terminar sem publicar; job verde que publicou SHA stale é `BLOCKED`.

## 3. Verificar API e web

Faça smokes de rotas conhecidas:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://reformaflow-api.fly.dev/api/docs-json
curl -s -o /dev/null -w '%{http_code}\n' https://reformaflow-api.fly.dev/auth/me
curl -sL -o /dev/null -w '%{http_code}\n' https://reformaflow.vercel.app/login
```

Exija 200 em `/api/docs-json` e 401 em `/auth/me`. Em rota protegida, 401 prova que existe e está
protegida; 404 indica rota ausente. Use o método HTTP real do controller.

Com `flyctl` 0.4.76, exija conjuntamente:

- `machine list` com comprimento exatamente 1 e `state=started`;
- `.[0].image_ref.labels.GH_SHA == GITHUB_SHA`;
- `checks list` com exatamente um check `passing`, ligado ao ID dessa machine;
- release mais recente `complete`, com `ImageRef == machine.config.image`.

Machine `stopped` ou qualquer divergência é `BLOCKED`, mesmo com workflow/deploy verde. O SHA já está
nos labels de `image_ref`: não crie `/health` nem build arg para expô-lo.

## 4. Migration

Confirme no job/log do Fly que o entrypoint executou `prisma migrate deploy`. Para migration nova,
confirme o nome explicitamente. Banco fresco não cobre upgrade: exija fixture legada estruturalmente
equivalente ou backup sanitizado, restore testado e inventário antes/depois.

Em recuperação de migration falha, verifique a sequência: backup restaurável; script em `--dry-run`;
manifest sanitizado revisado; `--apply`; novo dry-run sem pendências; `prisma migrate resolve` coerente
com o estado real; `prisma migrate deploy`; e só então restauração do entrypoint migrate-first. O
manifest não deve expor IDs, PII, caminho completo de backup nem hash completo. Enquanto a migration
falha não estiver resolvida e aplicada, restaurar o entrypoint normal é `BLOCKED`. Fora de uma
recuperação explicitamente autorizada, a verificação continua read-only e não escreve em produção.

Depois da migration, restaurar o entrypoint é operação SRE por machine:
`flyctl machine update <machine-id> --machine-config '{"init":{"entrypoint":null,"cmd":null}}' --yes`.
Não altere `fly.toml` para adicionar `[processes] app="/entrypoint.sh"`: após limpar o override, o
Dockerfile `CMD` governa; `http_service.processes = ["app"]` já é suficiente.

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
fly_machine:
fly_health:
deployed_sha:
fly_release:
fly_image_ref:
vercel:
migration:
migration_manifest:
entrypoint:
smokes:
journey:
rollback_sha:
```
