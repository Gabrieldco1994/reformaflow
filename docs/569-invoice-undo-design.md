# #569 — Undo exato de liquidação de fatura por importação de extrato (design v2)

> **Status em 2026-09-09 — PR 1 em implementação/validação (inflight).**
> Revisão documental sobre `57287dad`; correções de backend e testes seguem em
> branches paralelas. Este documento **não comprova merge, migration aplicada,
> testes verdes ou deploy em produção**.
> **PR 1:** trilha real (`PROCESSED_SETTLED` + itens quando houve liquidação,
> `PROCESSED_NONE` somente sem transições) e guards de mutações incompatíveis.
> **PR 2 futuro:** habilitar undo `SETTLED`, leitura `settlement{…}` e painel/UX.
> Helpers de reversão podem existir no PR 1 sem habilitar o undo pela aplicação.
> Contrato funcional D1–D4 aprovado; este é planejamento, não um novo contrato.
> Fontes normativas: [faturas](visao-conta-faturas.md),
> [caixa real](cockpit-caixa-real.md), [datas](politica-datas-timezone.md).
> [Status do Cockpit](estado-atual-cockpit-pessoal.md) e
> [manual](manual-do-aplicativo.md) não devem ser lidos como anúncio do PR 2.
>
> **Referência histórica:** o design v2 foi levantado em `origin/main@e66e49c1`
> (#686 / M8 / #573), na branch `design/569-invoice-undo-v2`. Os locators numéricos
> antigos abaixo se referem a esse snapshot, não ao HEAD em validação. O ledger
> de `fix/569-invoice-settlement-window`, removido por `484d78d6`, não é a
> implementação atual.

---

## 0. Baseline histórico em `e66e49c1` (arquivo:linha; não estado atual)

| fato | evidência |
|---|---|
| commit do extrato é UMA `$transaction` interativa para o lote inteiro | `bank-account.service.ts:1151` `const core = await this.prisma.$transaction(createCore)` |
| liquidação no ramo `matchedCard` | `bank-account.service.ts:2478` `prepareSettleInvoice` + `:2497` `applyPreparedSettlement(client, currentSettlement)` |
| `applyPreparedSettlement` faz `tx.cashFlowEntry.update({where:{id},data:{status:'PAGO'}})` **incondicional** e retorna `{settledExpenses, settledParcelas}` **contados do `prepared`** | `card-invoice-settlement.service.ts:613-624`. **Não devolve o que virou. Não há `flippedEntries`.** |
| `applyPaid` recomputa `Expense.status`/`paidParcelas` | `card-invoice-settlement.service.ts:632-676` |
| nada registra quais `CashFlowEntry` foram tocadas | — (ausência) |
| `getImportDetail(tenantId, projectId, accountId, importId)` — **sem `requester`**; usa **corte por data** `createdAt: { gte: importRecord.createdAt }` | `bank-account.service.ts:1297,1305,1310`; controller `bank-account.controller.ts:71-78` (sem `@CurrentUser`) |
| `undoImport(..., requester: RateioRequester)` — **já recebe `requester`**; ainda usa corte por data `createdAt: { gte / lt : importRecord.createdAt }` | `bank-account.service.ts:1405-1410,1452,1459,1463` |
| ambos só chamam `findAccount(tenantId, projectId, accountId)` — acesso de CONTA, não ACL por projeto/participante das COMPRAS liquidadas (que podem ser cross-project — cartão compartilhado) | `bank-account.service.ts:1298,1416` |
| hotfix fail-closed #569 vigente: qualquer `PAGAMENTO_FATURA_CARTAO` no lote ⇒ `canUndo:false` / `undoImport` 409 | `bank-account.service.ts:1347-1363` (`hasCardInvoicePayment`), `:1493-1499` (ConflictException) |
| TOCTOU já tratado no undo: releitura de conta+import DENTRO da tx | `bank-account.service.ts:1438-1449` |
| re-undo serial já no-op: `importRecord.deletedAt` ⇒ `{ok:true, alreadyUndone:true}` | `bank-account.service.ts:1429-1434` |
| `Expense.settledByExpenseId` / `plannedExpenseId` são o par ADOÇÃO MANUAL (liquida planejada por paga), `@unique` | `schema.prisma:243-244`; escrito em `expense.service.ts:2065`, revertido `:2140` |
| adoção de despesa pré-existente na dedup carimba `importId`/`externalId` (Tier A/B #672) | `bank-account.service.ts:1463` (`adopted`), `:1553-1555` (unstamp) |

### Janelas — distintas, levantadas no baseline (D)

| papel | valor | arquivo:linha | NÃO confundir |
|---|---|---|---|
| identificação de cartão por IMPORTAÇÃO de fatura (±R$2 = ±200 centavos no total) | **60 dias** | `bank-account.service.ts:2822-2831` `sixtyDaysBefore.setDate(getDate()-60)`; `const tolerance = 200; // R$ 2` `:2824` | não é liquidação |
| identificação ESTRITA por valor (final explícito/único) | **±10 dias** | `bank-account.service.ts:2894` `tenDaysBefore … tenDaysAfter` (fn ~`:2882`) | não é liquidação |
| LIQUIDAÇÃO por vencimento (cartão com `closingDay`+`dueDay`) | janela de mês **{payMonth, payMonth+1}** | `card-invoice-settlement.service.ts:257` `windowMonths = new Set([payMonth, addMonthsToMonthKey(payMonth,1)])` | não é dias corridos |
| FALLBACK de liquidação por fatura importada (±R$2 no `totalAmountCents`) | **75 dias** corridos | `card-invoice-settlement.service.ts:682` `since.setDate(getDate()-75)`; `tolerance=200` `:683` | ≠ 60d de identificação |
| ranking da prévia | `rankCardCandidates` (domínio) | `bank-account.service.ts:715, 2308` (import `:68`) | telemetria de escolha, não realiza nada |

**Regra dura (D):** o design NÃO troca 60 por 75 nem "unifica" janelas. Cada teste
pina a sua. `resolveTargetDueMonth` só devolve `dueMonth` quando o valor FECHA a
fatura dentro de `invoiceMatchTolerance` (`max(R$2; 0,5%)`), senão `null`
(`card-invoice-settlement.service.ts:295-298`); pagamento fora da tolerância NÃO
realiza nada — e a diferença pode ser para MENOS **ou para MAIS** (pagamento a
maior), com o mesmo desfecho: zero parcelas viradas, `outcome: NO_SETTLEMENT`.

---

## 1. Design mínimo — armazenamento e protocolo

**Leitura por fase:** o armazenamento nasce no PR 1. A coluna de undo abaixo
descreve o alvo completo do design; no PR 1 o estado 3 continua bloqueado
(`canUndo:false` / `undoImport` 409), mesmo com trilha completa e íntegra.

### 1.1 Os 4 estados que o armazenamento tem de distinguir (A)

| # | estado | como é gravado | undo do LOTE |
|---|---|---|---|
| 1 | **legado sem trilha** — `PAGAMENTO_FATURA_CARTAO` criado pré-#569 | pagamento sem carimbo (`invoice_undo_state IS NULL`), zero itens | **409** fail-closed, sem backfill (D2) |
| 2a | **novo, ZERO liquidações, cartão identificado** — nenhuma fatura fechou dentro da tolerância (parcial, **a maior**, encargo, ou já paga) | carimbo `PROCESSED_NONE`, `parcela_count = 0`, `card_id` = id estável, zero itens | **permitido** — não há parcela a reabrir; identidade do cartão preservada |
| 2b | **novo, sem cartão (M8)** — `matchedCard === null`, `applyPreparedSettlement` não rodou | carimbo `PROCESSED_NONE`, `parcela_count = 0`, **`card_id = NULL`**, zero itens | **permitido** — segue undo normal sem cartão; **não** bloqueia `canUndo` do lote |
| 3 | **novo, conjunto COMPLETO** | carimbo `PROCESSED_SETTLED`, `parcela_count = N`, N itens ativos, `due_month`, `card_id` | reverte exatamente os N itens, atômico |
| 4 | **incompleto / inconsistente / lote MISTO** (parte nova, parte legado; ou drift) | ≥1 pagamento do lote **sem carimbo** (`invoice_undo_state IS NULL`) — `PROCESSED_NONE` **não** conta como misto; **ou** `count(itens ativos) ≠ parcela_count` do carimbo; **ou** drift por-item | **409**, ZERO escrita |

O distinguidor entre (1) e (2) — a contradição da v1 — é **um carimbo escrito na
MESMA transação do commit no próprio `Expense` do pagamento**, não a
presença/ausência de linhas de item. "Zero itens + carimbo `PROCESSED_NONE`" =
processado e seguro de desfazer; "zero itens + sem carimbo" = legado, bloqueado.
**Todo `PAGAMENTO_FATURA_CARTAO` criado pelo commit do código novo recebe carimbo**
(mínimo `PROCESSED_NONE`), inclusive com `matchedCard === null` e `parcela_count = 0` —
sem isso um pagamento novo sem cartão seria indistinguível do legado e travaria o lote
(estado 1) indevidamente. Só o legado pré-#569 fica sem carimbo.

### 1.2 Menor solução suficiente: **carimbo no `Expense` + 1 tabela de itens**

Comparada às alternativas:

- **Só JSON no `Expense` (blob):** não indexável ⇒ impossível a **unicidade de
  reivindicação ativa por `CashFlowEntry`** (D1 exige: nunca duas liquidações
  ativas na mesma parcela). Rejeitada.
- **Duas tabelas (cabeçalho + itens):** o "cabeçalho por pagamento" duplica o
  `PAGAMENTO_FATURA_CARTAO`, que já tem `importId`, `cardLast4`, `valorTotal`,
  `dataPagamento`. Undo é tudo-ou-nada por LOTE (escopo aprovado) ⇒ não há
  agrupador intermediário que se pague. Rejeitada.
- **Escolhida:** 5 colunas de carimbo no `Expense` do pagamento + tabela
  `imported_invoice_liquidation` (1 linha **ativa** por parcela virada; **várias
  linhas históricas soft-deleted** por `cash_flow_entry_id` são permitidas — só
  uma com `deleted_at IS NULL`). O carimbo dá os 4 estados e a prova de completude
  O(1); a tabela dá a unicidade e o drift-check por parcela.

#### Carimbo — colunas aditivas em `model Expense` (só o `PAGAMENTO_FATURA_CARTAO`)

| coluna | tipo | função |
|---|---|---|
| `invoice_undo_state` | TEXT NULL | `NULL` (legado, sem carimbo) \| `PROCESSED_NONE` (processado, 0 parcelas — inclui cartão nulo) \| `PROCESSED_SETTLED` (N>0 parcelas) |
| `invoice_undo_parcela_count` | INT NULL | N esperado de itens ativos (prova de completude — A) |
| `invoice_undo_due_month` | TEXT NULL | `YYYY-MM` alvo (observabilidade + D) |
| `invoice_undo_card_id` | TEXT **NULL** | id ESTÁVEL do cartão resolvido; **`NULL` quando M8 não identificou o cartão** (estado 2b). Nunca `last4` |
| `invoice_undo_trail_version` | INT NULL | versão do protocolo (E — guarda de versão) |

Vínculo com o lote: **`Expense.importId`** (imutável, gravado na criação) — nunca corte por data.

**Proveniência durável = o próprio carimbo** (`invoice_undo_state IS NOT NULL` +
`invoice_undo_trail_version`), **não** `tipoDespesa` — que É PATCHÁVEL
(`UpdateExpenseDto extends PartialType(CreateExpenseDto)` ⇒ `tipoDespesa` aceita PATCH).
A enumeração do lote (§2.3) casa `importId` **+ (`tipoDespesa='PAGAMENTO_FATURA_CARTAO'`
OU `invoice_undo_state IS NOT NULL`)**: o `tipoDespesa` só é necessário para achar o
**legado** (que não tem carimbo); a linha nova é reconhecida pelo carimbo mesmo que
`tipoDespesa` tenha sido alterado. Para o par não derivar, mudar
`tipoDespesa`/`cardLast4`/`bankLast4`/`settlesInvoiceKey` de um pagamento **com carimbo
ativo** é bloqueado em `hasProtectedChange` (§4 B9). **Escolha mínima: bloqueio
explícito** — estende `changedToNeutralType` (já existente em
`expense.service.ts:1509-1526`), é O(1) por update e não exige varredura de
proveniência; a enumeração por carimbo cobre o resto.

#### `model ImportedInvoiceLiquidation` → tabela `imported_invoice_liquidations`

| coluna | tipo | função |
|---|---|---|
| `id` | TEXT PK cuid | |
| `tenant_id` | TEXT NOT NULL | serviço filtra sempre (regra da casa) |
| `payment_expense_id` | TEXT NOT NULL FK→`expenses.id` RESTRICT | o pagamento importado |
| `import_id` | TEXT NOT NULL | varredura por lote (denormalizado, imutável) |
| `purchase_expense_id` | TEXT NOT NULL FK→`expenses.id` RESTRICT | a COMPRA dona da parcela (`applyUnpaid`) |
| `cash_flow_entry_id` | TEXT NOT NULL FK→`cash_flow_entries.id` RESTRICT | a parcela liquidada |
| `card_id` | TEXT NOT NULL | id estável do cartão (revalidação C) |
| `prev_status` | TEXT NOT NULL | status ANTES do flip — **capturado do valor lido, não presumido** |
| `entry_valor_cents` | INT NOT NULL | valor da parcela no flip (prova de drift) |
| `parcela` | TEXT NULL | rótulo `"k/n"` no flip (prova de drift) |
| `due_month` | TEXT NOT NULL | `YYYY-MM` |
| `created_at` | DATETIME DEFAULT now | |
| `deleted_at` | DATETIME NULL | soft-delete padrão (consumido no undo) |

**Índice único parcial (D1 — anti dupla-reivindicação):**
```sql
CREATE UNIQUE INDEX "imported_invoice_liquidations_entry_active_key"
  ON "imported_invoice_liquidations"("cash_flow_entry_id") WHERE "deleted_at" IS NULL;
```
Máx. UMA liquidação ATIVA por `CashFlowEntry`. FK não substitui isso (só impede
hard-delete da entry). Índices auxiliares: `(import_id)`, `(payment_expense_id)`, `(tenant_id)`.

**Histórico admite N linhas por `cash_flow_entry_id`.** Re-liquidar a mesma parcela
num novo import, depois de um undo que soft-deletou a linha anterior, cria uma NOVA
linha ativa; a antiga permanece `deleted_at != NULL`. O índice parcial
`WHERE deleted_at IS NULL` é o que garante "no máximo uma ativa" — não há regra de
aplicação equivalente e nenhum texto deste doc deve implicar "1 linha por parcela".

Modelo TEM `deleted_at` ⇒ **NÃO** entra em `modelsWithoutSoftDelete`
(`prisma.service.ts`). O `$use` injeta `deleted_at: null` em `findMany/findFirst`
(inclusive dentro de `$transaction` — Scar do `$use`), que é o que o undo quer.
Releitura de parcela individual é `findUnique` (vê soft-deleted, tx ou não).

### 1.3 `strategy` só-telemetria — FORA do mínimo
A reversão é strategy-agnóstica: restaurar `prev_status` + recomputar a compra
basta. `due_month` já dá rastreabilidade. Adiar para telemetria se o PO pedir.

### 1.4 Não reapontar `CashFlowEntry.expenseId`
Confirmado: ~40 arquivos assumem `expenseId` = a COMPRA
(`computeCaixaConta`, `buildCardInvoiceAggregates`, `paid-origins`, DRE). O ledger
carrega suas próprias colunas; `expenseId` da entry fica intocado. (Decisão já
tomada no brief — aqui só a evidência.)

---

## 2. Protocolo por fase

### 2.1 commit (`bank-account.service.ts` ramo `matchedCard`, ~`:2478-2500`)

1. `applyPreparedSettlement` passa a **devolver as transições EFETIVAS** (C):
   `{ settledExpenses, settledParcelas, flippedEntries: FlippedEntry[] }` onde
   `FlippedEntry = { cashFlowEntryId, purchaseExpenseId, prevStatus, valorCents, parcela, dueMonth }`.
   Mudança MÍNIMA em `card-invoice-settlement.service.ts:613-628`: dentro do laço,
   antes do `update`, o método já tem `entry` em mãos — pular se `entry.status === 'PAGO'`
   (defensivo; `prepare*` já filtra `PLANEJADO`), e para cada `update` de fato
   executado empilhar um `FlippedEntry` com `prevStatus = entry.status` lido. O
   `dueMonth` vem de `caixaMonthForCardPurchase(entry.data, card.closingDay, card.dueDay)`
   (mesma fn do `prepare`). `settledExpenses`/`settledParcelas` mantidos (compat).
2. `outcome: 'SETTLED' | 'NO_SETTLEMENT'` é derivado **do resultado EFETIVO do
   `apply` (`flippedEntries` — transições reais), NUNCA da contagem do `prepare`**:
   - `SETTLED` — `flippedEntries.length > 0` (≥1 parcela PLANEJADO de fato virou PAGO no `apply`)
     ⇒ carimbo `PROCESSED_SETTLED`.
   - `NO_SETTLEMENT` — `flippedEntries.length === 0` de FATO no `apply`, **qualquer causa** (fatura já paga;
     diferença acima da tolerância — que pode ser pagamento **A MAIOR**, não só parcial;
     nenhuma fatura compatível; encargo puro) ⇒ carimbo `PROCESSED_NONE`.
   O sub-motivo (`hint?: 'ALREADY_PAID' | 'AMOUNT_MISMATCH' | 'NO_MATCH'`) é
   **observabilidade best-effort — NÃO persistida, NÃO confiável**: não vai em coluna,
   não decide `canUndo`, não é asseverado por teste como verdade histórica. A UI nunca
   afirma "fatura já paga" nem "pagamento parcial" sem prova persistida — diz apenas
   **"nenhuma parcela liquidada"**. Identificação do cartão ≠ liquidação da fatura:
   `NO_SETTLEMENT` com cartão identificado ainda grava `invoice_undo_card_id`.
   **`PROCESSED_NONE` só pode ser gravado quando `flippedEntries.length === 0` de
   FATO no retorno do `apply` — nunca a partir de um palpite do `prepare`.**
3. Após `applyPreparedSettlement`, na MESMA `$transaction`:
   - `recordImportedLiquidations(client, { tenantId, paymentExpenseId: e.id, importId, cardId: matchedCard.id, flippedEntries })`
     — 1 linha por `FlippedEntry`. `P2002` no índice parcial (parcela já
     reivindicada) **NÃO é capturado** ⇒ propaga ⇒ **`this.prisma.$transaction`
     de `bank-account.service.ts:1151` faz ROLLBACK do LOTE inteiro** (C —
     "rollback de todo o lote", não "aborta a linha"). Nenhuma despesa, caixa,
     recebimento, vínculo ou `bankStatementImport` persiste.
   - carimbo no pagamento: `client.expense.update({ where:{id:e.id}, data:{
     invoiceUndoState: flippedEntries.length ? 'PROCESSED_SETTLED' : 'PROCESSED_NONE',
     invoiceUndoParcelaCount: flippedEntries.length,
     invoiceUndoDueMonth: <due_month ou null>,
     invoiceUndoCardId: matchedCard?.id ?? null,
     invoiceUndoTrailVersion: INVOICE_UNDO_TRAIL_VERSION }})`.
4. Ramo `matchedCard === null` (M8 — sem identidade confiável): pagamento criado
   com `cardLast4: null`. **Recebe carimbo `PROCESSED_NONE`**
   (`invoiceUndoParcelaCount: 0`, `invoiceUndoCardId: null`, `invoiceUndoDueMonth: null`,
   `invoiceUndoTrailVersion: INVOICE_UNDO_TRAIL_VERSION`), **zero itens**. Estado 2b:
   `undoImport` segue o fluxo sem-cartão normal e **não** é bloqueado por este pagamento.
   O carimbo existe só para distinguir "processado pelo código novo" de "legado" — sem
   ele o pagamento cairia no estado 1 e travaria o lote indevidamente.
5. Resumo do commit: novo contador `cardPaymentsPendingSettlement` alimentado por
   `outcome === 'NO_SETTLEMENT'` **com `matchedCard` truthy** (cartão identificado, fatura não fechou).
   Texto: *"N pagamento(s) vinculado(s) ao cartão sem fatura fechada — confira a
   fatura do cartão."* **Sem** "a fatura será marcada paga quando as compras
   entrarem" (F — removido; não há mecanismo aprovado).

### 2.2 PR 2 — `getImportDetail` com revalidação e leitura de settlement (C)

- Controller `bank-account.controller.ts:71` ganha `@CurrentUser() requester: RateioRequester` + `assertRateioRequester`; assinatura do serviço vira
  `getImportDetail(tenantId, projectId, accountId, importId, requester)`.
- Corte por data REMOVIDO: escopo por `importId` puro
  (`bank-account.service.ts:1305,1310`) — adotadas pré-import passam a contar
  igual ao undo.
- Envolver as leituras decisivas numa `this.prisma.$transaction` e aplicar a
  **mesma** função de revalidação que o `undoImport` (§2.3 passos 2–4), em modo
  leitura: devolve `canUndo` + `blockReason`.
- `canUndo` = `importRecord.deletedAt != null`
  **OU** ( todo pagamento do lote com `invoiceUndoState != NULL` (`PROCESSED_NONE`
          satisfaz — 0 itens esperados)
          **E** `invoiceUndoTrailVersion === INVOICE_UNDO_TRAIL_VERSION`
          **E** para cada `PROCESSED_SETTLED`: `count(itens ativos) === invoiceUndoParcelaCount`
          **E** nenhum drift por-item ).
- Lote com `PAGAMENTO_FATURA_CARTAO` **sem carimbo** (`invoice_undo_state IS NULL` —
  legado ou misto) ⇒ `canUndo:false`, `blockReason: 'LEGACY_NO_TRAIL'`. Um `PROCESSED_NONE`
  **não** é misto e **não** bloqueia.
- O `state` abaixo deriva do que o `apply` gravou (`flippedEntries` no commit ⇒
  carimbo), **nunca** de uma recontagem do `prepare`.
- Estados honestos expostos (D/F): por fatura/cartão tocado, `settlement: { state:
  'SETTLED_BY_IMPORT' | 'NO_SETTLEMENT' | 'LEGACY_NO_TRAIL' | 'DRIFT', cardId,
  dueMonth, hint?, payments: [{ paymentExpenseId, importId, parcelaCount }] }` —
  **`cardId` estável (nullable — M8), nunca `last4`**; `dueMonth` nullable; `hint`
  **best-effort, não-persistido, não asseverado**; **lista de pagamentos** (múltiplos
  pagamentos/importações na mesma fatura).

### 2.3 PR 2 — `undoImport` via ledger, dentro da `$transaction` (`bank-account.service.ts:1436` no baseline)

Ordem, ANTES da 1ª escrita:

1. **TOCTOU** (já existe `:1438-1449`): re-lê conta + import na tx. Mantido.
2. **Enumerar pagamentos do lote** por `importId` **+ (`tipoDespesa='PAGAMENTO_FATURA_CARTAO'`
   OU `invoiceUndoState IS NOT NULL`)** — o carimbo é a proveniência durável (§1.2),
   `tipoDespesa` sozinho é patchável. `deletedAt: INCLUDE_SOFT_DELETED`.
   - Nenhum ⇒ segue undo normal (sem cartão).
   - Algum com `invoiceUndoState IS NULL` **ou** `trailVersion` desconhecida ⇒
     **409 `LEGACY_OR_MIXED`**, zero escrita (estados 1 e 4). Um `PROCESSED_NONE`
     **não** dispara `LEGACY_OR_MIXED`.
3. **Prova real de "já desfeito" / consistência** (C — `count:0` não basta):
   dentro da tx, para cada pagamento com carimbo:
   - `activeItems = tx.importedInvoiceLiquidation.findMany({ where:{ paymentExpenseId, deletedAt:null } })`.
   - Se `importRecord.deletedAt != null` (re-lido na tx) ⇒ retorno no-op
     `{ ok:true, alreadyUndone:true }` (idempotência — como hoje `:1429`).
   - Se `invoiceUndoState === 'PROCESSED_SETTLED'` **e** `activeItems.length !== invoiceUndoParcelaCount`
     ⇒ **409 `INCOMPLETE_TRAIL`**, zero escrita (estado 4: alguém removeu/adicionou
     item fora de banda, ou undo concorrente no meio).
   - Se `invoiceUndoState === 'PROCESSED_NONE'` ⇒ zero itens esperado; nada a
     reverter de fatura, segue.
4. **ACL por participante cross-project** (C — tenant ≠ autorização): para cada
   `purchase_expense_id` distinto dos itens, carregar `expense.project { id,
   type, tenantId, deletedAt }` e exigir
   `CardInvoiceSettlementService.assertCanSettlePurchase`-equivalente
   (`card-invoice-settlement.service.ts:190` reusa `canRequesterSeeProject`).
   Falha ⇒ **404 `Fatura não encontrada`** (indistinguível), zero escrita.
   Assim como `undoInvoicePayment`/rateio exigem ACL de cada participante
   (`bank-account.service.ts:1499` `conciliacao.assertCanReverseSources`;
   `monthly-overview.service.ts` `payInvoice`/`undoInvoicePayment` per-card ACL),
   **não** o `tenantId` sozinho.
5. **Drift-check por item** (`findUnique` — vê soft-deleted, Scar #616):
   para cada item, re-ler `cashFlowEntry` por id e a compra por id; 409
   `DRIFT`, zero escrita, se qualquer:
   - entry `status !== 'PAGO'` (revertida por `undoInvoicePayment` manual / edição);
   - entry `deletedAt != null` (compra excluída — `expense.service.ts:2190 remove`);
   - `entry.valor !== entry_valor_cents` (PATCH de valor da compra — `expense.service.ts:1444 update`);
   - `entry.parcela` mudou (reparcelamento / rateio);
   - a compra ganhou `settledByExpenseId != null` **por adoção manual de planejada→paga**
     (`expense.service.ts:2065`) — **NÃO confundir com `payInvoice`**, que **não escreve**
     esse campo (verificado: `monthly-overview.service.ts:3283-3416`);
   - a fatura do carimbo (`invoice_undo_card_id` + `invoice_undo_due_month`) ganhou um
     `PAGAMENTO_FATURA_CARTAO` **manual** posterior (`importId IS NULL`, PAGO, casado à
     fatura por `assignImplicitPayments` na janela `{payMonth,payMonth+1}` **ou** por
     `settlesInvoiceKey`) ⇒ 409 **`MANUAL_PAYMENT_OVERLAP`** — rede para o caso de
     `payInvoice` ter rodado numa imagem sem o pre-check do §4 B2;
   - a compra tem `RateioAllocation` cuja `plannedPaid`/schedule diverge do
     snapshot do item (rateio posterior).
6. **Aplicar** (só agora): por item `tx.cashFlowEntry.update({ where:{id},
   data:{ status: prev_status }})`; `applyUnpaid(tx, purchase, [entry])`
   (reusa `card-invoice-settlement.service.ts:466`); soft-delete dos itens
   (`updateMany deletedAt:null → now`); limpar o carimbo do pagamento
   (`invoiceUndoState → NULL`, counts → NULL). Depois segue o undo normal
   (vínculos cross-project + soft-delete do lote + soft-delete do import).
7. Retorno: `revertedInvoiceParcelas`, `reopenedInvoices` (due_months distintos),
   `notRevertedInvoiceLiquidations: 0`.

### 2.4 Concorrência — critérios de validação do PR 2 (C)

| cenário | resultado ESPERADO (asseverado no RED) | mecanismo — **comprovado por teste, não presumido** |
|---|---|---|
| **2 undos simultâneos do MESMO lote** | exatamente um retorna `revertedInvoiceParcelas > 0`. O outro: **OU** `{ ok:true, alreadyUndone:true }` **OU** 409 (`INCOMPLETE_TRAIL` / `ALREADY_UNDONE`) — **nunca** reversão parcial, **nunca** dupla reversão. Contagem final de `CashFlowEntry` PAGO == baseline pós-undo; no máximo UMA chamada com `revertedInvoiceParcelas > 0`. | releitura de `importRecord.deletedAt` + `activeItems` DENTRO da `$transaction` (passos 1 e 3) — não pré-check externo. **O índice único parcial NÃO impede a 2ª tentativa** (as linhas já viram soft-deleted no 1º commit): a proteção é o **recount do import + itens na tx** — se o 2º entra após o 1º commitar, `importRecord.deletedAt != null` ⇒ no-op `alreadyUndone`; se entra antes, `activeItems.length !== parcela_count` (ou o índice, na re-gravação) ⇒ 409/rollback. O desfecho exato sob contenção é **asseverado por §6.6 com `PrismaService` real + SQLite real** dentro da disjunção acima — este doc **não** afirma ordem de write-lock. |
| **re-undo serial** | 2ª chamada: `{ ok:true, alreadyUndone:true }`, zero parcelas revertidas de novo | `importRecord.deletedAt != null` relido na tx (passo 3) |
| **item do ledger soft-deletado por fora entre commit e undo** | 409 `INCOMPLETE_TRAIL`, zero escrita | `activeItems.length (0) !== parcela_count (N)` recontado na tx |
| **`SQLITE_BUSY` / contenção de escrita** | erro propaga → 5xx; idempotência/atomicidade são critérios a validar | **Sem PR de config obrigatório.** A medição local registrada de `PRAGMA busy_timeout = 5000` não é garantia universal de espera, retry ou ordem de lock. WAL, `busy_timeout` e `connection_limit` só mudam após medição específica, como patch corretivo se necessário. §6.6 define a prova com `PrismaService` + SQLite reais. |

---

## 3. Migration e rollback (E)

### 3.1 Migration — aditiva, sem backfill

`20260909XXXXXX_imported_invoice_liquidations`:
- `CREATE TABLE imported_invoice_liquidations (...)` + índice único **parcial**
  escrito à mão (Prisma não expressa `WHERE` — mesmo padrão de
  `20260904120000_add_dedupe_keys`) + índices auxiliares.
- `ALTER TABLE expenses ADD COLUMN invoice_undo_state TEXT;` (+ `parcela_count`,
  `due_month`, `card_id`, `trail_version`) — todas NULL default, **sem backfill**
  (D2: legado permanece bloqueado).
- Prisma schema: novo `model ImportedInvoiceLiquidation`, back-relations em LISTA
  (nunca `?` singular) em `Expense` (`importedInvoiceLiquidationsAsPayment[]`,
  `...AsPurchase[]`) e
  `CashFlowEntry` (`importedInvoiceLiquidations ImportedInvoiceLiquidation[]` —
  back-relation LISTA: N linhas históricas por `cash_flow_entry_id` são
  permitidas, a unicidade da ATIVA é garantida SÓ pelo índice único parcial
  `WHERE deleted_at IS NULL`, nunca por relação 1:1), 5 campos no `model Expense`.

### 3.2 Fixture de upgrade legado + `db:check` (regra da casa)

1. Fixture = backup sanitizado OU legada estruturalmente equivalente com ≥1
   `PAGAMENTO_FATURA_CARTAO` importado pré-#569 e parcelas já PAGO, **sem**
   nenhuma linha do ledger.
2. `prisma migrate deploy` sobre a fixture ⇒ tabela e colunas criadas, **zero
   linhas**, colunas de carimbo NULL.
3. `npm run db:check` (`PRAGMA foreign_key_check`) — zero órfãos.
4. `getImportDetail` do lote legado ⇒ `canUndo:false`, `blockReason:'LEGACY_NO_TRAIL'`;
   `undoImport` ⇒ 409. (fail-closed preservado, sem backfill.)

### 3.3 Rollback — piso compatível PR 1 e `DROP` futuro (E)

**Guarda de versão** (inalterada): `INVOICE_UNDO_TRAIL_VERSION` (const em
`card-invoice-settlement.service.ts`) grava no carimbo; `undoImport`/`getImportDetail`
**recusam fail-closed (409)** um carimbo com versão que não reconhecem.

**Piso de compatibilidade:** depois que o PR 1 gravar trilhas, o rollback tem de
preservar schema, carimbos, itens e todos os guards que protegem os dados existentes.
Uma imagem anterior ao PR 1 pode criar pagamentos sem carimbo **e** alterar
compras/pagamentos já protegidos sem manter a trilha. O fato de não escrever na
tabela nova não prova integridade: os demais writers ainda podem invalidá-la.

**Rollback forward-only:** publicar um **novo HEAD compatível**, por revert
(por exemplo, da habilitação do PR 2) **ou fix corretivo**, pelo pipeline canônico.
Não repinar imagem antiga, não reverter isoladamente o PR 1, não retirar os guards.
Continuam obrigatórios os gates strict de SHA completo de `main` antes de publicar
e após checks/smokes, dentro do lock, e a prova pós-deploy definida em
[`AGENTS.md`](../AGENTS.md) e [`DEPLOY.md`](../DEPLOY.md).
Esta revisão não executa nem autoriza rollback/deploy.

**Por que "bloquear só o ramo `matchedCard`" NÃO basta:** desligar a
liquidação-por-importação impede criar trilhas NOVAS sem carimbo, mas **não**
protege as trilhas JÁ gravadas contra os outros writers da imagem antiga
(`payInvoice` manual, `ExpenseService.update`/`remove` da compra ou do pagamento,
`undoInvoicePayment`, rateio `ratearSource`/`unratearSource`) — nenhum deles
conhece o carimbo nem o índice único parcial na imagem N-1 crua. Uma imagem de
rollback só é compatível se **preservar essas proteções**.

**Release-degrau (opção B) — o que a versão intermediária PRECISA conter** (o
mínimo para não corromper e **não perder efeito de liquidação**, sem a UX de undo):
- a migração inteira (tabela `imported_invoice_liquidations` + índice único
  parcial + 5 colunas de carimbo);
- **o REGISTRO CORRETO dos efeitos** em todo `PAGAMENTO_FATURA_CARTAO` que ela criar:
  `applyPreparedSettlement` devolvendo `flippedEntries` reais + `recordImportedLiquidations`
  + carimbo derivado do `apply` — `PROCESSED_SETTLED` (`N` itens) quando há parcela
  liquidada, `PROCESSED_NONE` (0 itens) **só** quando `flippedEntries.length === 0` de
  fato. Gravar `PROCESSED_NONE` **incondicionalmente** é errado: apaga a trilha da
  liquidação que a própria degrau executou;
- a checagem "há parcela ATIVA no ledger para este `card_id` + `due_month`?" (ou
  "esta compra/este pagamento tem item de ledger ativo?") nos writers:
  `payInvoice` (pre-check B2), `ExpenseService.update` e `ExpenseService.remove`
  (`assertCanMutateLinkedRows` — B3/B4/B5/B9), `guardRateioParticipation` (B6),
  `undoInvoicePayment` (B1), e o `undoImport`/`getImportDetail` com guarda de versão
  e bloqueio de `PROCESSED_SETTLED`. A reversão via ledger e seus motivos específicos
  de drift, inclusive `MANUAL_PAYMENT_OVERLAP`, ficam no PR 2.
  Sem isso a imagem-degrau volta a permitir mutação silenciosa de parcela
  liquidada.

**O que fica SÓ no PR 2 (habilitação do undo + UX), nunca o registro dos efeitos:**
`getImportDetail` com `requester` + `settlement{...}` exposto; `undoImport` revertendo
via ledger (estado 3); `InvoiceDetailPanel`/`ImportHistoryModal`; o resumo de commit
com `cardPaymentsPendingSettlement`. Até o PR 2, um lote com `PROCESSED_SETTLED`
responde `undoImport` 409 fail-closed (a degrau não sabe reverter), mas a trilha
**já está gravada corretamente** e o PR 2 a consome sem migração de dados.

**Opção antiga (A) retirada:** flag `matchedCard` off ou pausa apenas do importador
**não tornam compatível uma imagem sem guards**. Não são alternativa ao piso PR 1,
nem mitigação autorizada por uma janela curta. Mantém-se a release-degrau (B).

**`DROP` futuro — NÃO autorizado hoje.** "Zero linhas em `imported_invoice_liquidations`"
**não basta**: um pagamento processado com 0 liquidações carrega carimbo `PROCESSED_NONE`
e **nenhuma linha** — **zero linhas NÃO significa "recurso nunca usado"**; e
`PROCESSED_NONE` só é legítimo quando `flippedEntries.length === 0` de FATO no
`apply` (§2.1 passo 2), então um carimbo `PROCESSED_NONE` presente É uso real. O `DROP` da
tabela + das 5 colunas exige, além dos controles de §3.3.1, **AMBAS** as contagens
zeradas, sem ignorar histórico soft-deleted:

```sql
SELECT count(*) FROM imported_invoice_liquidations;
SELECT count(*) FROM expenses WHERE invoice_undo_state IS NOT NULL;
```

São critérios para uma futura migração destrutiva, não passos do rollback normal.

### 3.3.1 Parecer `platform-sre` (recebido)

**1. (B) release-degrau, não (A).** O stale-SHA gate (`cancel-in-progress: false` +
comparação do SHA completo com o HEAD de `main` antes de publicar e após checks — #629)
permanece strict. O novo HEAD de rollback pode ser um revert **ou fix**, desde que
compatível com a trilha e os guards do PR 1 (§3.3); a imagem sem guards está excluída.

**Estrutura obrigatória:** PR 1 = degrau (migração completa + **registro correto dos
efeitos**: `flippedEntries` reais do `apply` + `recordImportedLiquidations` + carimbo
`PROCESSED_SETTLED`/`PROCESSED_NONE` derivado do `apply` — nunca `PROCESSED_NONE`
sempre + checagens de "parcela ativa" nos writers + guarda de versão fail-closed;
**sem** a UX de undo e sem `getImportDetail.settlement`). PR 2 = habilitação do undo +
UX (consome a trilha já gravada, sem migração de dados). Sequência: degrau antes
de ligar o undo. Importação segue funcionando, mas há **limites visíveis**:
mutações incompatíveis são bloqueadas e "desfazer importação com liquidação"
continua fail-closed. A frase de erro "desfaça a importação primeiro" não habilita
esse caminho no PR 1.

**2. Writers da degrau** — a lista de §4 (B1–B6, B9) está correta. **Acréscimos
obrigatórios que o texto acima não listava:**
- **caminho de commit do extrato** (`bank-account.service.ts`, ramos `matchedCard` **e**
  `matchedCard === null`): gravar carimbo em todo `PAGAMENTO_FATURA_CARTAO` — derivado
  do `apply` (`PROCESSED_SETTLED` se liquidou, `PROCESSED_NONE` se não), nunca
  `PROCESSED_NONE` fixo — sem isso a degrau reabre o estado-1 indevido ou apaga a trilha;
- **guarda de versão em `undoImport` E `getImportDetail`**: carimbo com
  `invoice_undo_trail_version` não reconhecida ⇒ 409 fail-closed (rolar entre degrau e
  feature nas duas direções);
- **fail-closed da degrau sobre `PROCESSED_SETTLED`**: o PR 1 **cria esse estado**
  quando liquida parcelas e grava os itens reais; `getImportDetail` mantém
  `canUndo:false` e `undoImport` 409. Helpers de reversão no código não significam
  undo habilitado: o fluxo da aplicação só os consome para reversão no PR 2.

**3. Critério de `DROP` seguro** — as duas contagens são a base certa, insuficientes
como escritas. Complementos:
- medir **em produção** (`fly ssh console -a reformaflow-api -C "sqlite3 -readonly
  /data/dev.db '<sql>'"`), nunca o `dev.db` local: `count(*) FROM
  imported_invoice_liquidations` (sem filtro de `deleted_at` — históricas também são
  trilha) **E** `count(*) FROM expenses WHERE invoice_undo_state IS NOT NULL`, ambas `= 0`;
- **fechar o TOCTOU**: contagens no banco de produção, imediatamente antes da
  futura migração, **sem writers em execução** desde a medição até a conclusão;
  flag `matchedCard` off não substitui quiesce dos escritores afetados;
- backup restaurável timestamped, **restore verificado** e `PRAGMA integrity_check`
  antes da operação;
- `DROP` só via nova migração forward, nunca `migrate resolve --rolled-back` + `DROP`
  manual;
- **autorização futura e explícita do PO** (mutação destrutiva de trilha);
  o fechamento do PR 1 **não** concede essa autorização;
- documentar em: cabeçalho da migração aditiva, cabeçalho da futura migração de `DROP`
  (as 2 queries + ausência de writers + backup/restore + PO) e `DEPLOY.md`
  (runbook). Não criar contrato novo em `AGENTS.md`/`CLAUDE.md`.

**4. Ordem / quiesce / contenção:**
- ordem confirmada pelo entrypoint migrate-first (Dockerfile) — **não** alterar;
  máquina única (`auto_stop_machines=off`, `min_machines_running=1`) — o swap de máquina
  do Fly dá o downtime breve já aceito;
- **migração aditiva, sem quiesce extra previsto no desenho original**:
  `CREATE TABLE` nova + `CREATE INDEX` em tabela vazia +
  `ALTER TABLE ADD COLUMN` de 5 colunas nullable sem default (metadado O(1) no SQLite,
  sem rewrite); sem backfill. Isso não dispensa a validação de upgrade nem a
  ausência de writers exigida para um eventual `DROP`;
- **Contenção `undoImport` — NÃO exige PR de config obrigatório.** `PrismaService` chama
  `super()` sem args e a `DATABASE_URL` não tem query params (`prisma.service.ts:12`),
  mas contraprova local com `PrismaService` real mediu **`PRAGMA busy_timeout = 5000`**
  nessa configuração local do engine Prisma. **Não é garantia universal** de que
  todo escritor aguarde 5 s, nem prova do comportamento em produção. A transação
  ampliada requer medição de contenção no ambiente relevante.
  Qualquer ajuste (WAL, `busy_timeout` maior, `connection_limit=1`) depende de **medição
  específica** da contenção nova — não de suposição — e pode entrar depois como **patch
  corretivo próprio** (o gate de SHA aceita novo HEAD compatível por revert ou patch;
  não é pré-requisito do PR 2). Idempotência, atomicidade e desfecho sob contenção
  devem ser comprovados por §6.6 com `PrismaService` + SQLite reais, não por parecer.
- gates stale-SHA + prova pós-deploy inalterados; **não** adicionar `/health` nem SHA build arg.

**5. Fixture de upgrade legado** — origem: backup de produção sanitizado OU legada
estruturalmente equivalente (passar só contra banco novo não é evidência — #629). No
schema **pré-migração** deve conter: (a) `PAGAMENTO_FATURA_CARTAO` importado pré-#569 com
`CashFlowEntry` já `PAGO` e zero ledger (estado 1); (b) lote misto (estado 4); (c)
`PAGAMENTO_FATURA_CARTAO` com `cardLast4 = NULL` (M8); (d) pagamento manual
(`importId IS NULL`, `PAGO`) casado por `settlesInvoiceKey`/janela `{payMonth,payMonth+1}`;
(e) compra cross-project em cartão compartilhado (ACL-por-participante); (f) despesa
adotada com `importId`/`externalId` carimbados (#672); (g) massa p/ `foreign_key_check`
limpo (#628). Asserções pós `migrate deploy`: tabela+índice+5 colunas existem, ledger 0
linhas, todas `invoice_undo_*` NULL; `db:check` 0 violações; `getImportDetail` do lote
legado `canUndo:false`/`LEGACY_NO_TRAIL`, `undoImport` 409; registrar DB de origem,
tamanho e tempo do `ALTER`; drill de backup/restore executado.

**Fechamento documental / futuro operacional:**
- O parent conduz o fechamento do PR 1, autorizado sem novo handoff humano;
  não confundir essa autorização com habilitação do PR 2 ou do `DROP`.
- O runbook existente é [`DEPLOY.md`](../DEPLOY.md), **na raiz**. Sua referência
  específica a este piso de rollback permanece pendente de integração pelo parent.
- `DROP` só volta à pauta se houver necessidade futura e autorização explícita do
  PO com todas as pré-condições acima; não é requisito para fechar o PR 1.
- Configuração Prisma continua opcional, dirigida por medição (§2.4), não por
  suposição sobre WAL, pool ou timeout.

---

## 4. Caminhos que modificam/assumem as parcelas liquidadas (B) — tratamento mínimo

Sem framework genérico de auditoria. Cada linha: caminho (arquivo:linha) →
tratamento → ponto concreto a mudar.

**B2 — receita técnica suspensa para fechamento pelo parent.** O plano antigo
confundia resolução de fatura com `dto.month`/data de compra; não deve orientar
uma implementação nem justificar um bug. Na base `57287dad`,
`MonthlyOverviewService.payInvoice` ainda combina `dto.month` com
`resolveEffectiveDueMonths`; este helper calcula totais sem receber `requester`
e consulta o fallback mesmo após encontrar um alvo por vencimento. A correção de
build informada pelo parent vai **unificar o resolver autorizado antes dos
totais**, respeitando a precedência existente e **sem ampliar as janelas**.
Validar na branch integrada; as receitas B2 repetidas no plano RED abaixo são
históricas, não uma alteração do contrato de negócio. Os guards e o manual não
certificam essa correção como concluída.

**Outras divergências devolvidas ao parent, sem mudar a regra:** B5/B9 abaixo
descrevem proteção do pagamento carimbado, mas `guardImportedInvoiceTrail`
(`expense.service.ts:716–756` em `57287dad`) restringe esses bloqueios a
`PROCESSED_SETTLED`. Validar o caso `PROCESSED_NONE` antes de considerar esses
itens fechados. Também falta harmonizar a documentação da guarda de versão:
§3.3/§3.3.1 falam em 409 nos dois caminhos; `classifyInvoiceUndoTrail`
(`bank-account.service.ts:1317–1319`) retorna `canUndo:false` na leitura.

| # | caminho | o que faz às parcelas | tratamento mínimo | ponto concreto |
|---|---|---|---|---|
| B1 | `MonthlyOverviewService.undoInvoicePayment` `monthly-overview.service.ts:3448` (cockpit manual) | reverte `CashFlowEntry` PAGO→PLANEJADO por `dueMonth`/`settlesInvoiceKey` | **drift-check passo 5** pega `status !== 'PAGO'` ⇒ 409 `DRIFT`, zero escrita. Além disso: pagamento com `importId != null` já é 404 no cockpit (`importedMatched` ⇒ `NotFoundException`, ~`:3548-3558`) — manter. | nenhuma mudança nova; teste trava a interação |
| B2 | `MonthlyOverviewService.payInvoice` (cockpit manual) | criaria um 2º pagamento sobre uma fatura liquidada por importação | Parcela ativa no ledger da fatura efetivamente visada ⇒ 409 `INVOICE_HAS_IMPORT_TRAIL`, zero escrita, mesmo com `prepared` vazio. `PROCESSED_NONE` sem itens não dispara. Receita de resolução **suspensa**, ver nota acima; `MANUAL_PAYMENT_OVERLAP` no undo é PR 2. | correção do resolver em validação pelo backend/parent |
| B3 | `ExpenseService.update` `expense.service.ts:1444` — PATCH da COMPRA (valor/quantidade/parcelas) | regenera `CashFlowEntry` ⇒ muda `valor`/`parcela` | **bloquear no `assertCanMutateLinkedRows`** (`expense.service.ts:1465`): se a compra tem item de ledger ATIVO e o DTO muda `valor`/`quantidade`/`quantidadeParcela`/datas ⇒ `ConflictException` "compra liquidada por pagamento importado; desfaça a importação primeiro". | +cheque em `assertCanMutateLinkedRows` |
| B4 | `ExpenseService.update` — PATCH do PAGAMENTO `{ creditCardId }` | escolhe CARTÃO, não fatura (F) | **carimbo `PROCESSED_NONE` + `invoiceUndoCardId IS NULL` + zero itens ativos** (estado 2b, M8 "confirme qual cartão") ⇒ PATCH de `creditCardId` **PERMITIDO**: associa o cartão, **NÃO liquida parcela alguma**, o carimbo/proveniência permanece (opcionalmente atualiza `invoiceUndoCardId`). **Carimbo com itens ATIVOS (`PROCESSED_SETTLED`)** e o `creditCardId` novo ≠ `invoiceUndoCardId` ⇒ `ConflictException` (o carimbo/itens apontam para o cartão antigo). | +cheque em `assertCanMutateLinkedRows` |
| B9 | `ExpenseService.update` — PATCH do PAGAMENTO `{ tipoDespesa }` / ownership / `cardLast4` / `bankLast4` / `settlesInvoiceKey` | tiraria a proveniência que faz o par derivar (§1.2) | pagamento **com carimbo ATIVO** (`invoice_undo_state IS NOT NULL`, e para `PROCESSED_SETTLED` com itens no ledger) ⇒ `hasProtectedChange`/`changedToNeutralType` (`expense.service.ts:1509-1526`) retorna true ⇒ `ConflictException`. Um `PROCESSED_NONE` sem itens **não** bloqueia a associação de cartão (isso é B4). | +ramo em `hasProtectedChange` (carimbo ativo + muda `tipoDespesa`/ownership/`*Last4`/`settlesInvoiceKey`) |
| B5 | `ExpenseService.remove` `expense.service.ts:2190` — DELETE da COMPRA ou do PAGAMENTO | soft-delete da despesa + suas `CashFlowEntry` | COMPRA com item ativo ⇒ **bloquear** em `assertCanMutateLinkedRows` (ConflictException). PAGAMENTO com carimbo ⇒ **bloquear** ("desfaça pela importação"). Se escapar: drift-check `deletedAt != null` ⇒ 409. | +cheque em `assertCanMutateLinkedRows` |
| B6 | Rateio `conciliacao.ratearSource` / `unratearSource` (via `expense.service.ts:2014`, `bank-account.service.ts:1533`) | sobrescreve schedule/`paidParcelas` do alvo | `guardRateioParticipation` (`expense.service.ts` ~`:2014`): se a compra participante tem item de ledger ativo ⇒ `ConflictException`. Escape ⇒ drift-check `parcela`/rateio-snapshot ⇒ 409. | +cheque em `guardRateioParticipation` |
| B7 | Recorrência `propagateRecurrences` `bank-account.service.ts:1230` / `RecurringBill` upsert | cria despesa NOVA em CASA/CARRO; **não toca** `CashFlowEntry` PAGO da compra de cartão | nenhum — documentar que não interfere | — |
| B8 | Dedup/adoção `bank-account.service.ts:1463` (Tier A/B #672) | carimba `importId`/`externalId` numa despesa pré-existente | se um `PAGAMENTO_FATURA_CARTAO` for adotado, ele **não tem carimbo** ⇒ estado 1/4 ⇒ lote bloqueado (fail-closed aceitável). | nenhuma mudança; teste trava |

Princípio: **1 guard de escrita** (`assertCanMutateLinkedRows` +
`guardRateioParticipation`, que já existem e já recebem a compra e o requester) +
**o drift-check de undo** como rede. Nada além disso.

---

## 5. Tabela — bloqueio (A–F) → correção → evidência → teste

| bloq | correção | evidência no código (arquivo:linha) | teste necessário |
|---|---|---|---|
| **A** resultado persistente e completo; 4 estados; sem corte por data; preservar unicidade de reivindicação | carimbo (`invoice_undo_state`/`parcela_count`/`due_month`/`card_id`/`trail_version`) no `Expense` + tabela `imported_invoice_liquidation`; vínculo por `importId` imutável; completude = `count(itens ativos) === parcela_count`; índice único parcial em `cash_flow_entry_id WHERE deleted_at IS NULL` | corte por data a trocar: `bank-account.service.ts:1305,1310,1452,1459`; `applyPreparedSettlement` conta do `prepared` `card-invoice-settlement.service.ts:620-624` | `ledger.spec` (§6.1): 1 linha/flip, prev_status capturado, `PROCESSED_NONE` vs `PROCESSED_SETTLED`, P2002 na 2ª reivindicação, re-reivindicação após soft-delete, completude `count != parcela_count → 409` |
| **B** alterações posteriores / adoção | guard em `assertCanMutateLinkedRows` (`expense.service.ts:1465`) e `guardRateioParticipation` (`~:2014`) + drift-check de undo | B1 `monthly-overview.service.ts:3448`+`:3548-3558`; B2 `monthly-overview.service.ts:~3340` (pre-check em `payInvoice`, após `card` `:3322-3339` + `prepared`, dentro da `$transaction` `:3283`); B3/B4 `expense.service.ts:1444`; B5 `:2190`; B6 `:2014`; B8 `bank-account.service.ts:1463`; **B9** `expense.service.ts:1509-1526` (`hasProtectedChange` — PATCH `tipoDespesa`/ownership de pagamento carimbado) | `later-mutation.spec` (§6.4): um caso por caminho B1–B6/B8/B9, cada um ⇒ bloqueio no write OU 409 no undo, zero escrita. **B2 executa `payInvoice` REAL.** |
| **C** atomicidade / efeitos efetivos / autz / concorrência | `applyPreparedSettlement` devolve `flippedEntries`; `recordImportedLiquidations` NÃO capturado ⇒ rollback do lote (`$transaction` `:1151`); `getImportDetail` recebe `requester`; ambos revalidam na tx com ACL por participante cross-project; prova de "já desfeito" = import + itens na tx sob write-lock | `bank-account.service.ts:1151` (tx do lote), `:2497` (apply), `:1298/1416` (só `findAccount`), `card-invoice-settlement.service.ts:190` (`assertCanSettlePurchase`), `:613-628` (apply a mudar) | `atomicity.spec` (§6.3): falha forçada em `recordImportedLiquidations` ⇒ NADA persiste (import, despesas, caixa, itens); `authz.spec` (§6.5): requester sem ACL de projeto participante ⇒ 404, zero escrita; `concurrency.spec` (§6.6): 2 undos / re-undo / item removido no meio |
| **D** janelas e estados honestos | documentar 60d / ±10d / {m,m+1} / 75d / ranking individualmente (nenhuma unificada); `outcome: SETTLED | NO_SETTLEMENT` é derivado de `flippedEntries` do **`apply`** (transições efetivas), nunca da contagem do `prepare`; diferença acima da tolerância pode ser pagamento **A MAIOR**, nunca rotulada `PARTIAL`; sub-motivo = `hint` **não-persistido/não-confiável**; identificação de cartão ≠ liquidação de fatura | `bank-account.service.ts:2822-2831` (60d + `tolerance=200`), `:2894` (±10d); `card-invoice-settlement.service.ts:257` ({m,m+1}), `:682` (75d), `:295` (tolerância) | `windows.spec` (§6.2): cada janela pina o seu valor; `outcome === NO_SETTLEMENT` para fatura já paga, diferença a menos, diferença a MAIS e nenhuma fatura — sem asseverar `hint` como coluna |
| **E** migration / rollback | Aditiva sem backfill; piso compatível PR 1 e novo HEAD por revert ou fix (§3.3). `DROP` não autorizado hoje; futuro exige PO explícito + ambas as contagens zero em produção, sem writers + backup/restore. Configuração só após medição (§3.3.1); `busy_timeout=5000` é observação local, não garantia universal. | padrão `prisma/migrations/20260904120000_add_dedupe_keys` (índice parcial à mão) | `migration-upgrade.spec` (§6.7): fixture legada, colunas NULL, `db:check`, legado bloqueado; `DROP` reprova com zero itens mas algum carimbo |
| **F** UX sem promessas / operações implícitas | remover "fatura marcada paga quando compras entrarem"; `creditCardId` = cartão, não fatura; detalhe usa `cardId` estável + lista de pagamentos; "adicionar no contexto" mostra `dueMonth` DERIVADO por `caixaMonthForCardPurchase`; idempotência ≠ reversibilidade | texto atual do resumo `bank-account.service.ts:1240-1258`; `caixaMonthForCardPurchase` (domínio, usado em `card-invoice-settlement.service.ts:270`) | testes de contrato de resposta (§6.8): `getImportDetail.settlement` tem `cardId` (não `last4`) e `payments[]`; `canUndo`/`blockReason` corretos por estado |

---

## 6. Plano RED por fase (referência de validação, não resultado atual)

Runner: **`PrismaService` real + banco descartável** (`scripts/test-db-env.cjs`),
NUNCA `prisma/dev.db`, NUNCA `new PrismaClient()` (Scar #616 — o `$use` tem de
rodar). Relógio fixo (`vi.setSystemTime` no domínio; no Nest, injeção de data via
param já existente) nos casos por mês. **Sem `it.todo`/`describe.skip`** — cada
`it` deve ter arrange/act/assert real. O registro da rodada de design relata REDs
materializados antes da implementação; não é evidência de resultado no HEAD atual.
O fechamento de build/testes pertence ao parent e às branches de backend/QA;
esta revisão documental **não executou testes**.

**O GREEN é feito em 2 PRs (§3.3.1) — as duas listas são disjuntas:**

- **PR 1 (degrau) — SÓ o registro real da liquidação + as proteções:** migração
  aditiva (tabela `imported_invoice_liquidations` + índice único parcial + 5
  colunas de carimbo); `INVOICE_UNDO_TRAIL_VERSION`; `applyPreparedSettlement`
  devolvendo `flippedEntries` reais; `recordImportedLiquidations`; helpers
  `prepareRevertImportedLiquidations` / `applyRevertImportedLiquidations` podem
  existir sem caller de undo na aplicação até o PR 2; carimbo
  derivado do `apply` no commit (ramos `matchedCard` **e** `matchedCard === null`);
  guards B1–B6/B9 nos writers; pre-check B2 em `payInvoice`; guarda de versão
  fail-closed; fail-closed da degrau ao encontrar `PROCESSED_SETTLED`. Cobre os RED
  de §6.1, §6.2, §6.3 (rollback do `record…`), §6.4 (B1–B6/B9 + pre-check B2), §6.7.
  No PR 1, `undoImport` de um lote com `PROCESSED_SETTLED` segue respondendo 409
  fail-closed (a degrau não reverte via ledger).
- **PR 2 (feature) — SÓ a habilitação do undo + UX, consome a trilha já gravada:**
  `getImportDetail(…, requester)` + `settlement{ state, cardId, dueMonth, payments[] }`;
  `undoImport` revertendo via ledger (estado 3); ACL por participante cross-project;
  drift-check com motivos (`DRIFT` / `MANUAL_PAYMENT_OVERLAP`); concorrência (recount
  import+itens na tx); `cardPaymentsPendingSettlement` no resumo do commit;
  `InvoiceDetailPanel` / `ImportHistoryModal`. Cobre os RED de §6.5, §6.6, §6.8,
  §6.3 (baseline `getAccountView` pós-undo) e §6.4 (motivo específico do drift em
  B1b/B2d). **Nenhuma migração de dados.** Rollback mantém o piso PR 1 (§3.3).

Cada arquivo de spec carrega no cabeçalho a que PR ele pertence.

Fixtures compartilhadas (helper `__tests__/invoice-undo.fixtures.ts`):
- `seedCardWithClosingDue(prisma, { closingDay:20, dueDay:1 })` → projeto PESSOAL + `CreditCard`.
- `seedInstallmentPurchase(prisma, card, { parcelas:3, valorCents:30000, primeiraData })` → `Expense` PARCELADO + 3 `CashFlowEntry` PLANEJADO.
- `seedBankAccount(prisma, project)` + `commitStatement(service, { debitCents, date })` helper que roda `commitImport` com um OFX sintético de 1 débito.
- `baselineAccountView(service)` → snapshot de `getAccountView` para deep-equal.

### 6.1 `apps/api/src/credit-card/card-invoice-settlement.ledger.spec.ts`
- `it('recordImportedLiquidations grava 1 linha por CashFlowEntry virada PLANEJADO→PAGO, com prev_status="PLANEJADO", entry_valor_cents e parcela do momento')`
  arrange: compra 3x R$100, fatura fecha; act: `settleInvoice` via caminho commit; assert: `prisma.importedInvoiceLiquidation.findMany({where:{paymentExpenseId}})` tem `length` = nº de parcelas do `dueMonth`; cada linha `prevStatus==='PLANEJADO'`, `entryValorCents===10000`, `parcela` bate com a entry.
- `it('estratégia 1 (vencimento): grava só as parcelas do dueMonth alvo; parcelas de outro ciclo do mesmo cartão ficam fora do ledger e PLANEJADO')`
  assert: `count` do ledger = parcelas do ciclo alvo; entries do ciclo seguinte seguem `status:'PLANEJADO'` e sem linha de ledger.
- `it('estratégia 2 (fallback fatura importada): grava exatamente a parcela em aberto mais antiga de cada compra do import casado')`
  arrange: cartão SEM closing/due; `CreditCardStatementImport` com total ≈ pagamento dentro de 75d/±R$2; assert: 1 linha por compra, sempre a `parcela` "1/n".
- `it('diferença acima da tolerância na estratégia 1 (para MENOS e para MAIS) → outcome NO_SETTLEMENT, 0 linhas, carimbo PROCESSED_NONE, invoice_undo_card_id = id do cartão')` (2 casos)
- `it('fatura já toda paga → outcome NO_SETTLEMENT, 0 linhas, carimbo PROCESSED_NONE; nenhum rótulo persistido de motivo')`
- `it('commit com matchedCard === null (M8): pagamento recebe carimbo PROCESSED_NONE, invoice_undo_card_id NULL, invoice_undo_parcela_count 0, 0 itens; getImportDetail NÃO o lê como legado (canUndo do lote não bloqueado por ele)')`
- `it('índice único parcial: segundo recordImportedLiquidations na MESMA entry ativa → P2002')`
  act: chamar `recordImportedLiquidations` 2x com o mesmo `cashFlowEntryId` ativo; assert: `await expect(...).rejects` com code `P2002`.
- `it('após soft-delete das linhas, a MESMA entry pode ser reivindicada de novo')`
  assert: 1ª grava, `updateMany deletedAt`, 2ª grava sem erro.
- `it('applyRevertImportedLiquidations restaura status→prev_status e recomputa paidParcelas/status da compra — parcelada (parcial) e à vista (total)')`
- `it('recordImportedLiquidations grava tenant_id; prepareRevert filtra por tenant_id — chamada sem tenantId não apaga linhas de outro tenant')`
- `it('applyPreparedSettlement devolve flippedEntries só das entries que de fato virou PAGO (entry já PAGO não entra)')`
  arrange: 1 das 3 parcelas já PAGO; assert: `flippedEntries.length === 2`, `settledParcelas` idem.

### 6.2 `apps/api/src/credit-card/card-invoice-settlement.windows.spec.ts`
- `it('liquidação por vencimento usa janela de mês {payMonth, payMonth+1}: pagamento em 2026-06-30 fecha fatura com vencimento 2026-07-01')`
  relógio fixo; assert: `outcome==='SETTLED'`, `invoiceUndoDueMonth==='2026-07'`.
- `it('fallback findImportByTotal respeita 75 dias corridos: import criado há 76 dias NÃO casa; há 74 dias casa')` (2 casos).
- `it('fallback tolera ±R$2 no totalAmountCents e recusa ±R$2,01')` (2 casos).
- `it('identificação de cartão por importação usa 60 dias (bank-account): import há 61d não identifica; 59d identifica')`.
- `it('identificação estrita por valor usa ±10 dias: pagamento 11d após a compra-final não identifica; 9d identifica')`.
- `it('outcome SETTLED sse e só se flippedEntries.length > 0; caso contrário NO_SETTLEMENT')`.
- `it('fatura já paga, diferença a menos, diferença a MAIS, nenhuma fatura → todos NO_SETTLEMENT; hint é best-effort e NÃO é asseverado como coluna persistida')`.

### 6.3 `apps/api/src/bank-account/bank-account.undo-import-atomicity.spec.ts`
- `it('falha forçada em recordImportedLiquidations aborta o commit inteiro: 0 Expense, 0 CashFlowEntry, 0 BankStatementImport, 0 ImportedInvoiceLiquidation, entries seguem PLANEJADO')`
  arrange: forçar P2002 semeando uma liquidação ativa pré-existente na entry que o commit vai tocar; act: `commitImport`; assert: `rejects` + todas as contagens no baseline exato.
- `it('undoImport: falha forçada no update de uma entry no meio → rollback total, nenhuma outra entry/caixa/vínculo/import alterado')`
  (forçar erro via constraint/mocked failure no meio do laço do passo 6).
- `it('pagar-por-import → undoImport devolve getAccountView (caixaHoje, devoCartaoTotal, faturas[].pending, saidas[], comprasCartao[]) ao valor EXATO pré-import — deep-equal centavo a centavo')`.

### 6.4 `apps/api/src/bank-account/bank-account.undo-import-later-mutation.spec.ts`
Um `it` por caminho de B:
- `it('B1 undoInvoicePayment (REAL, monthly-overview.service.ts) já responde 404 quando o pagamento casado tem importId != null (~:3548-3558); ledger intacto')`.
- `it('B1b undoInvoicePayment reverteu uma parcela do ledger de OUTRO caminho antes do undo → undoImport 409 DRIFT, zero escrita')`.
- `it('B2 payInvoice REAL (não fabrica carimbo): trilha PROCESSED_SETTLED + itens ATIVOS no card+dueMonth alvo → 409 INVOICE_HAS_IMPORT_TRAIL; zero PAGAMENTO_FATURA_CARTAO novo; entries seguem PAGO; ledger e carimbo intactos')`.
- `it('B2b payInvoice REAL: trilha PROCESSED_NONE (zero liquidações) no MESMO card+dueMonth → payInvoice PERMITE (não 409); cria o PAGAMENTO_FATURA_CARTAO manual normalmente')`.
- `it('B2c importar+liquidar a fatura inteira (todas as parcelas → PAGO) → prepared do payInvoice fica VAZIO; tentar payInvoice manual no MESMO cartão em OUTRA data de pagamento → 409 INVOICE_HAS_IMPORT_TRAIL (dueMonth resolvido do DTO, não do prepared); zero PAGAMENTO_FATURA_CARTAO novo; nenhuma saída nova no caixa')`.
- `it('B2c-neg payInvoice REAL: cartão sem closingDay/dueDay e sem match de valor → nenhum dueMonth alvo resolvível → pre-check não dispara; a rede é MANUAL_PAYMENT_OVERLAP no undoImport (ver B2d)')`.
- `it('B2d pagamento manual pré-existente (imagem sem o pre-check, semeado direto) casado à fatura do carimbo → undoImport 409 MANUAL_PAYMENT_OVERLAP, zero escrita')`.
- `it('B3 PATCH /expenses/:id muda valor da compra liquidada → 409 ConflictException no update; ledger intacto')`.
- `it('B4a PATCH creditCardId de pagamento PROCESSED_SETTLED (itens ativos) para outro cartão → 409 ConflictException; ledger intacto')`.
- `it('B4b PATCH creditCardId de pagamento PROCESSED_NONE sem cartão (invoiceUndoCardId NULL) e sem itens → PERMITIDO; carimbo preservado; nenhuma parcela liquidada; ledger continua vazio; invoiceUndoCardId pode passar a apontar o cartão associado')`.
- `it('B5a DELETE da compra liquidada → 409 no remove; B5b DELETE do pagamento carimbado → 409')`.
- `it('B6 ratear a compra liquidada → 409 em guardRateioParticipation')`.
- `it('B9a PATCH /expenses/:id muda tipoDespesa do PAGAMENTO_FATURA_CARTAO com carimbo ATIVO (itens no ledger) → 409 ConflictException em hasProtectedChange; carimbo, importId e cardLast4 intactos')`.
- `it('B9b PATCH cardLast4/bankLast4/settlesInvoiceKey do pagamento carimbado → 409 ConflictException')`.
- `it('B8 PAGAMENTO_FATURA_CARTAO adotado na dedup (sem carimbo) → lote fica canUndo:false / undoImport 409 LEGACY_OR_MIXED')`.
- `it('drift por entry soft-deletada → 409, zero escrita')`, `it('drift por settledByExpenseId posterior → 409')`.

### 6.5 `apps/api/src/bank-account/bank-account.undo-import-authz.spec.ts`
- `it('getImportDetail agora exige requester (controller passa @CurrentUser); requester sem acesso à conta → 404')`.
- `it('undoImport: compra liquidada pertence a projeto REFORMA que o requester NÃO pode ver → 404 "Fatura não encontrada", zero escrita')`
  (cartão compartilhado entre PESSOAL e REFORMA; requester só PESSOAL).
- `it('getImportDetail: mesma revalidação — canUndo:false + blockReason quando requester não vê um participante')`.
- `it('ADMIN vê todos os participantes → canUndo:true')`.

### 6.6 `apps/api/src/bank-account/bank-account.undo-import-concurrency.spec.ts`
- `it('dois undoImport simultâneos do mesmo lote: no máximo UM resultado com revertedInvoiceParcelas>0; o outro OU alreadyUndone:true OU 409 (INCOMPLETE_TRAIL/ALREADY_UNDONE); contagem de CashFlowEntry PAGO == baseline pós-undo (nunca parcial, nunca dupla reversão)')`
  act: `Promise.allSettled([undoImport(), undoImport()])`; assert: `results.filter(r => r.value?.revertedInvoiceParcelas > 0).length <= 1`, o outro settled cai na disjunção, `count(CashFlowEntry PAGO) === baseline`. Comentar no teste: o índice único parcial NÃO impede a 2ª tentativa — a proteção asseverada é o recount import+itens na tx.
- `it('re-undo serial → { ok:true, alreadyUndone:true }, zero parcelas revertidas de novo')`.
- `it('item do ledger soft-deletado por fora entre commit e undo → 409 INCOMPLETE_TRAIL (count != parcela_count), zero escrita')`.
- `it('prova de já-desfeito não depende de count:0 — com import.deletedAt=null mas zero itens ativos e carimbo PROCESSED_SETTLED → 409, não no-op')`.

### 6.7 `apps/api/src/prisma/migrations-invoice-undo-upgrade.spec.ts`
- `it('migrate deploy sobre fixture legada: cria imported_invoice_liquidations vazia e colunas invoice_undo_* NULL; PRAGMA foreign_key_check zero violações')`.
- `it('lote legado (PAGAMENTO_FATURA_CARTAO sem carimbo, parcelas PAGO) após migration: getImportDetail canUndo:false / undoImport 409, sem backfill')`.
- `it('carimbo com trail_version desconhecida → getImportDetail canUndo:false, undoImport 409 (guarda de versão)')`.
- `it('critério de DROP seguro: base com 0 linhas em imported_invoice_liquidations MAS ≥1 expense com invoice_undo_state = PROCESSED_NONE → o check de pré-condição de rollback destrutivo reprova (as duas contagens, não só a da tabela)')`.

### 6.8 `apps/api/src/bank-account/bank-account.import-detail-contract.spec.ts`
- `it('getImportDetail.settlement identifica o cartão por cardId estável, nunca last4')`.
- `it('duas importações que pagam a MESMA fatura → settlement.payments tem 2 entradas com paymentExpenseId/importId distintos')`.
- `it('estado honesto: cartão identificado, nenhuma parcela liquidada → state NO_SETTLEMENT (nunca ALREADY_PAID/PARTIAL), cardId preenchido, canUndo:true, reopenedInvoices:[]')`.
- `it('estado honesto: pagamento novo SEM cartão (M8) → state NO_SETTLEMENT, cardId null, canUndo:true; NÃO aparece como LEGACY_NO_TRAIL')`.
- `it('idempotência ≠ reversibilidade: 2º undoImport é no-op (idempotente), mas lote com drift responde 409 (não reversível) — asserção explícita dos dois')`.

### 6.9 Frontend (materializa `frontend-expert`) — `apps/web` — **tudo PR 2** (consome o `settlement{…}` que só o PR 2 expõe)
- `InvoiceDetailPanel.test.tsx`: renderiza estados `SETTLED_BY_IMPORT` / `NO_SETTLEMENT` / `LEGACY_NO_TRAIL` / `DRIFT` (mais o `hint` best-effort quando presente, marcado como não-confiável na UI) a partir do contrato tipado (não do texto renderizado); CTA vem de `actions[]` do servidor, nunca sintetizado (Scar #499). **Nenhum estado promete "fatura já paga" ou "pagamento parcial"**; a única reversão financeira oferecida é "Desfazer a importação (LOTE inteiro)".
- `ImportHistoryModal.test.tsx`: `canUndo:false` + `blockReason` ⇒ botão visível `disabled`+`aria-disabled`, ≥44px; texto de drift honesto, sem "ajuste manual" sem caminho.
- QA de jornada (desktop + 375/390) fica com `journey-qa` independente.

---

## 7. Fluxo UX — baseline histórico → alvo completo (F)

**Não é inventário de recursos entregues.** Registro e guards pertencem ao PR 1
em validação; reversão `SETTLED`, leitura de settlement, novos sinais e painel
são PR 2 futuro. O comportamento visível do degrau está no
[manual](manual-do-aplicativo.md#569--proteções-da-liquidação-por-extrato-pr-1-em-validação).
As ações cross-project já existentes de vincular/criar despesa permanecem nos
caminhos elegíveis; **nova criação direta/inline na prévia é fora do escopo**,
em avaliação separada, não entrega do PR 1.

### 7.1 Pipeline

| etapa | baseline `e66e49c1` | alvo do design (PR 1 + PR 2) |
|---|---|---|
| prévia identifica cartão / fatura | `prepareSettleInvoice` (`:2478`), `resolveTargetDueMonth`/`findImportByTotal` | inalterado (janelas idem) |
| commit liquida | `applyPreparedSettlement` incondicional, retorno contado do `prepared` | devolve `flippedEntries`; `+ recordImportedLiquidations` + carimbo, MESMA tx; P2002 ⇒ rollback do lote |
| commit — cartão id., fatura não fecha (parcial / a maior / já paga / encargo) | grava pagamento com `cardLast4`, silencioso | grava pagamento + carimbo `PROCESSED_NONE` (**`card_id` preenchido**); `outcome NO_SETTLEMENT`; resumo conta `cardPaymentsPendingSettlement`; **sem** promessa de liquidação futura |
| commit — cartão **NÃO** identificado (M8) | grava pagamento `cardLast4:null`, sem trilha | grava pagamento + carimbo `PROCESSED_NONE` (**`card_id` NULL**), 0 itens; undo normal sem cartão; **não** bloqueia o lote; PATCH posterior de `creditCardId` é PERMITIDO e só associa o cartão (não liquida nada — B4b) |
| `getImportDetail` | sem requester, corte por data, `canUndo:false` se há pagamento de fatura | recebe requester, escopo por `importId`, revalida na tx, `canUndo` por estado real; expõe `settlement{ state, cardId, dueMonth, payments[] }` |
| `undoImport` | 409 se há `PAGAMENTO_FATURA_CARTAO` | reverte via ledger (estado 3), permite (estados 2a/2b), 409 (estados 1/4/drift/`MANUAL_PAYMENT_OVERLAP`/ACL), rollback total em falha |
| desfazer manual (cockpit) para pagamento importado | `undoInvoicePayment` 404 se `importId != null` | inalterado — importado só volta por `undoImport` |

### 7.2 Ações — existentes vs NÃO aprovadas

| ação | status | superfície | efeito no CAIXA | efeito na FATURA | texto |
|---|---|---|---|---|---|
| **Desfazer a importação (LOTE inteiro)** | EXISTENTE; ampliação para `SETTLED` **só no PR 2 futuro** | `ImportHistoryModal` → `canUndo` | estorna todas as saídas do lote | no PR 2, reabre as faturas que o lote liquidou (via ledger) | Texto-alvo PR 2: "Remove tudo que esta importação criou e reabre as faturas que ela pagou." |
| **Desfazer pagamento manual** | EXISTENTE | `UndoInvoicePaymentDialog` (§14) | estorna o pagamento manual | reabre a fatura | inalterado |
| **Adicionar compra no contexto do cartão** | EXISTENTE (só pré-preenche) | launcher de despesa (`expense-options.ts`) com `creditCardId` + `dataCompra` sugeridos | nenhum até a fatura ser paga | entra na fatura **cujo vencimento o backend DERIVA** de `caixaMonthForCardPurchase(dataInicioParcela, closingDay, dueDay)` — preencher cartão+mês **não** basta | "Esta compra cai na fatura que vence em {mês derivado}. Não altera o caixa até a fatura ser paga." |
| **Corrigir o cartão do pagamento** (`PATCH {creditCardId}`) | EXISTENTE | detalhe do pagamento | nenhum | **escolhe o CARTÃO, não a fatura**; recálculo é só de leitura. PERMITIDO no estado 2b (carimbo `PROCESSED_NONE`, `invoiceUndoCardId` NULL, zero itens — fluxo M8 "confirme qual cartão"); BLOQUEADO (409) se o carimbo tem itens ATIVOS e o cartão novo diverge (B4/B9). | "Muda a qual cartão este pagamento pertence." (NÃO "confirma qual fatura foi quitada") |
| **Painel "Detalhe da fatura"** (leitura) | **PR 2 FUTURO — aprovado, não habilitado pelo PR 1** | drill da linha de fatura em `MovimentacoesSection`/`ContaAnoView` | nenhum | mostra compras da fatura + relação com pagamento(s)/importação(ões), `cardId` estável (nullable), estado honesto (`SETTLED_BY_IMPORT` / `NO_SETTLEMENT` / `LEGACY_NO_TRAIL` / `DRIFT`) | — |
| **Desvincular pagamento reabrindo a fatura** | **NÃO APROVADO** — apresentar como indisponível, não desenhar | — | — | — | "Para reabrir uma fatura paga por importação, desfaça a importação inteira." |
| **Desfazer um pagamento individual** (dentro de um lote) | **NÃO APROVADO** — o corte financeiro é o LOTE | — | — | — | idem acima |

### 7.3 Pendências existentes e mensagens-alvo do PR 2

- `PAGAMENTO_FATURA_SEM_CARTAO` (M8, existente) — "Confirme qual cartão este pagamento quitou".
- `cardPaymentsPendingSettlement` (**PR 2 futuro**, estado 2a) — "Pagamento vinculado ao
  cartão, mas nenhuma fatura fechou. Confira a fatura do cartão." **Sem** "nenhuma
  ação necessária" e **sem** "a fatura será marcada paga quando as compras entrarem"
  (removido — não há mecanismo aprovado). O texto não afirma motivo (parcial / a maior)
  que não está persistido.
- `drift` num lote importado (**PR 2 futuro**) — `undoImport` 409 com `blockReason`; `ImportHistoryModal`
  mostra "Não foi possível desfazer: uma parcela desta fatura mudou depois do
  pagamento. Reveja a fatura do cartão." (sem recomendar ajuste manual cego).

### 7.4 Idempotência ≠ reversibilidade
`undoImport` é **idempotente** (2ª chamada = no-op `alreadyUndone`). Isso **não**
significa que o efeito é sempre **reversível**: se uma parcela sofreu drift, o
undo responde 409 e o efeito financeiro do lote permanece. A UI não promete
"desfazer sempre funciona".

---

## 8. Divisão de implementação (parent conduz o fechamento)

> **Divisão em 2 PRs (§3.3.1) — não misturar.** PR 1 (degrau) = migração + registro
> real da liquidação (`flippedEntries` + `recordImportedLiquidations` + carimbo) +
> guards B1–B6/B9 + pre-check B2 + guarda de versão. PR 2 (feature) = `getImportDetail`
> com `requester` + `settlement{…}` + `undoImport` via ledger + ACL por participante +
> drift-check com motivos + concorrência + `cardPaymentsPendingSettlement` + UX.
> `recordImportedLiquidations` **grava** no PR 1; `prepareRevert…`/`applyRevert…` são
> **chamados** só pelo `undoImport` do PR 2 (podem ser introduzidos no PR 1 sem caller).

| peça | competência | PR |
|---|---|---|
| migration aditiva + `model ImportedInvoiceLiquidation` + 5 colunas em `Expense` + back-relations + fixture de upgrade legado + `db:check` | **backend-expert** | 1 |
| `applyPreparedSettlement` devolve `flippedEntries`; `prepareSettleInvoice` devolve `outcome`; `recordImportedLiquidations` + `INVOICE_UNDO_TRAIL_VERSION` (grava a trilha) | **backend-expert** | 1 |
| `prepareRevertImportedLiquidations` / `applyRevertImportedLiquidations` (só consumidos pelo `undoImport` via ledger) | **backend-expert** | 2 |
| carimbo no commit (`bank-account.service.ts` ramos `matchedCard` **e** `=== null`) + guarda de versão fail-closed | **backend-expert** | 1 |
| `cardPaymentsPendingSettlement` no resumo do commit | **backend-expert** | 2 |
| `getImportDetail` recebe `requester` (controller `:71` + serviço) + `settlement{…}` + revalidação na tx; `undoImport` reversão via ledger + ACL por participante + drift-check com motivos + concorrência | **backend-expert** | 2 |
| guards B3–B6 em `assertCanMutateLinkedRows` / `guardRateioParticipation`; **B9** em `hasProtectedChange` (carimbo ativo + muda `tipoDespesa`/ownership) | **backend-expert** | 1 |
| **B2**: pre-check `INVOICE_HAS_IMPORT_TRAIL` no PR 1; resolução autorizada/precedência **em validação**, receita antiga suspensa (§4). Rede `MANUAL_PAYMENT_OVERLAP` no undo somente no PR 2. | **backend-expert** | 1 (pre-check) / 2 (rede) |
| materializar specs §6.1–6.8 e vê-los VERMELHOS antes do GREEN (PrismaService real) | **backend-expert** | — |
| `InvoiceDetailPanel` (novo, aprovado), `ImportHistoryModal` (texto drift/`blockReason`), consumo de `settlement{cardId,payments[]}` e `actions[]` em `MovimentacoesSection`/`ContaAnoView`; specs §6.9 | **frontend-expert** | 2 |
| **Parecer incorporado (§3.3–§3.3.1)**: piso PR 1 preserva trilha/guards; novo HEAD compatível por revert ou fix, pipeline SHA strict. `DROP` futuro sem autorização hoje; configuração só após medição. Referência no `DEPLOY.md` da raiz pendente de integração. | **platform-sre / parent** | — |
| QA de jornada desktop + 375/390, login real + dados reais | **journey-qa** | 2 |

**Fechamento desta revisão:** documentação apenas, commit local; sem build/testes,
alteração de fontes/schema, migration aplicada, push, PR, merge ou deploy.
PR 1 continua em validação até a integração e evidências do parent; PR 2 não habilitado.
