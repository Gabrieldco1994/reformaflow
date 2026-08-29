---
name: release-verification
description: Verifica se o SHA testado foi publicado, se a API e as migrations bateram e se a recuperação segue o protocolo canônico.
allowed-tools: Read, Glob, Grep, Bash
---

# Verificação de release

## 1. Fixar o SHA esperado

```bash
git fetch origin
EXPECTED_SHA="$(git rev-parse origin/main)"
git log --oneline -1 "$EXPECTED_SHA"
```

Sempre compare o SHA completo, nunca abreviado.

## 2. Verificar o workflow do main

Exija `deploy-api`, gates de stale-run antes e depois do deploy, `cancel-in-progress: false` e
`headSha == EXPECTED_SHA` no run hospedado.

## 3. Verificar API, machine e checks

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://reformaflow-api.fly.dev/api/docs-json
curl -s -o /dev/null -w '%{http_code}\n' https://reformaflow-api.fly.dev/auth/me
```

Exija `200` em `/api/docs-json` e `401` em `/auth/me`; não use `curl -f` para a rota autenticada.

```bash
MACHINE_JSON="$(flyctl machines list --json --app reformaflow-api)"
printf '%s\n' "$MACHINE_JSON" | jq -e --arg id "$MACHINE_ID" --arg sha "$EXPECTED_SHA" '
  length == 1 and
  .[0].id == $id and
  .[0].state == "started" and
  (.[0].config.init.entrypoint // null) == null and
  (.[0].config.init.cmd // null) == null and
  .[0].image_ref.labels.GH_SHA == $sha
'

CHECKS_JSON="$(flyctl checks list --json --app reformaflow-api)"
printf '%s\n' "$CHECKS_JSON" | jq -e --arg id "$MACHINE_ID" '
  has($id) and (keys | length == 1) and (.[$id] | length == 1) and (.[$id][0].status == "passing")
'
```

Confirme também a release mais recente `complete` e o `ImageRef` normalizado contra `machine.config.image`.

## 4. Migration recovery autorizada

1. Faça backup restaurável e valide o restore.
2. Arme uma `QUIESCE_DIR` única e timestampada em `/data/quiesce-<RECOVERY_RUN>`.
3. Use `--skip-health-checks` só no update que arma `watchdog.sh`.
4. Depois do arm, transfira `scripts/normalize-external-id-duplicates.mjs` para
   `/app/normalize-external-id-duplicates.mjs` e só então rode `op-wrap dryrun`.
5. O `op-wrap` é o único caminho de máquina; o manifest fica em `$QUIESCE_DIR/manifest.current`
   apenas se o normalizer sair `0`. Não existe protocolo de manifest em `/tmp`.
6. Se a verificação pós-arm falhar, restaure o Node-direct antes de sair; não deixe a API
   quiescida até TTL.
7. Depois de `apply` retornar `rc 0` e os índices serem validados, limpe `init` **sem**
   `--skip-health-checks` e espere a machine ficar saudável.
8. Registre evidência com `flyctl logs --no-tail --machine "$MACHINE_ID"`; não use grep inventado.
9. A limpeza final remove apenas paths exatos com `rm -f --`, depois `rmdir`; qualquer sobra
   inesperada deve fazer o `rmdir` falhar.

## Saída

```text
READY | BLOCKED
expected_sha:
workflow_head_sha:
fly_machine:
fly_checks:
fly_release:
migration:
smokes:
cleanup:
```
