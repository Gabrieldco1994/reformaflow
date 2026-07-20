# Cockpit (Pessoal) — Caixa real (§10) + redesign do topo

> **Relacionado:** a lógica de **faturas de cartão, neutros, casamento
> pagamento→fatura e "cartão paga cartão"** está em
> [`docs/visao-conta-faturas.md`](./visao-conta-faturas.md).
>
> **Status (2026-06-25):** IMPLEMENTADO e mergeado em `main`.
> Base principal: `feat(cockpit): caixa real (§10) + redesign do topo` (PR #14)
> e evoluções subsequentes da Visão Conta/Cockpit.
> Este doc descreve regras, implementação e validação operacional.

---

## CONTRATO (normativo — o que nunca pode quebrar)

1. **Caixa real (§10)** é sempre `saldoInicial + Σ lançamentos realizados da conta`.
2. Lançamento da conta = `Expense`/`Receipt` com `bankLast4 != null`.
3. Entradas de conta contam só quando `Receipt.status='EM_CAIXA'`.
4. Saídas de conta contam só quando `Expense.status='PAGO'`.
5. Compras no cartão sem `bankLast4` **não** entram no caixa da conta.
6. Itens futuros (`PLANEJADO`/`PREVISTO`) **não** entram no `caixa.hoje`.
7. `caixa.hoje` vem do backend (`computeCaixaConta`) e é independente do mês selecionado na UI.
8. Quando `caixa.temSaldoInicial=false`, a UI deve rotular como "Resultado realizado" (não "Caixa") e exibir banner com deep-link para cadastrar o saldo inicial.
9. A projeção de fim do mês no cockpit usa a fonte canônica de conta (`data.projecao` / `getAccountView`) antes de qualquer fallback por competência.
10. **I1:** `computeCaixaConta` é type-agnóstico: toda despesa `PAGO` com `bankLast4` reduz caixa, inclusive `INVESTIMENTOS` (neutro-de-consumo).
11. **I2:** `RESGATE` `EM_CAIXA` com `bankLast4` aumenta caixa real.
12. **I3:** `getCaixaConta` deve delegar para `computeCaixaConta` sem divergência numérica.
13. **I4:** `caixa.porMes` é série acumulada a partir de `saldoInicial` e só com realizados. ⚠️ não blindado por teste dedicado com codinome I4.
14. **I5:** fallback por competência nunca pode sobrescrever `caixa.hoje` reconciliado quando `temSaldoInicial=true`. ⚠️ não blindado por teste dedicado com codinome I5.
15. **Regra de domicílio das contas fixas:** tudo que debita da conta bancária pessoal se lança como despesa (recorrente ou avulsa) no projeto **PESSOAL**. Projetos CASA/CARRO guardam manutenção, lembretes e despesas do bem — `recurringBills` de CASA/CARRO NÃO entram no caixa consolidado. Espelho automático entre CASA/CARRO → PESSOAL é explicitamente **deferido** (decisão de produto, não implementar sem nova deliberação).

## Referência de implementação

- Backend: `apps/api/src/monthly-overview/monthly-overview.service.ts` (`computeCaixaConta`, `getCaixaConta`, `getOverview`).
- DTO/conta: `apps/api/src/bank-account/dto/bank-account.dto.ts`, `apps/api/src/bank-account/bank-account.service.ts`.
- Frontend: `apps/web/src/app/projects/[projectId]/monthly/_cockpit/derive.ts`, `.../_cockpit/CockpitTop.tsx`, `.../monthly/_types.ts`.
- Testes que blindam contrato: `apps/api/src/monthly-overview/caixa-conta.spec.ts`, `apps/api/src/monthly-overview/get-caixa-conta.spec.ts`, `apps/web/src/app/projects/[projectId]/monthly/_cockpit/derive.projecao.test.ts`.

## Apêndice histórico

## 1. Problema que originou a tarefa

Os dashboards de KPI estavam confusos. Diagnóstico:

1. **Colisão de nomes:** "Caixa Disponível" (/financeiro) × "Em caixa agora" (cockpit) × "Saldo atual" (mês) — 3 nomes; e "Saldo Projetado" aparecia 4× (30d, 90d, global, fim-do-mês).
2. **"Em caixa agora" enganoso:** mostrava **R$ 18.381** (fluxo realizado conta+cartão), que **não é** o caixa do banco (**R$ 17.230**). O app não guardava saldo inicial, então não dava pra reconciliar.
3. **Grade plana de cards iguais** sem hierarquia; KPIs reportavam métricas em vez de responder perguntas; sem delta/tendência.

**Decisões do usuário (perguntadas e respondidas):**
- Começar pelo **cockpit `/monthly`**.
- Card "Caixa" via **backend com saldo inicial real (§10)** — não fallback de rótulo, não config manual.
- Manter o código implementado, documentar tudo (este arquivo).

---

## 2. A regra central — Caixa real (reconciliação §10)

Regra canônica do **Caixa Real** (codinome histórico **§10**, herdado da seção 10 de um documento pessoal do Gabriel, `LOGICA_CONSOLIDACAO_FINANCEIRA.md`, que NÃO está neste repo — a definição abaixo é a fonte de verdade):

```
saldo da conta hoje = saldo inicial (na data de referência)
                    + Σ TODOS os lançamentos REALIZADOS da conta corrente
```

- **"Lançamento da conta"** = `Expense`/`Receipt` com **`bankLast4 ≠ null`**. Isso inclui:
  extrato (débitos/créditos), **aplicações e resgates**, e **pagamentos de fatura debitados na conta**.
- **NÃO entram:** itens de cartão (`cardLast4`, sem `bankLast4`) — estão na fatura, não na conta.
- **NÃO entram:** lançamentos futuros (status ≠ `PAGO`/`EM_CAIXA`, ex.: SEGURO CARTÃO agendado) —
  ainda não foram debitados (a §10 manda descontá-los).

**Validação numérica (dados de prod corrigidos):**
`opening 14.285,97 + líquido realizado da conta 2.943,77 = 17.229,74` — bate com o banco
(extrato 17.229,88; diferença R$ 0,14 = arredondamento de rendimento, esperado).

> ⚠️ Diferente de `caixaAgora` do cockpit (fluxo realizado conta **+ cartão**, todo o período),
> que dá ~18.381 e mede resultado de fluxo, não o caixa do banco.

---

## 3. O que mudou (arquivo por arquivo)

### Backend
| Arquivo | Mudança | Status |
|---|---|---|
| `prisma/schema.prisma` | `BankAccount.openingBalanceCents Int @default(0)` + `openingBalanceDate DateTime?` | ✅ |
| `prisma/migrations/20260607200000_add_bank_account_opening_balance/migration.sql` | ADD COLUMN das 2 colunas | ✅ aplicada no **dev.db local**; **prod = aplicar no deploy** |
| `apps/api/src/bank-account/dto/bank-account.dto.ts` | `openingBalanceCents?` (`@IsInt`) + `openingBalanceDate?` (`@IsISO8601`) em Create/Update | ✅ |
| `apps/api/src/bank-account/bank-account.service.ts` | `createAccount`/`updateAccount` convertem `openingBalanceDate` (ISO string → `Date`) | ✅ |
| `apps/api/src/monthly-overview/monthly-overview.service.ts` | `computeCaixaConta(...)` (função pura exportada) + método privado que faz as queries; resposta ganha campo `caixa` | ✅ |
| `apps/api/src/monthly-overview/caixa-conta.spec.ts` | teste unitário da §10 (resgate entra, aplicação sai, futuro fora, série acumulada) — 3 testes | ✅ passando |

**Forma do novo campo na resposta de `GET /projects/:id/monthly-overview`:**
```ts
caixa?: {
  hoje: number;            // §10: saldoInicial + Σ lançamentos realizados da conta (centavos)
  saldoInicial: number;    // Σ openingBalanceCents das contas do projeto
  temSaldoInicial: boolean;// false ⇒ `hoje` é só fluxo (não bate com banco) → UI usa fallback
  porMes: { mes: string; caixa: number }[]; // saldo acumulado ao fim de cada mês (sparkline)
}
```
Query: `Expense`/`Receipt` do projeto PESSOAL com `bankLast4 ≠ null`, não-deletados; realizados =
`Expense.status='PAGO'` (usa `valorTotal`, sinal −) e `Receipt.status='EM_CAIXA'` (usa `valor`, sinal +).

### Frontend
| Arquivo | Mudança | Status |
|---|---|---|
| `apps/web/.../monthly/_types.ts` | interface `CaixaConta` + `caixa?` em `MonthlyOverviewResponse` | ✅ |
| `apps/web/.../monthly/_cockpit/derive.ts` | `deriveCockpitTop(data)` → caixa (real ou fallback), delta, sparkline, resultado do mês + Δ%, projeção fim do mês, % do mês decorrido | ✅ |
| `apps/web/.../monthly/_cockpit/CockpitTop.tsx` | **novo** — headline narrativo + 3 cards (Caixa · Resultado · Projeção) com `Sparkline` SVG inline e `Delta` | ✅ |
| `apps/web/.../monthly/page.tsx` | substitui o bloco antigo de 2 cards ("Em caixa agora"/"Saldo projetado") por `<CockpitTop/>`; remove imports órfãos | ✅ |
| `apps/web/.../bank-accounts/_types.ts` | `openingBalanceCents?`/`openingBalanceDate?` em `BankAccountRow` | ✅ |
| `apps/web/.../bank-accounts/_components/BankAccountFormModal.tsx` | bloco "Saldo inicial (reconciliação com o banco)": input de saldo (R$) + data de referência | ✅ |

**UI do novo topo:**
- **Headline:** *"Você tem R$ 17.230 em caixa. Junho caminha pra fechar em R$ X — sobram/faltam R$ Y."* + barra de % do mês.
- **3 cards:** **Caixa (conta corrente)** com sparkline 6m + Δ no mês · **Resultado de {mês}** (entrou − saiu) com Δ% vs mês anterior · **Projeção fim de {mês}** (caixa + a receber − a pagar).
- Se `temSaldoInicial=false`: card 1 vira **"Resultado realizado"** (rótulo honesto) e mostra hint pra cadastrar o saldo inicial.

---

## 4. Como validar

```bash
# typecheck
cd apps/api && npx tsc --noEmit          # ok
cd apps/web && npx tsc --noEmit          # ok
# testes
cd apps/api && npx jest caixa-conta      # 3/3 (prova a §10)
cd apps/api && npx jest bank-account     # 55/55 (não regrediu)
```

---

## 5. Fluxo de implantação (real, confirmado no repo)

**Tudo é automático no merge pra `main`** — incluindo a migration. Stack: Web=Vercel, API=Fly.io, DB=SQLite num volume Fly em `/data/dev.db`.

1. **Abrir PR → merge na `main`.**
2. **CI** (`.github/workflows/ci.yml`) roda os gates: `lint-and-typecheck` (domain/api/web) · `test-domain` · `test-api` (jest, inclui o `caixa-conta.spec.ts`) · `build-web` (`next build`) · `build-api`.
   - ✅ Já validei local: **158/158 testes API**, typecheck limpo, `next build` ok.
3. **`deploy-api`** (só em push na `main`, se os gates passam) → `flyctl deploy` (remote-only, usa secret `FLY_API_TOKEN`).
4. **No start do container** o `/entrypoint.sh` (gerado no `apps/api/Dockerfile`) roda **`prisma migrate deploy`** → a migration `20260607200000_add_bank_account_opening_balance` **aplica sozinha** no `/data/dev.db`. Depois sobe o NestJS (e re-bootstrapa o admin, idempotente).
5. **Web:** o Vercel deploya `apps/web` no push da `main` (integração Git nativa, fora do GH Actions). `NEXT_PUBLIC_API_URL` já aponta pra `https://reformaflow-api.fly.dev`.

### Único passo manual: cadastrar o valor do saldo inicial
A migration só cria a coluna com **default 0** — o valor precisa ser inserido uma vez. Duas formas:

- **(a) Pelo app (recomendado):** Conta bancária → editar a Itaú → bloco "Saldo inicial": **R$ 14.285,97**, data **31/12/2025**. Salvar.
- **(b) Por SSH no Fly:**
  ```bash
  flyctl ssh console --app reformaflow-api
  # dentro da máquina:
  sqlite3 /data/dev.db "UPDATE bank_accounts \
    SET opening_balance_cents=1428597, opening_balance_date='2025-12-31 00:00:00' \
    WHERE last4='4247' AND project_id='<id do Pessoal em prod>';"
  ```
  > Antes, descobrir o `project_id`: `sqlite3 /data/dev.db "SELECT id,name FROM projects WHERE type='PESSOAL';"`
  > Backup rápido antes de mexer: `sqlite3 /data/dev.db .dump > /data/dev.db.bak-$(date +%F).sql`

6. **Validar em prod:** abrir o cockpit do Pessoal — card **Caixa** deve mostrar **~R$ 17.230** (bate com o banco, dif. ~R$ 0,14). Se mostrar "Resultado realizado" em vez de "Caixa", o saldo inicial não foi cadastrado (passo manual acima).

> ⚠️ **Risco de rollback da migration:** SQLite não tem `DROP COLUMN` fácil em versões antigas; a migration é puro `ADD COLUMN` (aditiva, segura). Reverter código é trivial; reverter schema exigiria migration manual — mas não é necessário (colunas novas não quebram nada existente).

---

## 6. Pendências / follow-ups conhecidos

- ✅ **FEITO (fase 2, commit `cf181e6d`): `MonthView` (aba "Mês") agora usa o CAIXA REAL.**
  `deriveMonth` rebaseia `saldoInicial`/`saldoAtual` no caixa real (`data.caixa.porMes`/`hoje`) quando há
  saldo inicial (`temSaldoInicial`), para meses ≤ corrente; meses futuros projetam a partir do caixa real
  de hoje + fluxo; fallback p/ fluxo quando não há saldo inicial (flag `MonthDerived.caixaReal`). Provado:
  `saldoAtual(mês corrente) = caixa.hoje = R$ 17.229,74`. Também corrigido bug: `buildSaldoSeries` passou a
  filtrar `isEspelho` (igual ao `deriveMonth`), evitando dobrar despesa vinculada cross-project no gráfico.
  Rótulos honestos: "Caixa na conta" (reconciliado) + gráfico "Fluxo de caixa do mês" (inclui cartão).
- **Glossário de 3 termos** (Caixa / Resultado / Projeção) e **unificar `/financeiro` e `/dashboard`**
  (hoje repetem os mesmos 6 cards genéricos) — fora do escopo desta fase, era a opção "Glossário + unificar telas".
- **Sparkline** usa `data.caixa.porMes` inteiro; se quiser limitar a 6 meses, fatiar no `deriveCockpitTop`.

## 7. Notas sobre o ambiente local (não confundir)

- O **dev.db local** está com o saldo inicial setado (Itaú 4247 = 14.285,97) **só pra teste**.
- Os dados locais do "Meu Pessoal" são o **conjunto ANTIGO** (resgate como saída) → o caixa local
  renderiza **negativo** (~−R$ 199 mil). Isso **não** representa prod (lá os resgates já estão corrigidos).
  Não é bug do cockpit; é o dado local desatualizado.
- O API que estava rodando na :3001 era um build antigo (`dist/main`); reiniciar com o código novo
  pra ver o campo `caixa` na resposta.

---

## 8. Dashboard do mês — KPIs unificados (jul/2026, `52366139`)

**Diagnóstico de redundância** (mesmos filtros de consumo em todos → valores
corretos, mas repetidos). No mês corrente:

| KPI do Extrato | = mesmo número que | Aparecia em |
|---|---|---|
| Já saiu (realizado) | "saiu" do *Resultado* = "Gastei" | CockpitTop + MonthKpis (3×) |
| Ainda vai sair (planejado) | "a pagar" da *Projeção* = "+ planejado" | CockpitTop + MonthKpis (3×) |
| Total de saídas | Já saiu + Ainda vai sair (soma) | derivado |
| Ticket médio | único (por lançamento) | só no extrato |

O antigo `MonthKpis` (Entrou/Gastei) também duplicava o *Resultado* do CockpitTop.

**Unificação aplicada:**

- **CockpitTop** (Caixa hoje · Resultado · Projeção) permanece como a visão
  canônica — a única fonte dos números do mês.
- **`MovimentoMes`** (novo, substitui `MonthKpis`): faixa única com **Entrou**
  (realiz.+prev.) · **Saiu** (realiz.+a pagar) · **Total de saídas** (+ ticket/nº
  lançs). `deriveMonth` ganhou `qtdSaidas` como fonte única do ticket.
- **`ExtratoGeral`** perde os 4 cards de KPI → vira **só a lista**, com toggle
  **Mês/Ano** e filtros de **tipo de despesa** e **mês**.

**Regras de consumo** (iguais ao resto do cockpit): exclui espelho cross-project
(`isEspelho`) e **neutro-de-consumo** (`entryIsConsumptionNeutral` — settlement +
aporte `INVESTIMENTOS`). Ver `docs/visao-conta-faturas.md §2.1/§10`.

**Resolvido em #71:** `deriveCockpitTop` recebe o mês selecionado. Os valores com
rótulo mensal, comparações e progresso acompanham a seleção; **Caixa hoje** não é
rebased e continua sendo o saldo corrente reconciliado pela §10.

### Visão Ano (mesma leva)

- **Categorias do ano** (`CategoriasBarras`): toggle **Realizado /
  Realizado+planejado** (`categoriasDoAno(..., statusMode)`) e clique na categoria
  abre `CategoriaDespesasModal` com as despesas consideradas
  (`despesasDaCategoriaAno`, mesma base das barras). No modal é possível
  **reclassificar o tipo de despesa** de cada lançamento (PATCH
  `/projects/:pid/expenses/:id` com `{ tipoDespesa }`; usa `entry.expenseId` e
  `entry.projectId`; invalida `monthly-overview`/`account-view`/yearly).
- **Árvore de gastos do ano** (`ArvoreGastos`): resumo no topo (total · nº origens),
  **Expandir/Recolher tudo** e ordenação (valor/nome).
- **"Destaques do ano"** removido (`DestaquesAno` excluído).

---

## 9. Projeção fim do mês — eixo de caixa, não competência (jul/2026, `262940a0`)

**Bug:** o card **"Projeção fim do mês"** (CockpitTop) mostrava projeção inflada
(R$ 71.999 vs R$ 56.652,82 real da Visão Conta). O "a pagar" divergia:
cockpit R$ 22.249 × Visão Conta `faltaPagarMes` R$ 37.595,70.

**Causa raiz:** `deriveCockpitTop` calculava "a pagar" por **competência** sobre
as `entries` (que vêm de `cashFlowEntry`). Isso:

1. **Ignora despesas planejadas sem `cashFlowEntry`** — planejados futuros (ex.:
   materiais da REFORMA pagos pela conta pessoal) só existem como `Expense`; a
   Visão Conta os enxerga via `buildInstallments`, o cockpit não. Em jul/2026 isso
   somava **R$ 17.419,61** invisíveis ao cockpit.
2. **Conta compras do mês no cartão** (que só saem numa fatura futura) em vez da
   **fatura vencendo no mês**.

A "a receber" batia (R$ 25.232) — só a "a pagar"/projeção estavam erradas.

**Correção:** a projeção "fim do mês" é conceito de **caixa** (§10). A fonte de
verdade já existe e está correta: **`getAccountView`** (a mesma da Visão Conta).

- **Backend** (`getOverview`): `GET /projects/:id/monthly-overview?month=YYYY-MM`
  calcula a Visão Conta do mês pedido. A URL do navegador usa `mes=YYYY-MM`; o web
  traduz esse valor para o parâmetro de API `month`. A resposta identifica a fonte:
  `projecao: { mes, status: canonical, caixaHoje, entrouMes, saiuMes, faltaPagarMes,
  recebimentosPrevistosMes, sobraPrevista }`; em erro, retorna
  `{ mes, status: degraded }`.
- **Frontend** (`deriveCockpitTop`): só aceita a projeção canônica quando `mes`
  coincide com a seleção e todos os números existem. Caso contrário usa o cálculo
  antigo por competência e mostra explicitamente **“Estimativa por lançamentos do
  mês; projeção da conta indisponível.”** Cobertura: `derive.projecao.test.ts` e
  `derive.month-aware.test.ts`.
- **Igual nos dois eixos** (Gastei/Vai sair): projeção é caixa, não muda com o
  toggle. `buildCaixaData` preserva `data.projecao` via spread.

**`computeCaixaConta` (Caixa hoje) e "Resultado realizado" NÃO foram tocados.**

**Validado em produção (2026-07):** `a pagar` R$ 37.595,70 · `a receber`
R$ 25.232,00 · `projeção` R$ 56.652,82 — idênticos à Visão Conta.

> ⚠️ **Consequência (RESOLVIDA em `262940a0`+seguintes):** os KPIs de saída do
> dashboard foram **alinhados ao eixo de caixa**. O CockpitTop agora mostra 4
> cards (sem redundância): **Caixa hoje** · **Entrou** (realizado + a receber) ·
> **Saiu** (pago + planejado, caixa) · **Sobra prevista** — todos de
> `getAccountView` (§10). Removidos o card "Resultado" (redundante com entrou−saiu)
> e a faixa `MovimentoMes` (competência, subcontava o planejado). O "Saiu (pago +
> planejado)" usa `saiuMes`/`faltaPagarMes`; a "Sobra prevista" = `sobraPrevista`.
> A visão competência ("o que comprei") vive no extrato/categorias/árvore.

