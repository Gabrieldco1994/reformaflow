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

Vem do consolidado financeiro do usuário (`LOGICA_CONSOLIDACAO_FINANCEIRA.md`, §10):

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
