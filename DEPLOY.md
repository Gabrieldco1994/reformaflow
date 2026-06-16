# Deploy gratuito — ReformaFlow

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
O `entrypoint.sh` roda `prisma migrate deploy` antes de iniciar o NestJS, então as migrations vão automaticamente.

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
- **Fly.io**: dentro do free allowance (3 VMs shared-cpu-1x 256 MB, 3 GB volume, 160 GB tráfego). Acima disso há cobrança proporcional — você pode definir um spend limit em https://fly.io/dashboard/<org>/billing pra não passar de R$ 0.

---

## Troubleshooting

**Deployment checklist (documentado — executado por Copilot CLI)**

1. Commit e push para branch `main` (ex.: `git push origin main`). Pre-commit hooks rodam TypeScript checks em `packages/domain`, `apps/api`, `apps/web` (bloqueiam commit se falhar). Veja `package.json` scripts e hooks.
2. Se o push falhar por permissão (403), rodar: `unset GH_TOKEN && gh auth switch -u <your-github-username>` e então `git push origin main`.
3. O GitHub Actions `CI` é disparado automaticamente. Verificar status: `gh run list --repo <owner>/<repo> --branch main` e `gh run view <run-id>` para log.
4. Vercel detecta push e inicia deploy automático (se projeto conectado). Verificar no painel Vercel ou `vercel --prod`/`vercel ls` com CLI autenticada.
5. Após deploy, validar:
   - API em `NEXT_PUBLIC_API_URL` responde `/api/docs`.
   - Fazer smoke tests: `curl -sI $NEXT_PUBLIC_API_URL/api/docs` e validar 200.
6. Se algo falhar, ver logs do GitHub Actions (build) e Fly/Vercel logs (flyctl logs / Vercel UI).

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
