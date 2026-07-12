# BRIEF DE EXECUÇÃO — Fase E: Unificação de Motores (§10 Canônico)

**Data:** 2026-07-11
**Status:** ✅ **PRÉ-REQUISITO VALIDADO** — §10 auditado contra banco real, invariante congelada
**Base:** `main` APÓS merge dos PRs das Trilhas 1, 2, 3 (Fase E é SERIAL, vem depois)
**Branch sugerido:** `feat/fase-e-motor-unico` (worktree próprio)
**Escopo:** 1 PR, MAS envolve mudanças de cálculo + wizard + pessoal-lens
**Criticidade:** MÁXIMA — altera números que usuário usa pra decidir

---

## 🔐 Validação de entrada (§10 invariante)

**Auditoria em produção (2026-07-11):**

| Motor | Saldo | Bate com banco? |
|-------|-------|---|
| §10 (monthly-overview / Visão Conta) | R$ 63.427,35 | ✅ **SIM — EXATO** |
| cash-flow (rollingBalance) | R$ 62.428,39 | ⚠️ −R$ 999 (0,6% off) |
| tenant-financial (/financeiro) | R$ 592.892,05 | ❌ +R$ 529k (834% off) |

**Conclusão:** A única fonte correta é `monthly-overview.computeCaixaConta` (§10). Este número não pode mudar na Fase E. Se mudar = bug crítico.

---

## 🎯 Objetivo

Fazer com que **todo** cálculo de "saldo" em toda a app use o mesmo motor e o mesmo número:
1. Deprecar `tenant-financial.service` (morre aqui — seu código vira apenas uma wrapper que chama §10)
2. Fundir `/financeiro` no Cockpit (absorver KpiCards de prod no lugar do KpiCards antigo)
3. Alinhar `cash-flow.rollingBalance` pra bater 100% com §10 (fechar o −R$ 999)
4. Alinhar `dashboard`/`simulation`/`budget-allocation` ao invariante
5. Auditar rateio/espelho/neutro com suite de testes (pessoal-lens) — garantir que o §10 sobe também

---

## ⚠️ Regras de ouro (NÃO quebrar)

1. **§10 é READ-ONLY nesta fase.** Nenhuma mudança em `monthly-overview.service.ts:computeCaixaConta`.
   Se descobrir bug ali, é uma sessão SEPARADA (Fase 0 de revisão, não Fase E).

2. **Testes de invariante rodam antes/depois:**
   ```
   npm run test:invariantes    # suite em packages/domain
   # deve passar com mesmo resultado nos dois pontos
   ```

3. **pessoal-lens (agente) REVISA CADA PERMUTAÇÃO:**
   - Espelho (cross-project linkedExpenseId)
   - Rateio (RateioAllocation)
   - Fatura de cartão (PAGAMENTO_FATURA_CARTAO = neutro)
   - Cartão paga cartão (PAGAMENTO_CARTAO_OUTRO_CARTAO)
   - Recorrências (recurringBills) com aporte
   - Nenhum pode divergir do §10

4. **Nenhuma mudança de schema.** Campos NOVOS só se absolutamente necessário (muito improvável).

5. **Wizard de migração:** interface limpa (1 botão = "consolidar") que mostra antes/depois,
   confirma valores, e só depois migra dados. Reversível (data backup no banco).

---

## 🚀 Entregas (ordem de implementação)

### Entrega 1: Wrapper de `tenant-financial` → §10
- Arquivo: `apps/api/src/tenant-financial/tenant-financial.service.ts`
- Mudança: `overview()`, `byProject()`, etc. viram simples wrappers que chamam
  `monthly-overview.service.getTenantFinancial(tenantId)` (nova função que computa do §10)
- **Nenhuma lógica nova** — só traduzir a resposta do §10 pro formato antigo de `/financeiro`
- Resultado: `/financeiro` passa a mostrar o MESMO número que Visão Conta
- Teste: UI em produção não muda visualmente (mas valores ficam corretos)

### Entrega 2: Absorver KpiCards do `/financeiro` no Cockpit
- Localização: `apps/web/src/app/projects/[projectId]/monthly/_cockpit/`
- Mudança: adicionar seção "Resumo Financeiro" (ex.: KpiCards do `/financeiro`, mas que consomem
  §10 via `monthly-overview`) no topo ou abaixo do herói do Cockpit
- Design: usar componentes canônicos (KpiTile, Delta, moneyGlance)
- Resultado: Cockpit agora é o hub único; `/financeiro` vira alias/redirect
- Teste: Cockpit mostra EXATAMENTE os mesmos números que `/financeiro` mostrava (antes de ser corrigido)

### Entrega 3: Alinhar `cash-flow` com §10 (fechar −R$ 999)
- Localização: `apps/api/src/cash-flow/cash-flow.service.ts`
- Investigação: por que `rollingBalance` final é R$ 999 menor que §10?
  - Bug de entrada faltante?
  - Neutro sendo contado em um lugar sim, outro não?
  - Ordem de acúmulo diferente?
