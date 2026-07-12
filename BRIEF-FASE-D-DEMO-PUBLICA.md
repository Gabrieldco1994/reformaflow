# BRIEF DE EXECUÇÃO — Fase D (Demo pública): D0 segurança · D1 signup/convidado · D2 onboarding+seed

**Data:** 2026-07-12 · **Plano-mãe:** `PLANO-DEMO-PUBLICA-E-MULTIUSER.md` (decisões §4 fechadas)
**Base:** `main`. Worktree próprio, branch `feat/demo-publica`.
**Escopo:** 3 PRs SEQUENCIAIS (D0 → D1 → D2). Não pular a ordem: D1 sem D0 = signup público com bypass de tenant.
**Fora de escopo:** infra Fly/Vercel (D3), quotas finas (D4), Postgres/billing (D5).

## Regras invioláveis
1. **Nada muda para o ambiente atual do Gabriel por padrão.** Todo comportamento novo
   nasce atrás de env flag desligada (`SIGNUP_ENABLED`, `GUEST_MODE_ENABLED`,
   `ALLOW_TENANT_OVERRIDE`). Deploy atual sem flags = comportamento idêntico ao de hoje.
2. Backup antes de migration (`cp prisma/dev.db prisma/dev.db.bak-$(date +%Y%m%d-%H%M%S)`);
   migrations ADITIVAS apenas.
3. Modelo novo sem `deletedAt` → atualizar `modelsWithoutSoftDelete` no `prisma.service.ts`.
4. Seeds/quotas via services existentes (nunca SQL cru) — para passar por soft-delete,
   espelho, buildInstallments e neutros corretamente.
5. `cd apps/api && npx jest` verde ao fim de cada PR; tsc verde nos 3 pacotes.
6. QA real ao fim de cada PR (login/fluxo de verdade, não só testes).

---

## PR-D0 — Endurecer multi-tenant (`fix(auth): ...`)

1. **`tenant.interceptor.ts`**: fallback de `tenantId` via query/header passa a exigir
   `ALLOW_TENANT_OVERRIDE=1`. Sem a env (demo/prod): tenant SÓ do JWT. Documentar no
   próprio arquivo. Conferir se o dev local usa o fallback (se sim, setar a env no
   `.env` de dev para não quebrar ninguém).
2. **Suíte `cross-tenant.spec.ts`** (apps/api, e2e leve com dois tenants seedados):
   para cada recurso principal (project, expense, receipt, credit-card, bank-account,
   recurring-bill, maintenance, reminder, monthly-overview, agent, uploads), tenant B
   não lê/edita/deleta recurso do tenant A (espera 403/404, NUNCA 200 nem vazamento em
   listas). Qualquer furo encontrado = corrigir no service correspondente no mesmo PR.
3. **Uploads**: mover leitura de `/uploads/` para rota autenticada com checagem de
   tenant (floor-plans/room-images/receipts pertencem a projeto → tenant). Se inviável
   sem refactor grande, mitigar: nomes de arquivo com uuid não-enumerável + flag
   `PUBLIC_UPLOADS=1` para manter comportamento atual no ambiente do Gabriel; anotar
   dívida no plano-mãe.
4. **Throttle**: reutilizar o mecanismo do `login-throttle.guard` para os endpoints de
   `agent/chat` e (futuro) `auth/register` — por IP + por tenant.

## PR-D1 — Signup + modo convidado (`feat(auth): ...`)

1. `POST /auth/register` (atrás de `SIGNUP_ENABLED=1`): `{name, username, password}` →
   transação cria Tenant (name = nome da pessoa) + User OWNER com passwordHash; retorna
   o mesmo payload do login (JWT). Username único GLOBAL para signup público (hoje a
   unicidade é por tenant — adicionar checagem de aplicação, sem quebrar o unique atual).
   Throttle do D0.4 aplicado.
