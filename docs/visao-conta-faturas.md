# Visão Conta — Faturas de cartão, neutros e liquidação

> **Escopo:** lógica de agregação de faturas, regra de neutros, casamento
> pagamento→fatura e "cartão paga cartão" do projeto **PESSOAL**.
> **Onde vive:** `apps/api/src/monthly-overview/monthly-overview.service.ts`
> (`getAccountView`, `getCardInvoicesYearly`, `getOriginItemsYearly`,
> funções puras `matchPaidInvoices` / `computePaidInvoiceKeys`).
> **Testes:** `apps/api/src/monthly-overview/monthly-overview.account-view.spec.ts`.
> Complementa `docs/cockpit-caixa-real.md` (caixa real §10).
> Política de timezone/data: `docs/politica-datas-timezone.md`.
> **Status (2026-06-25):** regras ativas em `main` (inclui commits `1cc93dc6`,
> `7010b95d`, `01affbcb`, `7e901b15`, `f7be2bff`, `e41461c7`).

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

## Referência de implementação

- Serviço principal: `apps/api/src/monthly-overview/monthly-overview.service.ts` (`getAccountView`, `getCardInvoicesYearly`, `getOriginItemsYearly`, `matchPaidInvoices`, `computePaidInvoiceKeys`).
- Fila financeira W1 (`GET /projects/:projectId/pendencias/financeiras`) deriva pendências **a partir do `getAccountView`** (mesma fonte e mesmos invariantes; sem motor paralelo de caixa/fatura).
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
  `origins` inclui **cartões** (`kind:'card'`) e **conta corrente** (`kind:'conta'`).
  Aplica a regra de neutros (seção 2) na composição de cada fatura.
- **`getOriginItemsYearly(tenant, project, {year, kind, last4})`** → despesas de uma
  origem agrupadas por mês (para a lista "despesas relacionadas").
  - **`kind='all'`** (sem `last4`): agrega **todas as origens** do ano num só
    conjunto, cada item com seu rótulo de `origem` (`{kind,last4,nickname}`).
    Mesmas regras de neutro/mês por origem — o total bate exatamente com o
    `totalAno` do `getCardInvoicesYearly`. Alimenta a opção **"Todos"**.
- **Endpoints:** `GET .../card-invoices-yearly?year` e
  `GET .../origin-items-yearly?year&kind&last4` (ou `kind=all`).
- **Frontend:** `conta/page.tsx` (toggle Mês/Ano, filtro de origem, clique no mês),
  `_components/FaturasAnuaisChart.tsx`, `_components/DespesasRelacionadas.tsx`,
  `_components/TodasDespesasAno.tsx` (chip **Todos**: lista todas as despesas com
  filtros de **tipo de despesa** e **mês**).

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
