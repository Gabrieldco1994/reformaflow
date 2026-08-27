# Visão Conta — Faturas de cartão, neutros e liquidação

> **Escopo:** lógica de agregação de faturas, regra de neutros, casamento
> pagamento→fatura e "cartão paga cartão" do projeto **PESSOAL**.
> **Onde vive:** `apps/api/src/monthly-overview/monthly-overview.service.ts`
> (`getAccountView`, `getCardInvoicesYearly`, `getOriginItemsYearly`,
> funções puras `matchPaidInvoices` / `computePaidInvoiceKeys`).
> **Testes:** `apps/api/src/monthly-overview/monthly-overview.account-view.spec.ts`.
> Complementa `docs/cockpit-caixa-real.md` (caixa real §10).
> Política de timezone/data: `docs/politica-datas-timezone.md`.
> **Status (2026-08-19):** regras ativas em `main` (inclui commits `1cc93dc6`,
> `7010b95d`, `01affbcb`, `7e901b15`, `f7be2bff`, `e41461c7`).
> **B1a (#448) — MERGEADO em `main`** em 2026-08-19 (`5bbe5d69` #477, `720ff1fc` #478,
> `890b89b0` #479): `payInvoice`/`undoInvoicePayment` aceitam `cardId`/`accountId` opcionais;
> `getAccountView` emite `cardId`, `actions`, `fingerprint` em `cartoes[]` e `saidas[]` (fatura),
> `accountId` em `contas[]`. **#448 permanece OPEN pela fatia B1b.**

---

## CONTRATO (normativo — o que nunca pode quebrar)

1. Fatura é espelho bancário por chave interna `{dueMonth}__{cardLast4}`.
2. `dueMonth` de compra no cartão vem de `caixaMonthForCardPurchase`.
3. Neutro cobrado **no cartão** entra no espelho da fatura, mas não entra em gasto real.
4. Neutro pago **pela conta** (`bankLast4`) não compõe fatura e só afeta caixa da conta.
5. Casamento implícito pagamento→fatura (`matchPaidInvoices`) é por cartão + menor diferença de valor na janela `{payMonth, payMonth+1}`.
6. Quitação implícita integral só ocorre com tolerância: `|pagamento - fatura| <= max(R$2, 0,5% do total)`.
7. Pagamento fora da tolerância NÃO quita automaticamente: vira pagamento parcial e reduz `pending`.
8. Múltiplos pagamentos implícitos no mesmo ciclo somam na mesma fatura.
9. Quitação explícita (`settlesInvoiceKey`) soma múltiplas fontes e só marca paga quando soma >= total efetivo da fatura.
10. Ajuste manual (`InvoiceAdjustment`, exceto `QUITACAO_RESIDUO`) altera o espelho da fatura e NÃO entra em gasto real nem em caixa.
11. Quitação com resíduo declarado (`reason=QUITACAO_RESIDUO`) fecha a fatura quando `pago >= total - resíduo`, mantendo trilha auditável.
12. Pagamento manual de fatura permite múltiplos pagamentos no mês; idempotência é por payload exato (cartão+conta+valor+data), não por mês.
13. Cobrança "cartão paga cartão" sem `bankLast4` não mexe no caixa; apenas o lançamento de conta mexe.
14. DRE/visões de consumo excluem neutros de settlement (`PAGAMENTO_FATURA_CARTAO`, `MOVIMENTACAO_INTERNA`).
15. **I1:** `computeCaixaConta` permanece type-agnóstico; aporte/resgate saem do consumo, não do caixa.
16. **§7-1:** Fatura = banco (inclui neutro no cartão e ajustes manuais).
17. **§7-2:** Gasto real exclui neutros e ajustes de fatura.
18. **§7-3:** Caixa só com `bankLast4`.
19. **§7-4:** Quitação explícita soma por alvo; quitação implícita exige tolerância.
20. **§7-5:** Pagamento próximo do vencimento casa no mês de vencimento (não no mês do pagamento).
21. **§7-6:** Neutro-de-consumo (aporte/resgate) sai do consumo, mas permanece no caixa.
22. **§13-1:** Na visão ANUAL, todo campo de **fluxo** e toda **lista** é exatamente a soma/concatenação dos 12 meses (`ano.X === Σ mes[i].X`).
23. **§13-2:** Saldos **pontuais** (`caixaHoje`, `carteiraHoje`, `devoCartaoTotal`) nunca são somados e, se exibidos no ano, são rotulados **"hoje"** — nunca "no ano".
24. **§13-3:** `sobraPrevista` anual mistura `caixaHoje` (pontual) com fluxo do ano **de propósito** ("com o caixa de hoje, eu atravesso o ano?") — não é bug, e o rótulo do card precisa dizer isso.
25. **§13-4:** A visão do **mês** é a tela em produção: `mode`/`period`/`monthFilter` são opcionais com default mensal e o comportamento mensal não pode mudar.
26. **§15-1 (B1a):** `payInvoice` e `undoInvoicePayment` aceitam `cardId`/`accountId` opcionais. Quando presentes, resolvem estritamente `{id, tenantId, projectId, deletedAt:null}`; ID ausente ativa o fallback legacy por `last4`. ID+last4 em conflito → 400 sem nenhuma escrita (verificado antes de qualquer `create`/`update`).
27. **§15-2 (B1a):** `getAccountView` emite `cardId`, `fingerprint` (`\`${cardId}:${dueMonth}\``) e `actions: ('pay'|'undo')[]` em `cartoes[]` e na linha `saidas[]` com `isInvoice:true`. `contas[]` emite `accountId`. `fingerprint` é nulo quando o cartão não pode ser resolvido. Só verbos atualmente executáveis aparecem em `actions`: `'pay'` quando `pending>0`, `'undo'` apenas quando exatamente um pagamento implícito está casado.
28. **§15-3 (B1a):** `dueMonth`, `settlesInvoiceKey`, `invoiceKey` e todas as fórmulas numéricas de caixa/fatura/neutro **não foram alterados**; B1a é puramente aditivo.

## Referência de implementação

- Serviço principal: `apps/api/src/monthly-overview/monthly-overview.service.ts` (`getAccountView`, `getCardInvoicesYearly`, `getOriginItemsYearly`, `matchPaidInvoices`, `computePaidInvoiceKeys`, `payInvoice`, `undoInvoicePayment`).
- Fila financeira W1 (`GET /projects/:projectId/pendencias/financeiras`) deriva pendências **a partir do `getAccountView`** (mesma fonte e mesmos invariantes; sem motor paralelo de caixa/fatura). W1 consome `cardId`/`actions`/`fingerprint` numa etapa futura — **W1 (#214) segue aberto**.
- Ajustes manuais: `apps/api/src/monthly-overview/invoice-adjustment.controller.ts`, `apps/api/src/monthly-overview/dto/invoice-adjustment.dto.ts`.
- Dependências de regra: `packages/domain/src/calculations/card-cash-month.ts`, `packages/domain/src/enums/index.ts`.
- Endpoint/controller: `apps/api/src/monthly-overview/monthly-overview.controller.ts`, `POST/DELETE /projects/:projectId/invoice-adjustments`.
- Testes que blindam contrato: `apps/api/src/monthly-overview/monthly-overview.account-view.spec.ts`, `apps/api/src/monthly-overview/caixa-conta.spec.ts`.

## Apêndice histórico

## 1. Conceitos

- **Fatura (espelho do banco):** soma das compras de um cartão com vencimento num
  dado mês (`dueMonth`). Deve **espelhar exatamente** o valor cobrado pelo banco.
- **Gasto real:** o que de fato é consumo (exclui neutros). Alimenta
  `comprasCartao`, ticket médio e cash-axis.
- **Caixa (§10):** saldo da conta corrente. Só lançamentos com `bankLast4 ≠ null`
  e realizados afetam o caixa (ver `docs/cockpit-caixa-real.md`).

A chave interna de fatura é **`{dueMonth}__{cardLast4}`** (ex.: `2026-07__3541`).
O mês de vencimento vem de `caixaMonthForCardPurchase(data, closingDay, dueDay)`
(`packages/domain/src/calculations/card-cash-month.ts`).

---

## 2. Regra dos neutros (confirmada com o usuário)

Tipos neutros = `isNeutralExpenseType(tipoDespesa)` (ex.: `PAGAMENTO_FATURA_CARTAO`).
São movimentos que **não são consumo** (pagar cartão, "Pix no crédito", transferir).
A classificação depende de **onde a cobrança cai**:

| Caso | `cardLast4` | `bankLast4` | Entra na fatura? | Afeta caixa? | Gasto real? |
|---|---|---|---|---|---|
| Cobrança **no cartão** (Pix no crédito, PgConta, cartão-paga-cartão) | ✅ | ✗ | **SIM** (espelha o banco) | Não | Não |
| Pagamento **via conta** (PIX/débito da fatura) | (opcional) | ✅ | **NÃO** | **SIM** (debita) | Não |

No código (`getAccountView`, agregação de fatura):
```ts
// neutro pago a partir de uma CONTA (bankLast4) NÃO entra em nenhuma fatura
if (isNeutralExpenseType(entry.expense.tipoDespesa) && entry.expense.bankLast4) continue;
```
`comprasCartao` / ticket / cash-axis **excluem todos os neutros**
(`!isNeutralExpenseType(...)`). `devoCartaoTotal` soma o `pending` das faturas.

> Por que importa: garante que a fatura **bate com o banco** (inclui a cobrança
> neutra que o banco cobrou no cartão) sem **inflar o gasto real nem o caixa**.

Origem: commit `1cc93dc6` (`fix(conta): fatura inclui cobrança neutra no cartão`).

### 2.1 Dois conceitos de neutro (settlement × consumo)

Há **dois** tipos de "neutro", com efeitos diferentes — não confundir:

| Conceito | Enum/helper | Conjunto | Sai do consumo? | Sai do eixo de caixa? |
|---|---|---|---|---|
| **Neutro-de-caixa (settlement)** | `isNeutralExpenseType` / `isNeutral` | `PAGAMENTO_FATURA_CARTAO`, `MOVIMENTACAO_INTERNA` | Sim | **Sim** (a saída já está noutro lançamento) |
| **Neutro-de-consumo** | `isConsumptionNeutralExpenseType` / `isNeutralConsumo` | despesas: settlement **∪ `INVESTIMENTOS` ∪ `PAGAMENTO_CASA`**; recebimentos: **`RESGATE`, `TRANSFERENCIA_PROPRIA`** | Sim | **Não** — é saída/entrada de caixa **nova e real** |

- **Aporte (`INVESTIMENTOS`)**: não é consumo → fora do gasto/média/categorias/
  resultado; mas o dinheiro **saiu da conta** → permanece no eixo de caixa e no §10.
- **Resgate (`RESGATE`)**: retorno de principal → fora da receita; mas o dinheiro
  **entrou** → permanece no eixo de caixa. Já **rendimentos** (`JUROS_RENDA_FIXA`)
  são receita real e **contam**.
- **`PAGAMENTO_CASA`** é aporte para o lar, não consumo;
  **`TRANSFERENCIA_PROPRIA`** movimenta dinheiro próprio, não é renda. Ambos
  permanecem no caixa real.
- Fonte única: `packages/domain/src/enums/index.ts`
  (`CONSUMPTION_NEUTRAL_EXPENSE_TYPES`, `NEUTRAL_RECEIPT_TYPES`).
- Detalhes e validação em produção: **§10** deste doc.

---

## 3. Casamento pagamento → fatura (mesmo cartão, por valor)

`matchPaidInvoices(invoices, payments)` decide quais faturas estão **pagas** quando
o pagamento é feito **via conta, do próprio cartão** (`PAGAMENTO_FATURA_CARTAO`,
`status='PAGO'`, com `bankLast4` e `cardLast4`, **sem** `settlesInvoiceKey`).

**Problema que resolve:** faturas com vencimento **dia 1** (Nubank/Latam) são pagas
no **fim do mês anterior**. Casar pelo *mês do pagamento* marcaria a fatura errada
(a do mês de pagamento, não a do vencimento).

**Algoritmo:** por cartão, em ordem cronológica, casa cada pagamento à fatura **de
menor diferença de valor** dentro da janela `{payMonth, payMonth+1}`, consumindo
cada fatura **uma única vez**. Tolera centavos de arredondamento (ex.: pagamento
24.010,33 ↔ fatura 24.010,31).

Origem: commit `7010b95d` (`fix(conta): casa pagamento de fatura por valor, não só por mês`).

### Exemplo real (Nubank 3541)
| dueMonth | Fatura | Pago em | Valor pago | Status |
|---|---|---|---|---|
| 2026-06 | 4.420,34 | 28/05 | 4.420,34 | paga |
| 2026-07 | 24.010,31 | 22/06 | 24.010,33 | **paga** (antes aparecia "a pagar") |

---

## 4. Cartão paga cartão / PIX cruzado (vínculo explícito)

Quando uma cobrança quita a fatura de **OUTRO** cartão — e há **juros** ou
**pagamento parcial** — não dá para casar por valor. Usa-se vínculo **explícito**.

**Campo:** `Expense.settlesInvoiceKey` (`String?`), formato **`"{cardLast4}:{dueMonth}"`**
(ex.: `"7259:2026-06"` = "esta despesa quita a fatura do Latam que vence em jun/2026").
Migration `20260624151508_add_settles_invoice_key` (aditiva, `ADD COLUMN`).

**`computePaidInvoiceKeys(invoices, implicitPayments, explicitSettlements)`** une:
- **implícito:** `matchPaidInvoices` (seção 3) — pagamentos via conta do próprio cartão;
- **explícito:** soma os `settlesInvoiceKey` por fatura alvo e marca **paga quando a
  soma ≥ total** da fatura (cobre juros/parciais).

**Sem inflar caixa:** a cobrança "cartão paga cartão" não tem `bankLast4` → não toca
o caixa; só o PIX via conta (que tem `bankLast4`) debita, como deve.

Despesas com `settlesInvoiceKey` são **removidas do casamento implícito** para não
interferir. Helper `settlesInvoiceKeyToInternal` converte `"{cardLast4}:{dueMonth}"`
→ `"{dueMonth}__{cardLast4}"`.

Origem: commit `01affbcb` (`feat(conta): cartão paga cartão quita a fatura do cartão pago`).

### Exemplos reais (jun/2026)
- **Nubank maio (5.347,15)** quitado pela cobrança **"PgConta NU"** no **Latam**
  (5.597,83 = fatura + **250,68 de juros** por pagar cartão com cartão).
  → `settlesInvoiceKey = "3541:2026-05"` na despesa do Latam.
- **Latam junho (15.677,55)** quitado por **duas** fontes somadas:
  - "Itaú Unibanco" 6.492,40 (cobrança no **Nubank**) → `settlesInvoiceKey="7259:2026-06"`;
  - PIX 9.185,15 (conta 3636, 18/05) → `settlesInvoiceKey="7259:2026-06"`.
  - 6.492,40 + 9.185,15 = 15.677,55 ✓.

> ⚠️ **Espelho da fatura é independente do vínculo:** a cobrança "PgConta NU" no
> Latam **compõe** a fatura do Latam (espelho) **e** quita a do Nubank (vínculo).
> São papéis distintos — não confundir ao montar fixtures de teste.

---

## 5. Gráfico anual de faturas (Visão Ano)

- **`getCardInvoicesYearly(tenant, project, year)`** → `{ origins[], months[].porOrigem }`.
  `origins` inclui **cartões** (`kind:'card'`), **conta corrente** (`kind:'conta'`) e a
  pseudo-origem **Carteira** (`kind:'carteira'`, `last4:''`) — despesa sem cartão E sem
  conta (§11 / regra de ouro 14): só aparece quando há dado no ano, e segue a mesma
  regra da conta (neutro de consumo fora, mês por competência), igual à variante
  `kind='all'` do `getOriginItemsYearly`.
  Aplica a regra de neutros (seção 2) na composição de cada fatura.
  - **`transferenciasPorOrigem` / `transferenciasAno`** (aditivo, jul/2026): a parcela de
    `porOrigem` que é **"cartão paga cartão"** — cobrança neutra no cartão com
    `settlesInvoiceKey` (quita a fatura de OUTRO cartão). **Já está DENTRO de `porOrigem`** e
    permanece lá: a fatura tem de bater com o banco (§7-1). O campo existe porque **somar as
    faturas de todos os cartões conta esse dinheiro duas vezes** — as compras originais já
    estão na fatura de origem —, então a tela qualifica o total agregado ("inclui R$ X de
    fatura paga com outro cartão") **sem alterar barra nenhuma**. Cobrança neutra no cartão
    SEM vínculo não entra na conta: sem `settlesInvoiceKey` o app não sabe que houve quitação.
- **Este total NÃO é comparável ao KPI "Despesa &lt;ano&gt;" do Cockpit** — são grandezas
  distintas de propósito. Gráfico = **faturas**, escopo PESSOAL, inclui espelho cross-project
  e neutro-no-cartão. KPI = **gasto real**, consolidado (todos os projetos), sem neutros e
  sem espelho (conta o canônico do outro projeto). Divergir é o comportamento correto;
  não "conserte" um para casar com o outro.
- **`getOriginItemsYearly(tenant, project, {year, kind, last4})`** → despesas de uma
  origem agrupadas por mês (para a lista "despesas relacionadas").
  - **`kind='all'`** (sem `last4`): agrega **todas as origens** do ano num só
    conjunto, cada item com seu rótulo de `origem` (`{kind,last4,nickname}`).
    Mesmas regras de neutro/mês por origem — o total bate exatamente com o
    `totalAno` do `getCardInvoicesYearly`. Alimenta a opção **"Todos"**.
- **Endpoints:** `GET .../card-invoices-yearly?year` e
  `GET .../origin-items-yearly?year&kind&last4` (ou `kind=all`).
- **Frontend:** `conta/page.tsx` (toggle Mês/Ano) → `_components/ContaAnoView.tsx`
  (filtro de origem, clique no mês) + `_components/FaturasAnuaisChart.tsx`.
  A **lista** do ano é a `MovimentacoesSection` no `mode="ano"` — ver §13.
  > Os componentes `DespesasRelacionadas.tsx` e `TodasDespesasAno.tsx` foram
  > **removidos** em favor da lista canônica (§13). `getOriginItemsYearly` continua
  > vivo e é consumido por outras telas (`MobileExpensesScreen`,
  > `CategoriaDespesasModal`, `MobileLaunchSheetContainer`).

Origem: commits `7e901b15` (gráfico), `f7be2bff` (filtro origem + conta + despesas),
`e41461c7` (clique na barra do mês filtra despesas).

> ⚠️ **Colisão de last4:** existem 2 contas com last4 `3636` (Itaú e NUBANK). No
> gráfico fundem numa série só (o `bankLast4` das despesas é `"3636"`).

---

## 6. Modelos de parcela que coexistem

Ambos são lidos via `cash_flow_entries`, então o gráfico e a fatura funcionam para os dois:

- **CONSOLIDADO** (ex.: 5572): 1 `Expense` com `valorTotal=soma`, `quantidadeParcela=N`,
  `forma=PARCELADO` + N `cash_flow_entries` com valores exatos por mês.
- **POR-PARCELA** (Nubank/Latam/5868): 1 `Expense` por parcela.

---

## 7. Invariantes (o que deve sempre valer)

1. **Fatura = banco:** o total da fatura (espelho) inclui neutros cobrados no cartão.
2. **Gasto real exclui neutros:** `comprasCartao`/ticket/cash-axis nunca somam neutro.
3. **Caixa só com `bankLast4`:** cobrança no cartão (sem banco) jamais altera o caixa.
4. **Cada fatura quita uma vez:** casamento implícito consome a fatura; explícito soma
   por alvo e marca paga só quando cobre o total.
5. **Pagamento dia-1 cai no vencimento, não no mês de pagamento** (janela `{m, m+1}`).
6. **Neutro-de-consumo (aporte/resgate) sai do consumo mas NÃO do caixa** (§2.1/§10):
   marcar `INVESTIMENTOS` como settlement (erro) infla o "Caixa hoje" em +R$112k.

---

## 8. Como validar

```bash
cd apps/api && npx jest monthly-overview.account-view   # casos de neutro, matching e cross-card
cd apps/api && npx jest                                  # suíte completa (227 testes)
```

Validação **live** em prod (serviço compilado, sem HTTP/JWT):
```js
const { MonthlyOverviewService } = require('/app/apps/api/dist/monthly-overview/monthly-overview.service');
const svc = new MonthlyOverviewService(prisma, { settleInvoice: async()=>({}) });
const r = await svc.getAccountView('dev-tenant-1', '<projectId>', '2026-07');
// r.cartoes[].faturaAtual / .status ; r.devoCartaoTotal ; r.caixaHoje
```
Acesso: Fly `reformaflow-api` (máquina auto-suspende; `flyctl machine start <id>`).
**Sempre backup antes de mutação:** `cp /data/dev.db /data/dev.db.bak-<desc>-<ts>`.

---

## 9. Histórico de mudanças (esta sessão, jun/2026)

| Commit | Mudança |
|---|---|
| `1cc93dc6` | Fatura inclui cobrança neutra cobrada no cartão (regra de neutros §2) |
| `7e901b15` | Gráfico anual de faturas por cartão |
| `f7be2bff` | Filtro por origem + conta corrente + despesas relacionadas |
| `e41461c7` | Clicar na barra do mês filtra as despesas do mês |
| `7010b95d` | Casamento pagamento→fatura por valor+janela (`matchPaidInvoices`) |
| `01affbcb` | Cartão paga cartão quita a fatura paga (`settlesInvoiceKey` + `computePaidInvoiceKeys`) |
| `59a10d90` | **INVESTIMENTOS como neutro-de-consumo** (aporte fora do gasto, resgate fora da renda, caixa inalterado) — ver §10 |
| `52366139` | Visão Conta ano ganha opção **Todos** (`origin-items-yearly?kind=all`) com filtros de tipo e mês |
| `262940a0` | Cockpit: **projeção fim do mês** usa caixa (§10) via `getAccountView`, não competência — casa com a Visão Conta (a pagar R$ 37.595,70 / projeção R$ 56.652,82) |

**Correções de dados em prod (com backup, validadas live):**
- 5572: removido lançamento fantasma 162,36; criadas 6 séries; Acqualeste linkado à planejada.
- 5868: criados Mambo 238,77 + Outback 290,00 (jun).
- Conta 3636: criados JB Caça 500, RMD Eng 8.000, NU Pagament 24.010,33 (neutro), rendimentos.
- Vínculos cross-card: `settlesInvoiceKey` em PgConta NU (Latam→Nubank mai) e Itaú (Nubank→Latam jun);
  criado PIX 9.185,15 (18/05) que faltava para fechar o Latam jun.
- Criada entrada **PIX recebido 9.185,15 (18/05)** que cobriu o PIX de saída do Latam →
  `caixaHoje` voltou ao real **R$ 7.576,29**.

---

## 10. INVESTIMENTOS como neutro-de-consumo (jul/2026, `59a10d90`)

**Problema:** aporte/investimento aparecia como "despesa" (inflava gasto médio,
categorias e resultado) e resgate como "receita" — distorcendo consumo e projeção.

**Decisão do usuário (A+A):** (A) rendimentos seguem como **receita real**; só
aporte↔resgate viram neutro. (A) resultado = receita − despesa-de-consumo; o
"guardado" (aporte) vira só informação, **não reduz** o resultado.

**Implementação** (ver §2.1 para os dois conceitos de neutro):

- **Domain** (`enums/index.ts`): `CONSUMPTION_NEUTRAL_EXPENSE_TYPES` (= settlement
  ∪ `INVESTIMENTOS`), `isConsumptionNeutralExpenseType`; `NEUTRAL_RECEIPT_TYPES`
  (= `RESGATE`), `isNeutralReceiptType`.
- **Backend** (`monthly-overview.service.ts`): enrich emite `isNeutralConsumo` por
  lançamento; ramos de **consumo** (categorias/DRE/yearly conta) usam
  `isConsumptionNeutralExpenseType`; ramos de **settlement/fatura** seguem com
  `isNeutralExpenseType`. DRE pula `RESGATE` na receita; resultado sem `− guardado`.
- **Frontend** (`_cockpit/`): `entryIsConsumptionNeutral` (superset de
  `entryIsNeutral`); KPIs/gráficos/árvore/extrato de **consumo** trocam para ele;
  o **eixo de caixa** (`isNeutralAccountSettlement`) permanece intacto.

**Invariante I1 (crítico):** `computeCaixaConta` é type-agnóstico — soma toda
despesa PAGO com `bankLast4`, **sem olhar neutro**. **Não foi tocado.** Aporte
continua debitando o caixa; resgate continua creditando.

**Validado contra snapshot de produção (2026):**

| KPI | Antes | Depois |
|---|---|---|
| Despesa do ano | 743.589,81 | **631.098,87** |
| Receita do ano | 611.905 | **499.413,96** (só resgate R$113k saiu) |
| Gasto médio/mês (÷12) | 44.263,19 | **34.888,95** |
| Categorias do ano | tinha "Investimentos" | **sem "Investimentos"** |
| **Caixa hoje (§10)** | 69.016,52 | **69.016,52 — INALTERADO** |

Confirmado live: os 5 lançamentos `INVESTIMENTOS` e os 5 recebimentos `RESGATE`
emitem `isNeutralConsumo=true`; `caixa.hoje` permaneceu R$ 69.016,52.

> **Duas “sobras”, dois horizontes:** `getAccountView(..., mês).sobraPrevista` é a
> sobra **daquele mês** usada pelo overview mensal canônico. Na tela Visão Conta, o
> card de mês futuro prefere o `saldoProjetado` da série anual: runway
> **acumulado**, carregando sobras ou faltas dos meses anteriores. Se a série não
> estiver disponível, a tela volta à sobra mensal da account-view.
>
> **Onde cada coisa aparece (PR-3):** o detalhamento completo do runway ("Vai dar até
> dez?" com curva/cenários) fica no **Cockpit** (mobile + desktop). A **Visão Conta**
> mantém só a linha-resumo de horizonte com deep-link para o Cockpit, para evitar
> narrativas contraditórias entre telas.

---

## §11 Carteira / Pseudo-origem "Sem conta"

**Definição:** uma saída é *Carteira* quando `kind='saida' && !isInvoice && cardLast4===null && bankLast4===null` — ou seja, um lançamento de despesa sem cartão nem conta bancária vinculada.

**Por que existe:** historicamente, saídas sem vínculo de origem (`origin:'none'`) eram descartadas silenciosamente em `getAccountView`, tornando a Conta uma tela incompleta — dinheiro desaparecia do consolidado. A regra de ouro: **toda movimentação do PESSOAL sem cartão/conta pertence à Carteira e DEVE aparecer na Visão Conta e nos totais**.

**Inclusão nos totais:**
- `saiuMes` (caixa) inclui saídas Carteira realizadas no mês.
- `faltaPagarMes` inclui saídas Carteira pendentes.
- O backend `getAccountView` emite `origem: { tipo: 'carteira' }` nesses itens (ver `monthly-overview.service.ts`, seção `carteiraPaidThisMonth`/`carteiraUnpaidThisMonth`).

**Chip "Sem conta":** na linha de movimentação (`MovimentacaoRow`), saídas Carteira exibem o chip discreto "Sem conta" (cinza, `rounded-full`). O chip é clicável e abre o fluxo de vínculo (`onVincular` → `BulkLinkModal`) respondendo "de onde saiu esse pagamento?".

**Dedupe após conciliação:** quando um item Carteira é vinculado a uma conta/cartão (`onVincular`), o backend atualiza `bankAccountId`/`creditCardId`, e na próxima carga `getAccountView` o item muda de origem. O total **não muda** — o item é contado 1× antes e depois da conciliação.

**Interação com neutros:** itens Carteira de tipo neutro (`isConsumptionNeutralExpenseType`) são filtrados de movimentação via `isNeutralMovimentacao`, igual aos demais neutros — não aparecem na lista mas continuam nos totais de caixa.

**Interação com espelho cross-project:** itens Carteira podem ser alvos de vínculo/rateio cross-project (origem PESSOAL). O vínculo gera espelho; o espelho herda o `bankAccountId` definido no PESSOAL.

**Filtro "Sem conta":** em `MovimentacoesSection`, o toggle "Sem conta" (estado `semContaFilter`) restringe a lista a itens `isCarteiraItem`. Oculto na aba Entradas.

**Gráfico anual (jul/2026):** `getCardInvoicesYearly` descartava a Carteira em silêncio (`else { continue }`),
violando esta regra — o item aparecia na lista de `getOriginItemsYearly(kind='all')` mas sumia do total do
gráfico, então a mesma tela mostrava dois universos diferentes. Hoje a Carteira é uma pseudo-origem do
gráfico (`kind:'carteira'`, `key:'carteira'`, `last4:''`), emitida só quando há dado no ano, com a MESMA
regra da conta: neutro-de-consumo fora, mês por competência. Chip com ícone `Wallet` e rótulo sem `last4`.

## §12 Pagamento de fatura sem cartão identificado (jul/2026)

**O bug real:** o import de extrato criou uma despesa `PAGAMENTO_FATURA_CARTAO` de
R$ 17.655,85 com `cardLast4: null` — `findMatchingCreditCard` só sabia casar contra o
total de uma `CreditCardStatementImport`, e a fatura nunca tinha sido importada.

**Por que é grave — dinheiro contado 2×:**

| motor | comportamento com `cardLast4: null` |
|---|---|
| `computeCaixaConta` §10 | debita o caixa (olha `status='PAGO'` + `bankLast4`) — correto, o dinheiro saiu |
| `getAccountView` (quitação de fatura) | **ignora** (exige `!!cardLast4`) → a fatura continua em aberto |
| `accountExpenseList` | **exclui** (tipo neutro) → o item não aparece em nenhuma lista da Conta |
| fila "Precisa de você" (`SEM_CONTA`) | não pegava (filtra `!bankLast4`, e o pagamento tem banco) |

Resultado: o valor saía do saldo E continuava sendo cobrado como fatura pendente, sem
nenhuma pista na UI.

**Identificação do cartão (`bank-account/card-invoice-match.ts`, módulo puro):**
a fatura em aberto **não precisa ter sido importada** — o total dela é derivado das
compras do cartão agrupadas por mês de vencimento com `caixaMonthForCardPurchase`, a
mesma regra que a Visão Conta usa para montar `invoiceByMonthCard`.

- `aggregateInvoiceTotals(card)` → total por mês de vencimento.
- `rankCardCandidates(cards, valor, data)` → candidatos nos meses `[-1, 0, +1]`
  relativos ao pagamento, ordenados por `|delta|` (limite 6).
- `pickUniqueCardMatch(candidates)` → auto-match **estrito**: só decide quando todos os
  candidatos dentro de `CARD_MATCH_TOLERANCE_CENTS` (R$ 2) são do MESMO cartão. Dois
  cartões empatados = ambíguo, e chutar é pior que perguntar.

**Por que o auto-match não basta:** no caso real a fatura ago/2026 do cartão 5572 somava
R$ 18.428,13 contra um pagamento de R$ 17.655,85 — delta de R$ 772,28. Pagamento parcial,
encargos e compras lançadas depois fazem o valor exato ser exceção, não regra. Daí o
desenho em três camadas:

1. **Preview do import** — a linha mostra o seletor "qual cartão isso quita?" com os
   candidatos ranqueados; `decisions[].overrides.cardLast4` carrega a escolha.
2. **Resultado do commit** — `unlinkedCardPayments` conta os pagamentos que ficaram sem
   cartão (antes o contador dizia "vinculado" mesmo sem vincular nada).
3. **Rede de segurança** — o que escapar vira pendência `PAGAMENTO_FATURA_SEM_CARTAO` na
   fila "Precisa de você". Ela **não** pode ser sourceada de `accountView.saidas`
   (neutros são excluídos de `accountExpenseList`): `pendencia.service.ts` faz query
   própria em `Expense`. Resolver = `PATCH /expenses/:id { creditCardId }`, sem mutação nova.

**Invariante:** nenhuma despesa `PAGAMENTO_FATURA_CARTAO` deve existir com
`cardLast4: null`. Se existir, ela é invisível na Conta e o caixa está errado — a fila é
a única superfície que a denuncia.

**Correção do dado histórico:** basta preencher `cardLast4`. A quitação é calculada em
leitura (`computeInvoiceSettlementTotals`), não persistida — não há status a corrigir.

---

## §13 Visão Conta ANUAL (jul/2026)

A aba **"Ano todo"** deixou de ser só um gráfico de faturas: passou a ser a mesma
Visão Conta do mês, com o período esticado para 12 meses.

**Backend:** `getAccountViewYearly(tenant, project, year)` (`monthly-overview.service.ts`),
`GET .../monthly-overview/account-view-yearly?year=YYYY`. Ele resolve o Hub (âncora PESSOAL +
escopo autorizado) **uma vez** (B0 #447) e chama o núcleo privado que `getAccountView` também usa
(`computeAccountView`) **12 vezes** e consolida. Não existe uma segunda agregação: se o
número do ano divergir do mês, o bug está no mês.

**Frontend:** `conta/_components/ContaAnoView.tsx` (orquestra as 2 queries) →
`FaturasAnuaisChart` + `ResumoCards period="ano"` + `MovimentacoesSection mode="ano"`.

### 13.1 Campos de FLUXO vs campos PONTUAIS (a distinção que não pode ser perdida)

| Campo | Natureza | Ano é… | Rótulo na UI anual |
|---|---|---|---|
| `entrouMes` | fluxo | **soma dos 12 meses** | "Entrou no ano" |
| `saiuMes` | fluxo | **soma dos 12 meses** | "Saiu no ano" |
| `faltaPagarMes` | fluxo (**só saídas**) | **soma dos 12 meses** | "Ainda falta pagar no ano" |
| `recebimentosPrevistosMes` | fluxo (**só entradas**) | **soma dos 12 meses** | nota "inclui … previsto ainda a entrar" no card **Sobra prevista** |
| `saidas[]`, `entradas[]`, `comprasCartao[]` | fluxo (listas) | **concatenação dos 12 meses** | lista agrupada por mês |
| `caixaHoje` | **PONTUAL** | valor de **um** mês (idênticos) | "Tenho na conta **hoje**" |
| `carteiraHoje` | **PONTUAL** | valor de **um** mês | "Carteira (dinheiro) **hoje**" |
| `devoCartaoTotal` | **PONTUAL** | valor de **um** mês | não exibido no ano |

**Por que pontual nunca soma:** `computeCaixaConta` e o cálculo de `carteiraHoje`/
`devoCartaoTotal` varrem **todo o histórico** e ignoram `mesSelecionado` — os 12 meses
devolvem o MESMO número. Somar inflaria 12×. Medido no banco de QA:
`caixaHoje` do ano = `-20.506.238` (igual ao mês); a soma dos 12 seria `-246.074.856`.

**Invariante de aceite** (provado contra a API real, e travado em teste):
`ano.X === Σ mes[i].X` para `entrouMes`, `saiuMes`, `faltaPagarMes`,
`recebimentosPrevistosMes` e para o **comprimento e a soma** de `saidas[]`,
`entradas[]`, `comprasCartao[]`. Idêntico, não "parecido".

### 13.2 `sobraPrevista` anual — mistura pontual com fluxo DE PROPÓSITO

```ts
sobraPrevista = caixaHoje - faltaPagarMes + recebimentosPrevistosMes
//               ^pontual    ^fluxo do ano     ^fluxo do ano
```

Isto **não é um bug** e já foi reaberto como tal antes. A pergunta que o card responde é:

> "Com o caixa que eu tenho **hoje**, eu atravesso o ano?"

Uma "sobra do ano" puramente de fluxo (`entrou − saiu`) responderia outra pergunta e
seria inútil para decidir hoje. Por isso o rótulo do card diz na cara
`"com o caixa de hoje, atravessando o ano"` (`CARDS_ANO.sobraPrevista` em
`ResumoCards.tsx`) — **não remova esse rótulo**, ele é o que impede a releitura errada.
Negativo = o ano fecha no vermelho mantendo o plano atual.

### 13.3 Cartões não têm tiles na visão anual

`CartoesSection` **não** é renderizada no ano: o `faturaAtual` anual é a soma de 12
faturas e o `vencimento` é o de janeiro — pagar a partir desse número pagaria a fatura
errada. Quem quer pagar clica na **linha da fatura** na lista; a linha carimba o
`dueMonth` dela, o app troca para a visão daquele **mês** e só então abre o diálogo
(`onInvoiceAction` em `ContaAnoView` → `page.tsx`). Lá o número é o da fatura real.

### 13.4 A lista do ano é a lista do mês (uma tela só)

`MovimentacoesSection` ganhou `mode` (`'mes'` default | `'ano'`). No `'ano'`:

- agrupa por **mês** (`groupByMovementMonth`) em vez de por dia, mantendo o `sortDir`
  (default `desc` = mais recentes primeiro, como as listas anuais antigas faziam);
- cada cabeçalho de mês fecha o próprio subtotal (nº de lançamentos + entradas/saídas);
- ganha um filtro **"Mês do ano"**, alimentado também pelo clique na barra do gráfico;
- filtro de **tipo de despesa**, busca, status, projeto e origem são os mesmos do mês.

Isso substituiu `DespesasRelacionadas.tsx` (drill origem+mês) e `TodasDespesasAno.tsx`
(lista "Todos" com filtros tipo/mês). Ganho real: aquelas listas liam
`getOriginItemsYearly` — uma **segunda** agregação, que podia divergir do mês. Agora a
lista anual é literalmente a mesma da mensal, sobre a mesma base.

**"O mês não regride"** é invariante: `mode`, `monthFilter` e `period` são opcionais com
default mensal, e há teste explícito de que sem eles a tela em produção continua
idêntica (`MovimentacoesSection.anual.test.tsx`, `ResumoCards.periodo.test.tsx`).

### 13.5 Regra de ouro 14 vale igual no ano

Movimentação sem cartão/conta pertence à pseudo-origem **Carteira** (§11) e aparece na
lista e nos totais do ano, com o chip **"Sem conta"** clicável. `origin:'none'` **nunca**
é filtrado para fora. No banco de QA são 170 saídas sem conta no ano — todas visíveis.
O card "Saiu no ano" mostra `inclui R$ X sem conta vinculada` (`sumSaidasSemConta`,
extraída para `_lib.ts` justamente para mês e ano usarem a MESMA conta).

### 13.6 Cache

Mutação de despesa invalida `account-view-yearly` e `card-invoices-yearly` além de
`account-view` (`expenses/_hooks/useExpenseMutations.ts` + `invalidateConta` em
`conta/page.tsx`). Sem isso, editar uma linha dentro do "Ano todo" não refletia na
própria lista que a originou.

**Testes:** `apps/api/src/monthly-overview/monthly-overview.account-view-yearly.spec.ts`
(backend), `conta/_lib.test.ts`, `conta/_components/MovimentacoesSection.anual.test.tsx`,
`conta/_components/ResumoCards.periodo.test.tsx` (frontend).

---

## §14 Desfazer pagamento de fatura (jul/2026)

**O que faz:** `POST /projects/:projectId/monthly-overview/undo-invoice-payment`
(`monthly-overview.service.ts`, `undoInvoicePayment`) reverte um pagamento manual
de fatura registrado por `payInvoice`: as compras/parcelas que aquele pagamento
liquidou voltam a `PLANEJADO` (`CardInvoiceSettlementService.unsettleInvoice`,
inverso de `settleByDueMonth`/`applyPaid`) e a `Expense` `PAGAMENTO_FATURA_CARTAO`
é soft-deletada (`deletedAt`), nunca hard-deletada.

**Restrição de segurança (v1 deliberadamente restrita):** só desfaz quando existe
**exatamente um** pagamento implícito casado com a fatura-alvo. Reaproveita
`assignImplicitPayments` sobre a lista de **TODAS** as faturas do cartão
(`buildCardInvoiceAggregates`) — a MESMA agregação que `getAccountView` usa pra
decidir `card.status`, garantindo que "desfazer" nunca discorda do que a tela já
mostrava como pago. 0 pagamentos casados → 404. 2+ (pagamento parcial, ou import
trouxe outro) → 400 com a lista dos pagamentos casados (`id`/`amountCents`/`data`,
pra UI mostrar) — sem heurística de desambiguação automática, isso é decisão manual
do usuário (exigiria persistir o vínculo do settlement, que `settleInvoice` hoje
não grava).

**Hotfix (jul/2026): lista de faturas não podia ter um elemento só.** A v1
original montava `invoices = [{ dueMonth-alvo, ... }]` — só a fatura sendo
desfeita. Mas `assignImplicitPayments` decide por DISPUTA: pra cada pagamento,
filtra as faturas do mesmo cartão cujo `dueMonth` caia na janela
`{payMonth, payMonth+1}` e escolhe a mais próxima por valor restante. Com UM
elemento na lista, não existe concorrente pra absorver pagamentos de OUTROS
meses cuja janela alcance o dueMonth-alvo — todo pagamento do cartão feito no
mês anterior era empurrado pra lá, inflando a contagem pra 2+ e disparando o 400
no fluxo NORMAL (cartão com faturas em meses consecutivos pagas), não no
excepcional. Correção: `undoInvoicePayment` agora busca `CashFlowEntry` +
`InvoiceAdjustment` do cartão inteiro (todos os meses) e chama
`buildCardInvoiceAggregates` — a MESMA função usada por `getAccountView` — pra
montar a lista completa, só filtrando por `targetKey` DEPOIS do
`assignImplicitPayments`. Uma segunda montagem paralela (como a v1 fazia) é
exatamente como essa divergência nasceu; qualquer novo consumidor de "quais
faturas existem e quanto cada uma soma" tem que passar por
`buildCardInvoiceAggregates`, não reimplementar.

**Armadilha respeitada (regra de ouro #4):** o soft-delete do pagamento roda
DENTRO da `$transaction` como `update({ data: { deletedAt: new Date() } })`
explícito — nunca `.delete()`, que seria hard delete real (`$transaction` ignora
o middleware `$use`).

**Invariante provado por teste:** pagar → desfazer devolve TODOS os agregados de
`getAccountView` (caixa, faturas, saídas, comprasCartao etc.) ao valor exato de
antes — deep-equal, não "parecido". Ver
`apps/api/src/monthly-overview/undo-invoice-payment.spec.ts`.

**UI:**

- **Desktop** (`CartoesSection`, grid `hidden md:grid`): botão "Desfazer
  pagamento" direto no `CreditCardTile`, visível quando `card.status !== 'a
  pagar'`.
- **Mobile** (carrossel compacto, `md:hidden`): o cartão não tem espaço para
  empilhar botões, então o toque abre `MobileCardActionsSheet.tsx` — um
  seletor de ações (Desfazer pagamento / Ajustar fatura / Quitar c/ resíduo,
  conforme aplicável) em vez de rotear fixo para uma delas. Status "a pagar"
  continua com toque direto (`onPayInvoice`), sem ambiguidade. Essa era uma
  lacuna pré-existente (nenhuma ação de fatura era alcançável no mobile,
  nem "Ajustar…") — corrigida junto com este PR.
- Ambos abrem `UndoInvoicePaymentDialog.tsx` (bottom-sheet responsivo), com
  foco inicial em "Cancelar" (nunca na ação), focus trap e Escape sem mutar.
- No 400 de ambiguidade, o diálogo troca a confirmação por uma lista dos
  pagamentos casados (data + valor) e fecha a ação automática — o usuário edita
  o lançamento duplicado/importado manualmente na Conta.

---

## §15 Identidades de fatura e ACL de child (B1a — ago/2026)

**Contexto:** B1a é a primeira fatia implementável de #448. É puramente aditiva —
zero schema, zero backfill, zero alteração de fórmula. A UX (W1) consome estes
campos numa etapa futura separada; **na entrega de B1a nenhum comportamento visível
mudou**. **Mergeado em `main` em 2026-08-19** (`5bbe5d69` #477, `720ff1fc` #478,
`890b89b0` #479); #448 permanece OPEN pela fatia B1b.

### 15.1 `cardId`/`accountId` opcionais em `payInvoice` e `undoInvoicePayment`

Antes, ambos os endpoints resolviam cartão/conta exclusivamente por `last4`. Agora:

| Caso | Comportamento |
|---|---|
| `cardId`/`accountId` ausente | Fallback legado por `last4` — byte-compatível, sem regressão. |
| ID presente | Resolve `{id, tenantId, projectId, deletedAt:null}`; ignora `last4` para o match. |
| ID presente + `last4` em conflito | **400** — zero escritas (verificado antes de qualquer `create`/`update`). |

A resposta dos dois endpoints retorna `cardId`/`accountId` quando resolvidos.

`settlesInvoiceKey` e `invoiceKey` permanecem com o formato `"{cardLast4}:{dueMonth}"` inalterado — o campo de vínculo explícito não foi tocado.

### 15.2 Campos novos em `getAccountView`

**`cartoes[]` e linha `saidas[]` com `isInvoice:true`:**

| Campo | Tipo | Semântica |
|---|---|---|
| `cardId` | `string \| null` | UUID do `CreditCard`; nulo se o cartão não pôde ser resolvido pelo `cardByLast4` do tenant. |
| `fingerprint` | `` `${cardId}:${dueMonth}` \| null `` | Chave scoped por ID — nunca por `last4`. Nulo quando `cardId` é nulo. |
| `actions` | `('pay' \| 'undo')[]` | Só verbos **atualmente executáveis**: `'pay'` quando `pending > 0`; `'undo'` apenas quando exatamente um pagamento implícito está casado (a mesma condição que `undoInvoicePayment` exige). |

**`contas[]`:** acrescenta `accountId` (UUID do `BankAccount`; nulo se não resolvido).

Nenhum campo preexistente (`editavel`, `status`, `realizado`, `pending`, `faturaAtual`) foi alterado.

### 15.3 Child ACL em `settleTargetParcela`

O projeto-alvo de uma conciliação cross-project é relido DENTRO da `$transaction`
existente, via `RateioRequester` encadeado desde o controller. O child deve existir
no mesmo tenant e estar no escopo autorizado do requisitante; requester ausente
falha fechado. Falhas abortam a transação com a mesma exceção de "not found", sem
vazar a existência do recurso.

### 15.4 Guarda de duplicidade ativa (cartão/conta)

`credit-card` e `bank-account` (create + update) rejeitam com **409** um segundo
registro ATIVO com o mesmo `{tenantId, projectId, last4}` (excluindo o próprio ID e
ignorando soft-deletados), dentro de um `$transaction` interativo.

**Teto declarado:** o guard fecha a corrida dentro de **um único processo Node**.
Múltiplos workers/processos de API podem passar a verificação simultaneamente. O
caminho de upgrade é um índice UNIQUE parcial
`(tenant_id, project_id, last4) WHERE deleted_at IS NULL` em H4 — **não está
implementado agora**.

### 15.5 Escopo de B1a (#448)

B1a cobriu três unidades de mudança, mergeadas em `main` em 2026-08-19:

| Unidade | Mudança |
|---|---|
| Child ACL + identidades de fatura (`cartoes[]`) + guard duplicidade | Child ACL em `settleTargetParcela`, `cardId`/`actions`/`fingerprint` em `cartoes[]`, guard 409 em cartão/conta |
| Identidades na linha de fatura em `saidas[]` | `cardId`/`actions`/`fingerprint` na linha `saidas[]` com `isInvoice:true` |
| Encadeamento de `requester` em `BankAccountController.linkToExpense` | Fecha o gap identificado na unidade anterior |

**Compatibilidade retrospectiva:** todos os 1318 testes existentes passam sem edição.

---

## §16 Ledger de liquidação de fatura por importação de extrato (#569, ago/2026)

Quando a importação de um **extrato bancário** cria um `PAGAMENTO_FATURA_CARTAO` e a
liquidação automática (`CardInvoiceSettlementService`) marca compras do cartão como
pagas, a identidade exata dessa liquidação passa a viver em duas tabelas:

- **`ImportedCardInvoiceSettlement`** — 1:1 com o pagamento
  (`payment_expense_id` UNIQUE). Guarda `bank_statement_import_id`, `card_id`,
  `card_project_id` (denormalizado para autorizar o undo), a `strategy`
  (`DUE_MONTH` | `IMPORTED_STATEMENT` | `NONE`), `target_due_month` (**só
  auditoria** — o undo nunca lê isto) e `matched_card_import_id` (a fatura
  importada casada, quando `IMPORTED_STATEMENT`).
- **`ImportedCardInvoiceSettlementEntry`** — uma linha por `CashFlowEntry` que
  **aquele pagamento** moveu `PLANEJADO → PAGO`. Índice único parcial
  `cash_flow_entry_id WHERE released_at IS NULL`: uma parcela nunca fica
  reivindicada por duas liquidações ativas (a 2ª tentativa estoura constraint e
  a transação do import inteira faz rollback).

Ambas ficam em `modelsWithoutSoftDelete`; o ciclo de vida é `reverted_at` no pai e
`released_at` nos filhos. Substituíram `Expense.settledInvoiceKey` (a chave
`"{last4}:{dueMonth}"`, que nunca chegou ao `main`): ela era ambígua no fallback por
fatura importada e forçava o undo a adivinhar o mês.

**`getImportDetail`** conta `invoiceLiquidations` **só** pelo ledger (strategy ≠
`NONE` e ≥1 entrada ativa). Nada de inferência por `last4`, dias atuais do cartão ou
mera presença do pagamento — a prévia de 3 meses do `card-invoice-match` promete
vínculos que a liquidação real (janela de 2 meses) não confirma.

**`undoImport`** é dirigido pelo ledger:

1. carrega os settlements por `tenant_id + bank_statement_import_id` com
   `reverted_at IS NULL`;
2. autoriza `card_project_id` **e** todo projeto dono de uma parcela registrada,
   **antes** da primeira escrita (`assertCanAccessProject`, módulo `creditCards`);
   sem acesso → 404 e zero write;
3. reverte **só** os `cash_flow_entry_id` registrados que ainda estão ativos e
   `PAGO` (update condicional); recomputa `Expense.status/paidParcelas`
   (`recomputeExpensePaidState`); marca filhos `released_at` e pai `reverted_at`.
   Compras de outro lote / faturas quitadas por outro pagamento **nunca** são
   tocadas — não têm entrada no ledger deste import.

**Fallback reversível:** `IMPORTED_STATEMENT` (fallback por fatura importada) é
revertível normalmente **quando tem entradas registradas** — o ledger guarda os ids
exatos, não um `dueMonth`.

**Legado conservador (decisão do PO):** um `PAGAMENTO_FATURA_CARTAO` de importação
**sem** linha no ledger (gravado antes do #569) não é recalculado nem adivinhado no
undo. Ele sai com o lote como qualquer despesa, **nenhuma compra/parcela do cartão é
tocada**, o undo devolve `notRevertibleInvoiceLiquidations` e loga um `warn` com
`paymentExpenseId` + `importId` (sem valores nem dados sensíveis). O texto no preview
de impacto do "Desfazer importação" reflete isso: "pagamento de fatura legado, sem
histórico exato de liquidação — reabra a fatura manualmente se necessário".

> Não confundir com **§14 "Desfazer pagamento de fatura"**, que é o inverso do
> pagamento **manual** do cockpit (`payInvoice`) e continua usando o motor por
> `dueMonth`. São ações de faturas diferentes.

### §16.1 Validação no momento do undo (rodada corretiva)

`getImportDetail` e `undoImport` **revalidam o ledger dentro da própria
transação** (nenhuma escrita no `getImportDetail`), e `getImportDetail` recebe o
`requester`:

- **Autorização agora:** o `cardProjectId` de cada ledger e o projeto de cada
  parcela registrada são reautorizados (`assertCanAccessProject`, módulo
  `creditCards`). Revogação de qualquer participante, ou relação cross-tenant ⇒
  **404 indistinguível**, antes de qualquer payload/escrita.
- **Drift do lançamento ⇒ 409:** um filho ativo cuja `CashFlowEntry` sumiu,
  mudou de tenant, deixou de apontar para a `expense` registrada (coluna
  `expense_id` do filho) ou saiu de `PAGO` torna a importação **não
  desfazível**: `getImportDetail.canUndo = false`,
  `blocking.changedInvoiceLiquidations > 0`, `undoImport` → **409, zero writes**
  (nunca procura um "substituto" por data/parcela).
- **Outro pagamento ativo pela mesma fatura ⇒ 409:** se um ledger íntegro tem
  outra liquidação ativa (`cardId+targetDueMonth` **ou**
  `cardId+matchedCardImportId`), de OUTRA importação com pagamento vivo, ele não
  pode ser revertido agora — `blocking.invoiceLiquidationsWithOtherPayments > 0`.
  Pagamentos do MESMO lote não bloqueiam uns aos outros.
- `impact.invoiceLiquidations` conta **apenas** ledgers com filhos íntegros e
  reversíveis **naquele momento**.

### §16.2 A liquidação nunca "avança"

- `strategy = NONE` significa **só** "nenhum alvo foi resolvido". Uma liquidação
  `DUE_MONTH`/`IMPORTED_STATEMENT` **sem filhos** (fatura já quitada por outro
  pagamento) mantém a estratégia — os filhos são o efeito físico, a estratégia é
  o alvo.
- Estratégia por vencimento: alvo resolvido mas sem parcela `PLANEJADO` ⇒
  `DUE_MONTH` com `purchases: []`. **Não** cai no fallback nem paga outra fatura.
- Fallback importado: se já existe liquidação ativa para
  `cardId + matchedCardImportId`, devolve `IMPORTED_STATEMENT` com
  `purchases: []` — **não avança** para a próxima parcela em aberto.

### §16.3 Compra híbrida e resultado honesto do commit

- **Híbrida (`cardLast4` + `bankLast4`):** também é movimento de conta. Fica
  **fora** do target, do ranking (`loadCardsWithEntries`) e dos dois fallbacks —
  a liquidação nunca muda o status de um lançamento que também representa
  movimento de conta.
- **Commit honesto:** `cardPayments` só incrementa quando o pagamento de fato
  moveu ≥1 parcela `PLANEJADO → PAGO`. Cartão identificado mas nada liquidado ⇒
  cai no aviso "saiu do saldo, nenhuma fatura quitada" (`unlinkedCardPayments`),
  não em "vinculado".

### §16.4 Desfazer manual não alcança pagamento importado

`monthly-overview.undoInvoicePayment` (cockpit) só aceita pagamento **manual**
(`importId: null`) — na seleção de candidatos, no mapa que produz o verbo `undo`
em `cartoes[]` e na releitura dentro da transação. Chamada direta para um
pagamento importado ⇒ **404**. O pagamento importado **continua contando** no
status da fatura; só `BankAccountService.undoImport` o remove.
