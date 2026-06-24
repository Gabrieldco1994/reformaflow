# Visão Conta — Faturas de cartão, neutros e liquidação

> **Escopo:** lógica de agregação de faturas, regra de neutros, casamento
> pagamento→fatura e "cartão paga cartão" do projeto **PESSOAL**.
> **Onde vive:** `apps/api/src/monthly-overview/monthly-overview.service.ts`
> (`getAccountView`, `getCardInvoicesYearly`, `getOriginItemsYearly`,
> funções puras `matchPaidInvoices` / `computePaidInvoiceKeys`).
> **Testes:** `apps/api/src/monthly-overview/monthly-overview.account-view.spec.ts`.
> Complementa `docs/cockpit-caixa-real.md` (caixa real §10).

---

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
- **Endpoints:** `GET .../card-invoices-yearly?year` e
  `GET .../origin-items-yearly?year&kind&last4`.
- **Frontend:** `conta/page.tsx` (toggle Mês/Ano, filtro de origem, clique no mês),
  `_components/FaturasAnuaisChart.tsx`, `_components/DespesasRelacionadas.tsx`.

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

**Correções de dados em prod (com backup, validadas live):**
- 5572: removido lançamento fantasma 162,36; criadas 6 séries; Acqualeste linkado à planejada.
- 5868: criados Mambo 238,77 + Outback 290,00 (jun).
- Conta 3636: criados JB Caça 500, RMD Eng 8.000, NU Pagament 24.010,33 (neutro), rendimentos.
- Vínculos cross-card: `settlesInvoiceKey` em PgConta NU (Latam→Nubank mai) e Itaú (Nubank→Latam jun);
  criado PIX 9.185,15 (18/05) que faltava para fechar o Latam jun.
- Criada entrada **PIX recebido 9.185,15 (18/05)** que cobriu o PIX de saída do Latam →
  `caixaHoje` voltou ao real **R$ 7.576,29**.
