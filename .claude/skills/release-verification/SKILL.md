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
lock, o job comparou o SHA completo do run com o SHA completo atual de `main` imediatamente antes do
deploy e novamente depois dos checks/smokes. Run stale deve terminar sem publicar no primeiro gate;
se `main` avançou durante o deploy, o gate pós-smokes deve falhar. Ausência de qualquer gate é
`BLOCKED`.

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
- release mais recente `complete`, com `ImageRef` igual a `machine.config.image` depois de remover o
  sufixo `@digest` da imagem da machine.

Machine `stopped` ou qualquer divergência é `BLOCKED`, mesmo com workflow/deploy verde. O SHA já está
nos labels de `image_ref`: não crie `/health` nem build arg para expô-lo.

## 4. Migration

Confirme no job/log do Fly que o entrypoint executou `prisma migrate deploy`. Para migration nova,
confirme o nome explicitamente. Banco fresco não cobre upgrade: exija fixture legada estruturalmente
equivalente ou backup sanitizado, restore testado e inventário antes/depois.

Em recuperação de migration falha, verifique a sequência: backup restaurável; API quiescida sem
writers pelo fail-safe nativo (`deploy/quiesce/`); extração de **três** arquivos do HEAD exato do PR
testado — `deploy/quiesce/watchdog.sh`, `deploy/quiesce/op-wrap.sh` e
`scripts/normalize-external-id-duplicates.mjs` —, checksum SHA-256 local↔remoto de cada um, transferência
para um diretório persistente único no volume (e.g. `/data/quiesce-<RECOVERY_RUN>` com timestamp), e só
com os três idênticos armar a machine com `init.cmd = ["sh","${QUIESCE_DIR}/watchdog.sh"]` e
`--skip-health-checks` (o watchdog não serve HTTP). Não copie o repositório nem instale dependências:
`createRequire` resolve o `@prisma/client` existente em `/app/node_modules`.

**Todo acesso à machine passa pelo `op-wrap`** (em `${QUIESCE_DIR}/op-wrap.sh`, passado como
`QUIESCE_DIR=... sh ${QUIESCE_DIR}/op-wrap.sh {dryrun|apply|disarm|status}`) — nunca `node /app/normalize-external-id-duplicates.mjs` direto,
nunca `sqlite3`/`prisma studio` manual. `op-wrap dryrun` escolhe um caminho novo de manifest sob
`$QUIESCE_DIR` e a cadeia supervisionada publica `$QUIESCE_DIR/manifest.current` **apenas se o normalizer
sair com 0** (fail-closed). `op-wrap apply <hash> <expected-groups> <expected-updates>` reutiliza esse
mesmo manifest e roda `--apply && prisma migrate resolve --rolled-back && prisma migrate deploy` numa
cadeia única. Todo download/limpeza lê o caminho de `$QUIESCE_DIR/manifest.current` — não há protocolo de
manifest em `/tmp`. A quiescência começa antes do dry-run final e permanece até `migrate deploy`;
qualquer write invalida o manifest e exige reinício no dry-run. Depois de preservar a evidência e a
cópia local `0600`, confirme que o encerramento removeu da machine, sem wildcard, os três scripts, o
manifest e `$QUIESCE_DIR`.

O manifest é **CONFIDENCIAL**, arquivo regular `0600`, e contém IDs e chaves de escopo. Nunca o anexe
ou publique. O hash completo emitido pelo script também fica na operação privada; evidência pública
leva apenas contagens e hash truncado, nunca PII, caminho completo do backup, IDs/chaves ou hash
completo. Enquanto a migration falha não estiver resolvida e aplicada, restaurar o entrypoint normal
é `BLOCKED`. Fora de uma recuperação explicitamente autorizada, a verificação continua read-only e
não escreve em produção.

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