- Mudança: corrigir a lógica de `computeRollingBalance` pra computar exatamente igual §10
- Teste:
  ```
  const roB = computeRollingBalance(entries);  // seu código
  const caixa = computeCaixaConta(...);        // §10
  expect(roB).toEqual(caixa);  // deve passar
  ```

### Entrega 4: Auditar espelho + rateio + neutro com pessoal-lens
- Localização: `packages/domain/__tests__/` + `apps/api/src/` (onde rodam os cálculos)
- Ferramenta: agent pessoal-lens com permissão de leitura (via git diff + testes)
- Checklist (§10 deve bater em TODOS esses casos):
  - [ ] Despesa normal (PESSOAL)
  - [ ] Despesa com espelho (linkedExpenseId → REFORMA)
  - [ ] Rateio (RateioAllocation → N projetos)
  - [ ] Fatura de cartão (PAGAMENTO_FATURA_CARTAO = neutro)
  - [ ] Cartão paga cartão (neutro, não "dupla despesa")
  - [ ] Recorrência mensal (recurringBills com aporte)
  - [ ] Estorno de cartão (despesa negativa)
  - [ ] Crédito (Receipt RESGATE = investimento, não renda — §2.0.4)
- Se qualquer teste FALHAR: pausar, investigar, propor fix separado

### Entrega 5: Wizard de consolidação + reversão
- UI: 1 página limpa em admin (ex.: `/admin/consolidate-motors`)
- Flow:
  1. "Você tem 2 motores paralelos. Converteremos tudo para §10."
  2. Mostra: antes (número antigo) vs depois (número novo) — lado a lado
  3. "Backup criado em: `backup-2026-07-12-consomolidation.sql`"
  4. Confirma: "Prosseguir?"
  5. Executa: wrapper de `tenant-financial` + absorção KpiCards + alinhamento cash-flow
  6. Valida: invariante rodando testes
  7. Se falhar: rollback automático + notificação ao admin
- Deploy: feature flag `CONSOLIDATE_MOTORS=false` até QA validar

---

## 📁 Onde mexer

```
apps/api/src/
  tenant-financial/tenant-financial.service.ts    ← wrapper → §10
  cash-flow/cash-flow.service.ts                  ← alinhar rollingBalance
  (possível: common/consolidation-wizard.service.ts novo)

apps/web/src/app/projects/[projectId]/
  monthly/_cockpit/                               ← absorver KpiCards de /financeiro
  
packages/domain/
  __tests__/pessoal-invariantes.test.ts           ← suite pessoal-lens
```

**NÃO tocar:** `monthly-overview.service.ts` computeCaixaConta (congelado), schema, Fase C/D/F/G.

---

## ✅ Definition of Done

- [ ] §10 invariante validado em prod e congelado (este brief é a prova)
- [ ] `tenant-financial` é wrapper que chama §10
- [ ] `/financeiro` na UI redireciona para Cockpit OU mostra mesmos números via §10
- [ ] `cash-flow` rollingBalance bate EXATAMENTE com §10 (R$ 63.427,35)
- [ ] Suite pessoal-lens passou todas as 6 permutações
- [ ] Wizard de consolidação criado e testado (rollback funciona)
- [ ] `cd apps/api && npm run test` — todos os testes passam
- [ ] `cd packages/domain && npm run test` — suite de invariantes passa
- [ ] Testes de regressão: dados antigos de prod (snapshot) calculam idêntico antes/depois
- [ ] QA visual em prod: Cockpit, Visão Conta, cash-flow — números não mudam pra usuário final
- [ ] PR único: `feat(api): Fase E — consolidação de motores (§10 canônico)`

## 🚫 Fora de escopo (NÃO fazer)

- Mudanças em computeCaixaConta (§10) — congelado
- Novos endpoints, novas features
- Trilhas 1/2/3 (presentation-only, já em paralelo)
- Fase 0 (revisão de bugs no §10 — se encontrar, é PR separado)

## 📚 Leitura obrigatória antes de codar

1. `AUDITORIA-MOTORES-PROD.md` (este repo — documento que prova §10 é correto)
2. `apps/api/src/monthly-overview/monthly-overview.service.ts` (§10, SÓ LER)
3. `packages/domain/__tests__/pessoal-consolidacao-invariantes.md` (memory file com regras)
4. `docs/cockpit-caixa-real.md` (§10 rules + neutro + fatura)
5. `CLAUDE.md` (convenções + cicatrizes)

## 🔐 Validador de entrada

Se, antes de começar o código, o §10 em prod MUDA de R$ 63.427,35:
- **STOP.** Não escrever código.
- Investigar por quê mudou (novo lançamento? débito à noite?).
- Rodar auditoria de novo.
- Confirmar com você que continua batendo com banco.

**Este brief fica como referência do estado-base de Fase E.**

---

**Gerado:** 2026-07-11 23:55  
**Validação:** §10 = R$ 63.427,35 = saldo real do banco ✅  
**Status:** SEGURO PRA EXECUTAR
