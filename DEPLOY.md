# Deploy gratuito — ReformaFlow

> **Deploy canônico é automático:** push no `main` roda o CI (`.github/workflows/ci.yml`) que testa, builda e faz `flyctl deploy` da API (job **Deploy API to Fly**); o web acompanha via Vercel. Antes de publicar, o job deve rejeitar SHA stale dentro do lock de deploy; depois, deve comprovar machine iniciada, health e SHA publicado. Os passos manuais abaixo servem para o **setup inicial** (criar app/volume/secrets) ou para deploy de emergência — no dia a dia, mergear no main já publica.

Stack escolhido (zero migração de DB, custo R$ 0/mês para uso pessoal/demo):

| Camada | Onde |
|---|---|
| **Web (Next.js)** | Vercel |
| **API (NestJS) + SQLite + uploads/** | Fly.io com volume persistente |

Sem cold-start. O DB e os arquivos enviados ficam num **volume Fly de 3 GB** (free) montado em `/data`.

---

## Passo 1 — Pré-requisitos

```bash
# Fly CLI
brew install flyctl   # ou: curl -L https://fly.io/install.sh | sh
flyctl auth signup    # ou: flyctl auth login

# Vercel CLI (opcional, dá pra fazer pela UI)
npm i -g vercel
vercel login
```

Você também vai precisar:

- Conta no GitHub (push do repo)
- Cartão no Fly.io (zera no free tier, mas exige cadastro)

---

## Passo 2 — Deploy da API (Fly.io)

A partir da **raiz do repo**:

```bash
# 1) Criar app + volume (uma vez só)
flyctl apps create reformaflow-api --org personal
flyctl volumes create reformaflow_data --region gru --size 3 --app reformaflow-api

# 2) Configurar secrets (NUNCA commitar)
flyctl secrets set --app reformaflow-api \
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  ADMIN_USERNAME="<seu-usuario-admin>" \
  ADMIN_PASSWORD="<senha-forte-aqui>" \
  CORS_ORIGIN="https://SEU-DOMINIO.vercel.app"

# (opcional) IA de plantas
flyctl secrets set --app reformaflow-api GEMINI_API_KEY="..."

# 3) Deploy
flyctl deploy --app reformaflow-api -c apps/api/fly.toml --dockerfile apps/api/Dockerfile
```

Depois do deploy a API fica em **`https://reformaflow-api.fly.dev`**. Testa:

```bash
curl -sI https://reformaflow-api.fly.dev/api/docs
```

> Se mudar o nome do app no `fly.toml`, ajuste em todos os comandos acima.

### Migrations
O `entrypoint.sh` normal roda `prisma migrate deploy` antes de iniciar o NestJS. Portanto, migration
falha impede a API de subir; job de deploy verde, sozinho, não prova que a aplicação ficou disponível.

Antes de publicar uma migration sobre schema persistido:

1. valide o caminho de upgrade sobre fixture legada estruturalmente equivalente ou cópia sanitizada
   de backup, além do teste em banco fresco;
2. crie backup restaurável e teste o restore;
3. confirme inventário antes/depois e que o entrypoint normal termina com a API saudável.

#### Runbook de recuperação de migration falha

O CLI-fonte é `node scripts/normalize-external-id-duplicates.mjs`; como a imagem runtime não contém
`scripts/`, na machine ele será executado como `node /app/normalize-external-id-duplicates.mjs`,
sempre com `DATABASE_URL` explícita. O manifest gerado é **CONFIDENCIAL**, modo `0600`: contém IDs de
linhas e chaves de tenant/projeto/external ID. Nunca o anexe a issue/PR, publique, copie para logs ou
inclua em evidência. O script emite o SHA-256 completo para a operação privada; o resumo público pode
conter somente contagens e hash truncado, sem PII, caminho completo de backup, IDs/chaves ou hash
completo.

1. **Conter:** mantenha o entrypoint temporário sem migration; não restaure ainda o
   `prisma migrate deploy` automático.
2. **Backup:** gere backup timestampado, valide que pode ser restaurado e registre sua referência
   sanitizada em controle operacional separado; não altere o formato canônico do manifest.
3. **Quiescer (fail-safe nativo, `deploy/quiesce/`):** a janela **não** depende de o processo do
   operador continuar vivo. Substitua o comando da machine por `watchdog.sh` (mesmo caminho vetado de
   envio do script de recovery — ver passo 4). O `watchdog.sh` usa só `timeout` + `setsid` + `flock`:
   grava um **deadline absoluto uma única vez** em `/data/quiesce/deadline` (restart relê, nunca
   renova; restart com lock livre **colapsa** a janela e devolve o Node na hora), roda a cadeia do
   operador sob um **supervisor fora do process group da cadeia** que segura o `flock` (fd 9) durante
   toda a vida da cadeia e de qualquer descendente, e ao fim faz **TERM grupo → grace → KILL grupo**
   apenas do pgid conhecido (recolhe órfãos reparentados que o `timeout` deixa). O Node-direto só sobe
   **depois de adquirir esse mesmo lock** — Node e uma cadeia viva nunca tocam `/data/dev.db` juntos.
   Nada mais é sinalizado; o watchdog só mata um process group que ele mesmo criou.

   **NUNCA abra `sqlite3`, `prisma studio`, `node` ou qualquer cliente de banco na machine fora do
   `op-wrap` enquanto a janela estiver armada.** O lock só protege a cadeia supervisionada e o
   Node-direto; um writer manual fura o lock e pode corromper a recuperação. Todo toque no banco passa
   por `op-wrap dryrun` / `op-wrap apply`.

   Toda operação vai pelo `op-wrap` (`flyctl ssh console --command "sh /app/op-wrap.sh <cmd>"`), que
   publica o controle atomicamente (lock de publish + tmp+rename) e **recusa** sobrescrever um `RUN`
   já enfileirado:
   - `op-wrap status`
   - `op-wrap dryrun` — enfileira o dry-run e imprime o **caminho de manifest novo** desta tentativa
   - `op-wrap apply <sha256> <expected-groups> <expected-updates>` — valida `^[0-9a-f]{64}$` e
     `^[0-9]+$` antes de publicar `normalize --apply && migrate resolve && migrate deploy`
   - `op-wrap disarm` — pós-deploy: Node-direto assim que o lock ficar livre

   Não existe verbo para "cancelar uma cadeia em andamento": o `timeout` dentro do supervisor é a
   única cancelação automática.

   Se houver qualquer write fora do `op-wrap` ou perda de quiescência, descarte a aprovação e reinicie
   pelo dry-run. Detalhes e invariantes: `deploy/quiesce/README.md`.
4. **Transferir somente o script testado:** a imagem runtime não contém `scripts/`. Defina localmente
   os placeholders abaixo, usando o HEAD exato do PR que passou nos testes e o ID da única machine já
   quiescida:

   ```bash
   PR_HEAD_TESTADO="<sha-completo-testado>"
   MACHINE_ID="<id-da-unica-machine>"
   RECOVERY_RUN="$(date -u +%Y%m%dT%H%M%SZ)"
   PRIVATE_DIR="<diretorio-privado>"
   LOCAL_SCRIPT="/tmp/normalize-external-id-duplicates.mjs"
   REMOTE_SCRIPT="/app/normalize-external-id-duplicates.mjs"
   QUIESCE_DIR="/data/quiesce"
   LOCAL_MANIFEST="$PRIVATE_DIR/recovery-manifest-private-$RECOVERY_RUN.json"

   git show "${PR_HEAD_TESTADO}:scripts/normalize-external-id-duplicates.mjs" > "$LOCAL_SCRIPT"
   chmod 0500 "$LOCAL_SCRIPT"
   LOCAL_SHA="$(shasum -a 256 "$LOCAL_SCRIPT" | awk '{print $1}')"
   install -d -m 0700 "$PRIVATE_DIR"

   flyctl ssh sftp put "$LOCAL_SCRIPT" "$REMOTE_SCRIPT" \
     -a reformaflow-api --machine "$MACHINE_ID" --mode 0500
   REMOTE_SHA="$(flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "sha256sum /app/normalize-external-id-duplicates.mjs" | awk '{print $1}')"
   test "$LOCAL_SHA" = "$REMOTE_SHA"
   ```

   Registre os checksums completos apenas na operação privada. Não copie o repositório inteiro nem
   instale dependências: `createRequire` resolve o `@prisma/client` já existente em
   `/app/node_modules`.
5. **Dry-run final:** com o `watchdog.sh` armado, emita o dry-run **por `op-wrap dryrun`**. Ele gera o
   caminho de manifest novo desta tentativa (dentro de `$QUIESCE_DIR`), o imprime na saída
   (`manifest=<caminho>`) e o registra em `$QUIESCE_DIR/manifest.current`. Não rode `node
   normalize-external-id-duplicates.mjs` à mão durante uma janela armada — o único toque no banco é via
   `op-wrap`. Baixe **exatamente** esse manifest (o que o `op-wrap` emitiu / `manifest.current`), nunca
   um caminho inventado em `/tmp`.

   ```bash
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "sh /app/op-wrap.sh dryrun"
   # aguarde o supervisor concluir (op-wrap status -> last rc), então:
   REMOTE_MANIFEST="$(flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "cat $QUIESCE_DIR/manifest.current")"
   flyctl ssh sftp get "$REMOTE_MANIFEST" "$LOCAL_MANIFEST" \
     --app reformaflow-api --machine "$MACHINE_ID"
   chmod 0600 "$LOCAL_MANIFEST"
   ```

   Registre privadamente o SHA-256 completo e as contagens `expectedGroups`/`expectedUpdates` emitidas.
   O dry-run não escreve no banco. Guarde a cópia baixada em armazenamento privado; nunca anexe o
   manifest.
6. **Revisar:** compare inventário, escopo e invariantes do manifest. Pare se houver mutação de linha
   ativa, mudança fora do escopo ou diferença entre os inventários do dry-run e do backup.
7. **Normalize/apply:** ainda sem writers, use exatamente o hash completo e contagens aprovados no
   dry-run. O `op-wrap apply` reusa o mesmo manifest do dry-run (`$QUIESCE_DIR/manifest.current`) e
   enfileira `normalize --apply && migrate resolve && migrate deploy` numa única cadeia supervisionada:

   ```bash
   MANIFEST_SHA="<sha256-completo-privado>"
   EXPECTED_GROUPS="<contagem-aprovada>"
   EXPECTED_UPDATES="<contagem-aprovada>"
   flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
     --command "sh /app/op-wrap.sh apply $MANIFEST_SHA $EXPECTED_GROUPS $EXPECTED_UPDATES"
   # acompanhe: op-wrap status  (op ... RUNNING -> last rc)
   ```

   Preserve o manifest `0600` apenas no armazenamento operacional privado.
8. **Resolve:** faz parte da cadeia do `op-wrap apply` (`prisma migrate resolve --rolled-back`), que só
   roda **após** o `normalize --apply` retornar 0 — a tentativa falha nunca é marcada como aplicada
   antes de o SQL concluir. Confira o estado real da migration no `op-wrap status` / log.
9. **Migrate:** também na mesma cadeia (`prisma migrate deploy`, só após o resolve). Confirme que a
   migration consta como aplicada (`last rc` = 0) e só então encerre a janela sem writers.
10. **Disarm + entrypoint:** rode `op-wrap disarm`; o `watchdog.sh` sobe o Node-direto assim que o
   lock ficar livre (ou já teria subido pelo deadline absoluto / por um restart com lock livre).
   Confirmada a API saudável, SRE limpa o override emergencial da machine:
   `flyctl machine update <machine-id> --machine-config '{"init":{"entrypoint":null,"cmd":null}}' --yes`.
   O Dockerfile `CMD` volta então a governar e restaura o entrypoint migrate-first.
11. **Encerrar:** preserve primeiro todas as evidências exigidas e confirme a cópia local `0600`. Só
    então remova da machine os dois caminhos efêmeros exatos, sem wildcard:

    ```bash
    REMOTE_MANIFEST="$(flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
      --command "cat $QUIESCE_DIR/manifest.current")"
    flyctl ssh console --app reformaflow-api --machine "$MACHINE_ID" \
      --command "rm -- '$REMOTE_SCRIPT' '$REMOTE_MANIFEST'"
    ```

    Remova também o `watchdog.sh`/`op-wrap.sh` enviados e o diretório `/data/quiesce` desta janela
    (caminhos exatos, sem wildcard). Não deixe o script, o manifest confidencial nem os artefatos da
    janela no rootfs ou no volume de dados depois da recuperação.

Não adicione `[processes] app="/entrypoint.sh"` ao `fly.toml`: isso não remove o override por machine.
O `http_service.processes = ["app"]` existente basta depois que SRE limpa `init.entrypoint` e
`init.cmd`.

### Bootstrap admin
O `main.ts` cria o admin a partir das envs `ADMIN_USERNAME`/`ADMIN_PASSWORD` em cada start (idempotente — se já existir, só sincroniza senha).

---

## Passo 3 — Deploy do Web (Vercel)

### Pela UI (recomendado)

1. Push o repo pro GitHub.
2. https://vercel.com/new → "Import Project" → escolha o repo.
3. **Root Directory**: `apps/web`
4. Framework: Next.js (detecta sozinho).
5. **Environment Variables**:
   - `NEXT_PUBLIC_API_URL` = `https://reformaflow-api.fly.dev`
6. Deploy.

### Pela CLI

```bash
cd apps/web
vercel link    # primeira vez
vercel env add NEXT_PUBLIC_API_URL production
# cole: https://reformaflow-api.fly.dev
vercel --prod
```

Vai sair um domínio tipo `reformaflow-xyz.vercel.app`.

---

## Passo 4 — Finalizar CORS

Depois que souber o domínio Vercel definitivo, **volte e ajuste o CORS_ORIGIN** da API:

```bash
flyctl secrets set --app reformaflow-api \
  CORS_ORIGIN="https://reformaflow-xyz.vercel.app"
```

Aceita lista separada por vírgula se quiser permitir preview deploys:

```bash
flyctl secrets set --app reformaflow-api \
  CORS_ORIGIN="https://reformaflow.vercel.app,https://reformaflow-git-main-<usuario>.vercel.app"
```

---

## Cookies cross-domain (já configurado)

Em `NODE_ENV=production`, o auth controller usa:
- `sameSite: 'none'` (permite cross-site)
- `secure: true` (exigido pelo browser para sameSite=none)

`trust proxy=1` está ativado no `main.ts` pra Express reconhecer o HTTPS passado pelo Fly.

Se for testar no Safari/iOS, garanta que ambos (web e API) estão em HTTPS — local não vai funcionar com `secure=true`.

---

## Comandos úteis

```bash
# Logs em tempo real
flyctl logs --app reformaflow-api

# SSH na máquina (acessa o volume)
flyctl ssh console --app reformaflow-api
# dentro: ls /data, sqlite3 /data/dev.db ".tables", etc.

# Backup do SQLite via SSH
flyctl ssh console --app reformaflow-api -C "sqlite3 /data/dev.db .dump" > backup-$(date +%F).sql

# Restart
flyctl apps restart reformaflow-api

# Re-deploy
flyctl deploy --app reformaflow-api -c apps/api/fly.toml --dockerfile apps/api/Dockerfile
```

---

## Custo

- **Vercel Hobby**: gratuito (100 GB tráfego/mês).
- **Fly.io**: 1 VM shared-cpu-1x 512 MB **sempre ligada** (`min_machines_running = 1`, `auto_stop_machines = "off"`) — trocado do modo suspend/resume (`min_machines_running = 0`) porque este último causava lentidão/timeouts intermitentes reais em produção ao "acordar" a máquina sob tráfego real. Isso sai do free allowance (256 MB) e gera cobrança proporcional — defina um spend limit em https://fly.io/dashboard/<org>/billing.

---

## Troubleshooting

**Deployment checklist (documentado — executado por Copilot CLI)**

1. Commit e push para branch `main` (ex.: `git push origin main`). Pre-commit hooks rodam TypeScript checks em `packages/domain`, `apps/api`, `apps/web` (bloqueiam commit se falhar). Veja `package.json` scripts e hooks.
2. Se o push falhar por permissão (403), rodar: `unset GH_TOKEN && gh auth switch -u <your-github-username>` e então `git push origin main`.
3. O GitHub Actions `CI` é disparado automaticamente. Verificar status: `gh run list --repo <owner>/<repo> --branch main` e `gh run view <run-id>` para log.
4. No job de deploy, o lock de concorrência apenas serializa execuções: já dentro dele e imediatamente
   antes de publicar, compare o SHA completo do run com o SHA completo atual de `main`. Se divergir,
   encerre como stale sem chamar o deploy. Mantenha `cancel-in-progress: false`.
5. Vercel detecta push e inicia deploy automático (se projeto conectado). Verificar no painel Vercel ou `vercel --prod`/`vercel ls` com CLI autenticada.
6. Após deploy, validar:
   - `flyctl machine list` retorna exatamente uma machine, com `state=started` e
     `.[0].image_ref.labels.GH_SHA == GITHUB_SHA`;
   - `flyctl checks list` retorna exatamente um check `passing` para o ID dessa machine;
   - a release mais recente está `complete`; remova o sufixo `@digest` de `machine.config.image` e
     compare o valor normalizado com o `ImageRef` da release;
   - `curl` em `/api/docs-json` retorna 200 e em `/auth/me` retorna 401.
   Machine `stopped` ou qualquer divergência bloqueia a release, mesmo que o job esteja verde. O SHA
   já vem de `image_ref.labels.GH_SHA`: não crie `/health` nem build arg para expô-lo.
7. Depois dos checks e smokes, compare novamente o SHA completo do run com o SHA completo atual de
   `main`. Se `main` avançou durante o deploy, falhe o gate pós-smokes: a release não pode ficar verde.
8. Se algo falhar, ver logs do GitHub Actions (build) e Fly/Vercel logs (flyctl logs / Vercel UI).

> **Cicatriz de 2026-08-28 (#629):** um deploy antigo terminou depois do novo e sobrescreveu `main`;
> outro deploy verde aceitou uma machine `stopped`; e a migration de #570 falhou sobre dados legados,
> impedindo o entrypoint de subir a API por cerca de 35 horas. Lock não garante ordem, banco fresco
> não representa upgrade real e sucesso do comando de deploy não substitui health + SHA.

> Observação de segurança: nunca comitar tokens ou secrets. Use `flyctl secrets set` e `vercel env add`.


**"Database locked" no Fly**
- SQLite não suporta múltiplas réplicas. Mantenha `min_machines_running = 0` ou `1` (nunca 2+).

**Cookies não persistem entre web → API**
- Conferir `CORS_ORIGIN` no Fly inclui exatamente o domínio do Vercel (incluindo o `https://`).
- Conferir que está em HTTPS dos dois lados (browser bloqueia `sameSite=none` sem `secure`).

**"Module not found: @reformaflow/domain" no build**
- A pasta `packages/domain` precisa estar no contexto do Docker build. O `.dockerignore` na raiz já está liberando — só não exclua a pasta.

**Volume ficou sem espaço**
- `flyctl volumes extend <id> --size 10` (até 3 GB grátis; acima cobra USD 0.15/GB/mês).