2. `POST /auth/guest` (atrás de `GUEST_MODE_ENABLED=1`): cria tenant efêmero
   (`Tenant.name="Convidado"`, user `guest-<rand>` sem senha utilizável) e loga direto.
   Campo novo aditivo `Tenant.expiresAt DateTime?` (migration) setado p/ +14 dias.
   Endpoint `POST /auth/claim` (logado como guest): define username/senha reais e limpa
   `expiresAt` — "salvar minha conta".
3. **Limpeza**: script/cron `npm run purge-expired-tenants` (apps/api command) que
   soft-deleta tenants com `expiresAt < now` (cascata lógica: users/projects do tenant).
   Só o script — o agendamento é D3.
4. **Web**: tela de login ganha, quando as flags estiverem ligadas (expostas via
   endpoint público `GET /auth/config` ou env `NEXT_PUBLIC_*`): botão primário
   **"Testar sem cadastro"** e link "Criar conta" (form nome/usuário/senha, mesma
   linguagem visual do login atual). Sem flags: tela idêntica à de hoje.

## PR-D2 — Onboarding + seed demo (`feat(onboarding): ...`)

1. **`seedDemoTenant(tenantId)`** (módulo novo `apps/api/src/demo-seed/`, invocável por
   endpoint `POST /demo/seed` — idempotente por tenant, só roda se o tenant não tem projetos):
   - **PESSOAL "Minha vida financeira"**: 1 conta corrente; 2 cartões — "Roxinho •4321"
     (closingDay 28, dueDay 7) e "Dourado •8765" (SEM closingDay, de propósito, para o
     estado "configurar"); **6 meses de histórico com datas RELATIVAS a hoje** (gerador):
     salário mensal, supermercado/transporte/assinaturas/saúde variados, 1 parcelamento
     6× no meio da série, 1 aporte `INVESTIMENTOS`, pagamentos de fatura neutros casando
     por valor (1 fatura paga, a corrente aberta), 1 estorno negativo.
   - **REFORMA "Reforma do apê"**: 4 despesas planejadas + 1 espelho vinculado pago pelo
     PESSOAL (usar o fluxo de conciliação existente).
   - **Teste de invariante:** após o seed, `getAccountView` fecha (caixa = extrato §10),
     fatura do Roxinho casa como paga via `matchPaidInvoices`, e o Cockpit não mostra NaN.
2. **Onboarding web** (primeira entrada de tenant sem projetos, guard no shell):
   - Passo 1: "Como quer começar?" → **[Ver com dados de exemplo]** (chama `/demo/seed`
     e vai ao Cockpit) ou **[Começar do zero]** (vai à criação de projeto existente).
   - Passo 2: tour de 3 tooltips nas telas reais (herói do Cockpit → FAB Lançar → Maria),
     dispensável, sem lib nova, estado em localStorage.
   - Passo 3: primeira mensagem proativa da Maria no tenant demo: "Carreguei 6 meses de
     exemplo…" (string local, não chamada de LLM).
3. **Badge de demo**: `APP_MODE=demo` (exposto ao web) mostra chip persistente
   "🧪 Ambiente de teste — não use dados reais" no shell + no login.
4. **Quota mínima da Maria** (antecipação da D4, simples): máx 30 `agent/chat`/dia por
   tenant quando `APP_MODE=demo` (contagem em memória/DB simples; mensagem amigável ao
   estourar).

## Critérios de aceite finais (rodar como QA da fase)
1. Com flags OFF: app comporta-se exatamente como hoje (login do Gabriel intacto).
2. Com flags ON (local): "Testar sem cadastro" → onboarding → seed → Cockpit com 6
   meses coerentes → lança despesa no FAB → herói atualiza → pergunta à Maria →
   responde → tenant B (outro guest) não vê NADA do tenant A.
3. `cross-tenant.spec.ts` verde; suíte inteira verde; seed idempotente (2º clique não duplica).
4. Screenshots do fluxo completo no PR (390px e desktop).
