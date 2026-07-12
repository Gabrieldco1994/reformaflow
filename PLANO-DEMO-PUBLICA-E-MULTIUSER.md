# Plano — Demo pública navegável + caminho para lançamento por usuário

**Data:** 2026-07-12 · **Status:** plano aprovável (nada executado)
**Objetivo:** qualquer pessoa abre uma URL, passa por onboarding, ganha um ambiente
próprio com dados de exemplo e pode criar/editar tudo — **100% isolado da base do
Gabriel** — e cada peça construída aqui é a fundação do lançamento real por usuário.

---

## 0. O que o código JÁ tem (por isso o plano é menor do que parece)

| Capacidade | Evidência | Falta |
|---|---|---|
| Multi-tenancy real | `Tenant`/`User` no schema; `tenantId` em todos os modelos; `TenantInterceptor` extrai do JWT; services filtram por tenant; `accessibleProjectScope` | auditoria de vazamentos + endurecer |
| Auth com roles/senha | `auth/` (login, logout, me, JWT, `login-throttle.guard`), `passwordHash`, roles, `allowedModules/Projects` | **signup** (registro cria Tenant+User) |
| Seed | `prisma/seed.ts` | seed **por tenant** com dados demo realistas |
| Infra | API no Fly (`reformaflow-api`, volume `/data`), web no Vercel | 2ª instância p/ demo |

**Riscos já identificados no código:**
- 🔴 `tenant.interceptor.ts` aceita `tenantId` por **query param** como fallback →
  em produção pública isso é bypass de isolamento. Tem que morrer atrás de env.
- 🔴 SQLite = 1 writer. Serve para demo (dezenas de usuários); NÃO serve para
  lançamento com centenas de usuários simultâneos (ver Fase 5).
- 🟡 Custos por visitante: Gemini (Maria, categorização, plantas), TTS no Modal,
  uploads. Sem quota, um bot esgota a cota/fatura.

---

## 1. Decisão de arquitetura (recomendada)

**Instância separada + mesmo código.** Criar um deployment novo — `reformaflow-demo`
— com **banco próprio** (volume Fly novo, `demo.db` zerado). A base do Gabriel fica
fisicamente intocável (não é isolamento lógico, é outro arquivo em outra máquina).

- Por que não "tenants demo dentro do prod atual": SQLite único arquivo — um bug de
  seed/reset ou um lock de escrita da demo afeta os dados reais. Custo de separar ≈ 0.
- Por que não um fork: **mesmo código, mesma imagem, flags por env** (`APP_MODE=demo`).
  Tudo que a demo ganhar (signup, onboarding, seed, quotas) é exatamente o que o
  lançamento real precisa — ao lançar, sobe-se uma instância `prod-multiuser` com
  Postgres e `APP_MODE=prod`, e a demo continua existindo como ambiente de teste.

URLs alvo: `demo.lifeone.app` (ou `reformaflow-demo.vercel.app`) → aponta para
`reformaflow-demo-api.fly.dev`. O prod pessoal do Gabriel não muda.

---

## 2. Fases (cada uma = 1 PR, executável por agente com brief)

### Fase D0 — Endurecer o multi-tenant (pré-requisito de segurança)
1. `TenantInterceptor`: fallback de `tenantId` por query/header só quando
   `ALLOW_TENANT_OVERRIDE=1` (dev). Em demo/prod: **somente JWT**.
2. Auditoria de vazamento cross-tenant: teste automatizado que cria 2 tenants e
   percorre TODOS os controllers GET/POST principais afirmando 404/403 para recurso
   do outro tenant (expense, project, credit-card, bank-account, receipt, uploads,
   agent, monthly-overview). Suíte `cross-tenant.spec.ts` nova no apps/api.
3. Uploads: hoje `ServeStaticModule` serve `/uploads/` sem auth — na demo, paths
   imprevisíveis (uuid) no mínimo; ideal: rota autenticada com checagem de tenant.
4. Rate limit global (login já tem throttle; estender a signup e agent/TTS).

### Fase D1 — Signup + criação de tenant
1. `POST /auth/register` → cria `Tenant` + `User` (role OWNER) numa transação;
   valida username único global (ou e-mail), senha com hash (bcrypt já usado no login).
2. Flag `SIGNUP_ENABLED` por env (demo: on; prod pessoal: off — nada muda para o Gabriel).
3. Web: tela "Criar conta" (mesma linguagem visual do login atual) + fluxo
   pós-registro logando direto.
4. **Modo convidado (opcional, decidir):** botão "Testar sem cadastro" cria tenant
   efêmero com username aleatório e marca `expiresAt` (limpeza em D4). Menos fricção
   de teste; e-mail só se a pessoa quiser "salvar" a conta depois.

