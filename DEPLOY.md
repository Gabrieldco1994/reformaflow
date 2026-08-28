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

Use o script de reparo entregue no mesmo SHA da recuperação e confira sua ajuda antes de executar.
Não cole em logs IDs de linhas/tenants, PII, caminho completo do backup nem hash completo. O manifest
deve registrar apenas contagens, referência opaca do backup, checksum truncado e resultado por etapa.

1. **Conter:** mantenha o entrypoint temporário sem migration; não restaure ainda o
   `prisma migrate deploy` automático.
2. **Backup:** gere backup timestampado, valide que pode ser restaurado e registre sua referência
   sanitizada no manifest.
3. **Dry-run:** rode o modo `--dry-run`; ele deve produzir o manifest sem escrever e delimitar apenas
   os dados legados que bloqueiam a migration.
4. **Revisar:** compare inventário, escopo e invariantes do manifest. Pare se houver mutação de linha
   ativa, mudança fora do escopo ou diferença entre os inventários do dry-run e do backup.
5. **Apply:** só com backup e manifest aprovados, rode `--apply`; preserve o manifest final e repita o
   dry-run até não haver reparo pendente.
6. **Resolve:** confira o estado real da migration e então use `prisma migrate resolve` para registrar
   a tentativa falha como revertida; nunca a marque como aplicada antes de o SQL concluir.
7. **Migrate:** execute `prisma migrate deploy` e confirme que a migration consta como aplicada.
8. **Entrypoint:** somente depois disso, SRE deve limpar o override emergencial da machine:
   `flyctl machine update <machine-id> --machine-config '{"init":{"entrypoint":null,"cmd":null}}' --yes`.
   O Dockerfile `CMD` volta então a governar e restaura o entrypoint migrate-first.

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
   - a release mais recente está `complete` e seu `ImageRef` é igual a `machine.config.image`;
   - `curl` em `/api/docs-json` retorna 200 e em `/auth/me` retorna 401.
   Machine `stopped` ou qualquer divergência bloqueia a release, mesmo que o job esteja verde. O SHA
   já vem de `image_ref.labels.GH_SHA`: não crie `/health` nem build arg para expô-lo.
7. Se algo falhar, ver logs do GitHub Actions (build) e Fly/Vercel logs (flyctl logs / Vercel UI).

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