## 10. Média por categoria ÷ 12 (jul/2026)

`mediaMensalPorTipo` (a "~média/mês" de cada categoria em "Categorias do ano")
passou a dividir **sempre por 12** (ano cheio normalizado), igual a
`gastoMedioMensal` e ao ticket médio geral. Antes dividia pelo nº de **meses
ativos** (com gasto pago), o que dava um número maior e inconsistente com os
demais KPIs mensais. Base inalterada: só pagas, espelho/neutro-de-consumo fora.

---

## 11. PR-3 — projeção unificada (mês × horizonte)

- **Fonte única da narrativa multi-mês:** `dreOverview.anual.saldoAcumuladoSerie`.
- **Derivação única de texto:** `deriveRunwayNarrative(...)` (reutilizada por Cockpit e Conta).
- **Cockpit:** exibe o card/gráfico completo "Vai dar até dez?" (desktop e mobile).
- **Conta:** exibe só 1 linha-resumo + link "Ver projeção no Cockpit".

Tabela de estados canônica (mês × horizonte):

| Fechamento do mês | Horizonte multi-mês | Texto |
|---|---|---|
| positivo | positivo | "No caminho" + "se mantém positivo até …" |
| positivo | negativo | "No caminho no mês, atenção no horizonte" + "fica negativo em …" |
| negativo | positivo | "Fecha no vermelho no mês" + "horizonte volta a positivo" |
| negativo | negativo | "Fecha no vermelho no mês" + "fica negativo em …" |

Regra operacional: para o **mesmo mês e mesma série**, Conta e Cockpit devem sempre mostrar o mesmo veredito de horizonte (sem contradição entre telas).