### Fase D2 — Onboarding + seed de dados demo
1. `seedDemoTenant(tenantId)` (função no api, reusa services — NÃO SQL cru):
   - Projeto **PESSOAL** "Minha vida financeira": 1 conta corrente + 2 cartões
     (closingDay/dueDay distintos, um deles SEM closingDay para mostrar o estado
     "configurar"), ~6 meses de despesas realistas (supermercado, transporte,
     assinaturas, parcelas 4/10, um aporte INVESTIMENTOS, um pagamento de fatura
     neutro, um estorno), recebimentos (salário), faturas casadas (uma paga por
     valor, uma aberta) — **datas relativas a hoje** (gerador, não fixture fixa),
     para a demo nunca "envelhecer".
   - Projeto **REFORMA** "Reforma do apê" enxuto: despesas planejadas + 1 espelho
     vinculado ao PESSOAL (mostra o cross-project).
   - Invariantes: o seed deve fechar com o §10 (caixa = extrato) — validar no teste
     com `getAccountView`.
2. Onboarding no web (primeira entrada do tenant):
   - Passo 1: "Como quer começar?" → **[Com dados de exemplo]** (chama seed) ou
     **[Do zero]**.
   - Passo 2: tour de 3 balões (Cockpit herói → FAB Lançar → Maria) usando as telas
     reais — sem biblioteca nova, tooltips posicionados.
   - Passo 3: Maria abre com mensagem de boas-vindas proativa ("Carreguei 6 meses de
     exemplo. Pergunte 'como fecho o mês?' ou lance uma despesa de teste").
3. Badge persistente "🧪 Ambiente de demonstração — dados de exemplo" no shell.

### Fase D3 — Infra da demo
1. Fly: app novo `reformaflow-demo-api` + volume novo (mesma imagem/Dockerfile;
   `DATABASE_URL` própria; secrets próprios). Migrations rodam no deploy.
2. Vercel: projeto/domínio demo com `NEXT_PUBLIC_API_URL` apontando para a demo
   (verificar como o web resolve a API hoje e parametrizar se estiver fixo).
3. Chaves de IA **separadas e com cota** (Google AI Studio permite quota por chave):
   `GOOGLE_API_KEY_DEMO`. TTS/Modal: desabilitar na demo (`FEATURE_TTS=off`) ou
   quota diária — decidir custo.
4. Reset agendado (cron Fly/GitHub Action): semanalmente, apagar tenants expirados
   e (opcional) recriar o tenant-vitrine `demo/demo`.
5. Observabilidade mínima: healthcheck + alerta (UptimeRobot/Fly checks) e contagem
   diária de tenants criados (SELECT simples num cron) — é também o primeiro medidor
   de interesse no produto.

### Fase D4 — Guarda-corpos de abuso/custo
1. Quotas por tenant (guard simples + contagem): máx N projetos (3), N despesas
   (2.000), N uploads (20 × 2 MB), N chamadas/dia de agent (30) e de categorização IA.
2. TTL de tenant convidado (ex.: 14 dias sem login → soft-delete; job do item D3.4).
3. `login-throttle` estendido a register; CAPTCHA só se abuso aparecer (não antecipar).
4. Painel-relatório mínimo para o Gabriel (rota admin ou script): tenants, uso, custo IA.

### Fase D5 — Do demo ao lançamento por usuário (fundação, não execução agora)
1. **Postgres**: o passo único e inevitável. Plano: schema Prisma já é portável;
   migrar `provider = "postgresql"`, gerar migrations novas, script de import
   (SQLite→PG) e rodar a demo em PG **antes** do lançamento (a demo vira o cobaia
   da migração). Fly Postgres ou Neon/Supabase — decidir na hora por custo.
2. E-mail de verdade (verificação/reset de senha) — hoje username/senha puro.
3. Billing (se for cobrar): Stripe + plano free = limites da D4 (que já existirão).
4. Termos/privacidade e LGPD básico (dados financeiros são sensíveis): na demo,
   aviso "não insira dados reais"; no lançamento, política + export/delete de conta
   (delete = soft-delete de tenant já suportado).
5. O prod pessoal do Gabriel migra por último (import do dev.db para um tenant no
   PG multiuser) — ou nunca, se preferir manter instância própria.

---

## 3. Ordem, dependências e estimativa de PRs

```
D0 (segurança) ──► D1 (signup) ──► D2 (onboarding+seed) ──► D3 (infra demo no ar) ──► D4 (quotas)
                                                                            └────► D5 (quando decidir lançar)
```
- D0–D2 são código (agentes em worktree, briefs no padrão das trilhas).
- D3 é infra (Fly/Vercel — sessões suas comigo, precisa de credenciais).
- **Demo utilizável no ar = fim da D3.** D4 pode sair 1 semana depois.
- Paralelismo com o que está em voo: nenhum conflito com Trilha 4 (superfícies) e
  baixo com Fase E (D0 toca interceptor/testes; combinar merge order: Fase E antes).

## 4. Decisões que são suas (responder antes do brief da D1)
1. **Convidado sem cadastro** (1 clique, tenant efêmero) ou **cadastro sempre**? (Recomendo convidado — fricção mínima para "qualquer um testar".)
2. Demo com **REFORMA incluída** no seed ou só PESSOAL? (Recomendo incluir — é o diferencial cross-project.)
3. **Maria ligada** na demo (custo Gemini com quota) ou desligada com respostas gravadas? (Recomendo ligada com quota de 30 msgs/dia por tenant.)
4. Domínio: subdomínio próprio (`demo.…`) ou URL Vercel padrão?
