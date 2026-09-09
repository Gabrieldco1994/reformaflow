# #569 — Undo exato de liquidação de fatura por importação de extrato (design v2)

> Branch: `design/569-invoice-undo-v2` — SÓ design + plano RED. Zero produção, zero
> migration aplicada, zero teste materializado nesta rodada.
> **Base real: `origin/main@e66e49c1`** (= o próprio merge de #686 / M8 / #573).
> O SHA de design anterior (`04c5cff6`, ramificado de `f84f982a`) NÃO continha #686;
> esta revisão foi verificada contra o código de `e66e49c1`, não contra relatórios.
> Contrato funcional D1–D4 já APROVADO pelo PO — não se repete aqui, só se implementa.
> A branch `fix/569-invoice-settlement-window` é histórica: o ledger que ela teve foi
> REMOVIDO por `484d78d6`; `flippedEntries` **não existe** no main atual.
> Contratos: `docs/visao-conta-faturas.md`, `docs/cockpit-caixa-real.md` §10,
> `docs/politica-datas-timezone.md`, `docs/estado-atual-cockpit-pessoal.md`.

---

## 0. Estado atual comprovado em `e66e49c1` (arquivo:linha)

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

### Janelas — TODAS distintas, confirmadas individualmente (D)

| papel | valor | arquivo:linha | NÃO confundir |
|---|---|---|---|
| identificação de cartão por IMPORTAÇÃO de fatura (±R$1 no total) | **60 dias** | `bank-account.service.ts:2823` `sixtyDaysBefore.setDate(getDate()-60)` | não é liquidação |
| identificação ESTRITA por valor (final explícito/único) | **±10 dias** | `bank-account.service.ts:2894` `tenDaysBefore … tenDaysAfter` (fn ~`:2882`) | não é liquidação |
| LIQUIDAÇÃO por vencimento (cartão com `closingDay`+`dueDay`) | janela de mês **{payMonth, payMonth+1}** | `card-invoice-settlement.service.ts:257` `windowMonths = new Set([payMonth, addMonthsToMonthKey(payMonth,1)])` | não é dias corridos |
| FALLBACK de liquidação por fatura importada (±R$2 no `totalAmountCents`) | **75 dias** corridos | `card-invoice-settlement.service.ts:682` `since.setDate(getDate()-75)`; `tolerance=200` `:683` | ≠ 60d de identificação |
| ranking da prévia | `rankCardCandidates` (domínio) | `bank-account.service.ts:715, 2308` (import `:68`) | telemetria de escolha, não realiza nada |

**Regra dura (D):** o design NÃO troca 60 por 75 nem "unifica" janelas. Cada teste
pina a sua. `resolveTargetDueMonth` só devolve `dueMonth` quando o valor FECHA a
fatura dentro de `invoiceMatchTolerance` (`max(R$2; 0,5%)`), senão `null`
(`card-invoice-settlement.service.ts:295-298`); pagamento parcial NÃO realiza nada.

---

## 1. Design mínimo — armazenamento e protocolo

### 1.1 Os 4 estados que o armazenamento tem de distinguir (A)

| # | estado | como é gravado | undo do LOTE |
|---|---|---|---|
| 1 | **legado sem trilha** — `PAGAMENTO_FATURA_CARTAO` criado pré-#569 | pagamento sem carimbo (`invoice_undo_state IS NULL`), zero itens | **409** fail-closed, sem backfill (D2) |
| 2 | **novo, ZERO liquidações** — cartão id., mas nenhuma fatura fechou (parcial/encargo) ou fatura já paga | carimbo `PROCESSED_NONE` no pagamento, `parcela_count = 0`, zero itens | **permitido** — não há parcela a reabrir; identidade do cartão preservada |
| 3 | **novo, conjunto COMPLETO** | carimbo `PROCESSED_SETTLED`, `parcela_count = N`, N itens ativos, `due_month`, `card_id` | reverte exatamente os N itens, atômico |
| 4 | **incompleto / inconsistente / lote MISTO** (parte nova, parte legado; ou drift) | ≥1 pagamento do lote com carimbo NULL enquanto outro tem; **ou** `count(itens ativos) ≠ parcela_count` do carimbo; **ou** drift por-item | **409**, ZERO escrita |

O distinguidor entre (1) e (2) — a contradição da v1 — é **um carimbo escrito na
MESMA transação do commit no próprio `Expense` do pagamento**, não a
presença/ausência de linhas de item. "Zero itens + carimbo `PROCESSED_NONE`" =
processado e seguro de desfazer; "zero itens + sem carimbo" = legado, bloqueado.

### 1.2 Menor solução suficiente: **carimbo no `Expense` + 1 tabela de itens**

Comparada às alternativas:

- **Só JSON no `Expense` (blob):** não indexável ⇒ impossível a **unicidade de
  reivindicação ativa por `CashFlowEntry`** (D1 exige: nunca duas liquidações
  ativas na mesma parcela). Rejeitada.
- **Duas tabelas (cabeçalho + itens):** o "cabeçalho por pagamento" duplica o
  `PAGAMENTO_FATURA_CARTAO`, que já tem `importId`, `cardLast4`, `valorTotal`,
  `dataPagamento`. Undo é tudo-ou-nada por LOTE (escopo aprovado) ⇒ não há
  agrupador intermediário que se pague. Rejeitada.
- **Escolhida:** 3 colunas de carimbo no `Expense` do pagamento + tabela
  `imported_invoice_liquidation` (1 linha por parcela virada). O carimbo dá os 4
  estados e a prova de completude O(1); a tabela dá a unicidade e o drift-check
  por parcela.

#### Carimbo — colunas aditivas em `model Expense` (só o `PAGAMENTO_FATURA_CARTAO`)

| coluna | tipo | função |
|---|---|---|
| `invoice_undo_state` | TEXT NULL | `NULL` (legado) \| `PROCESSED_NONE` \| `PROCESSED_SETTLED` |
| `invoice_undo_parcela_count` | INT NULL | N esperado de itens ativos (prova de completude — A) |
| `invoice_undo_due_month` | TEXT NULL | `YYYY-MM` alvo (observabilidade + D) |
| `invoice_undo_card_id` | TEXT NULL | id ESTÁVEL do cartão resolvido (revalidação — C; nunca `last4`) |
| `invoice_undo_trail_version` | INT NULL | versão do protocolo (E — guarda de versão) |

Vínculo com o lote: **`Expense.importId` (imutável, gravado na criação) + `tipoDespesa='PAGAMENTO_FATURA_CARTAO'`** — nunca corte por data.

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
2. `prepareSettleInvoice` passa a devolver também `outcome: 'SETTLED' | 'ALREADY_PAID' | 'PARTIAL_PAYMENT' | 'NO_MATCH'` (D — estados honestos):
   - `SETTLED` — alvo resolvido e ≥1 parcela PLANEJADO no `dueMonth`.
   - `ALREADY_PAID` — `resolveTargetDueMonth` devolveu `dueMonth` mas
     `prepareDueMonthSettlement` retornou `[]` (todas já PAGO).
   - `PARTIAL_PAYMENT` — melhor fatura achada mas `best.diff > invoiceMatchTolerance`
     (hoje `resolveTargetDueMonth` retorna `null` e some — passar a sinalizar).
   - `NO_MATCH` — nem vencimento nem `findImportByTotal` casaram.
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
     invoiceUndoCardId: matchedCard.id,
     invoiceUndoTrailVersion: INVOICE_UNDO_TRAIL_VERSION }})`.
4. Ramo `matchedCard === null` (M8 — sem identidade confiável): pagamento criado
   com `cardLast4: null`, **nenhum carimbo, nenhum item** — nunca entra no undo
   exato (já é assim por construção).
5. Resumo do commit: novo contador `cardPaymentsPendingSettlement` alimentado por
   `outcome ∈ {ALREADY_PAID, PARTIAL_PAYMENT, NO_MATCH}` com `matchedCard` truthy.
   Texto: *"N pagamento(s) vinculado(s) ao cartão sem fatura fechada — confira a
   fatura do cartão."* **Sem** "a fatura será marcada paga quando as compras
   entrarem" (F — removido; não há mecanismo aprovado).

### 2.2 `getImportDetail` — passa a receber `requester` e revalidar (C)

- Controller `bank-account.controller.ts:71` ganha `@CurrentUser() requester: RateioRequester` + `assertRateioRequester`; assinatura do serviço vira
  `getImportDetail(tenantId, projectId, accountId, importId, requester)`.
- Corte por data REMOVIDO: escopo por `importId` puro
  (`bank-account.service.ts:1305,1310`) — adotadas pré-import passam a contar
  igual ao undo.
- Envolver as leituras decisivas numa `this.prisma.$transaction` e aplicar a
  **mesma** função de revalidação que o `undoImport` (§2.3 passos 2–4), em modo
  leitura: devolve `canUndo` + `blockReason`.
- `canUndo` = `importRecord.deletedAt != null`
  **OU** ( todo pagamento do lote com `invoiceUndoState != NULL`
          **E** `invoiceUndoTrailVersion === INVOICE_UNDO_TRAIL_VERSION`
          **E** para cada um: `count(itens ativos) === invoiceUndoParcelaCount`
          **E** nenhum drift por-item ).
- Lote com `PAGAMENTO_FATURA_CARTAO` sem carimbo (legado ou misto) ⇒ `canUndo:false`,
  `blockReason: 'LEGACY_NO_TRAIL'`.
- Estados honestos expostos (D/F): por fatura tocada, `settlement: { state:
  'SETTLED_BY_IMPORT' | 'ALREADY_PAID' | 'PARTIAL' | 'NO_INVOICE_MATCH', cardId,
  dueMonth, payments: [{ paymentExpenseId, importId, parcelaCount }] }` —
  **`cardId` estável, nunca `last4`**, e **lista de pagamentos** (múltiplos
  pagamentos/importações na mesma fatura).

### 2.3 `undoImport` — reversão via ledger, dentro da `$transaction` existente (`bank-account.service.ts:1436`)

Ordem, ANTES da 1ª escrita:

1. **TOCTOU** (já existe `:1438-1449`): re-lê conta + import na tx. Mantido.
2. **Enumerar pagamentos do lote** por `importId` + `tipoDespesa` (sem data),
   `deletedAt: INCLUDE_SOFT_DELETED`.
   - Nenhum ⇒ segue undo normal (sem cartão).
   - Algum com `invoiceUndoState IS NULL` **ou** `trailVersion` desconhecida ⇒
     **409 `LEGACY_OR_MIXED`**, zero escrita (estados 1 e 4).
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
   - a compra ganhou `settledByExpenseId != null` (adoção manual posterior —
     `expense.service.ts:2065`);
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

### 2.4 Concorrência (C)

| cenário | comportamento | prova |
|---|---|---|
| **2 undos simultâneos do MESMO lote** | o 1º `$transaction` a escrever pega o write-lock do SQLite; ao chegar no passo 6 faz `bankStatementImport.update(deletedAt)` + soft-delete dos itens. O 2º, ao re-ler no passo 3 (após o lock liberar), vê `importRecord.deletedAt != null` ⇒ no-op `alreadyUndone:true`. Nunca reversão parcial. | estado do **próprio import + itens ativos** lidos DENTRO da tx sob o lock — não pré-check externo |
| **re-undo serial** | 2ª chamada: `importRecord.deletedAt != null` ⇒ `{ ok:true, alreadyUndone:true }`, zero parcelas | `bank-account.service.ts:1429` + passo 3 |
| **item soft-deletado entre as duas** | passo 3: `activeItems.length (0) !== parcela_count (N)` ⇒ 409 `INCOMPLETE_TRAIL` | recount na tx |
| **`SQLITE_BUSY` / conflito** | a 2ª tx espera o `busy_timeout`; se estourar, Prisma propaga erro → 5xx. Operação é idempotente ⇒ retry seguro. **Ação SRE (E):** confirmar `busy_timeout`/WAL no `PrismaService` cobre a contenção nova em `undoImport`. | — |

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
- Prisma schema: novo `model ImportedInvoiceLiquidation`, back-relations OPCIONAIS
  em `Expense` (`importedInvoiceLiquidationsAsPayment`, `...AsPurchase`) e
  `CashFlowEntry` (`importedInvoiceLiquidation?`), 5 campos no `model Expense`.

### 3.2 Fixture de upgrade legado + `db:check` (regra da casa)

1. Fixture = backup sanitizado OU legada estruturalmente equivalente com ≥1
   `PAGAMENTO_FATURA_CARTAO` importado pré-#569 e parcelas já PAGO, **sem**
   nenhuma linha do ledger.
2. `prisma migrate deploy` sobre a fixture ⇒ tabela e colunas criadas, **zero
   linhas**, colunas de carimbo NULL.
3. `npm run db:check` (`PRAGMA foreign_key_check`) — zero órfãos.
4. `getImportDetail` do lote legado ⇒ `canUndo:false`, `blockReason:'LEGACY_NO_TRAIL'`;
   `undoImport` ⇒ 409. (fail-closed preservado, sem backfill.)

### 3.3 Rollback — SEM `DROP TABLE` operacional depois de uso

- **Guarda de versão:** `INVOICE_UNDO_TRAIL_VERSION` (const em
  `card-invoice-settlement.service.ts`). O carimbo grava a versão; `undoImport`/
  `getImportDetail` **recusam fail-closed (409)** um carimbo com versão que não
  reconhecem. Uma versão futura incompatível não corrompe — bloqueia.
- **Impedir versão antiga de escrever incoerente:** feature-flag de ambiente
  `INVOICE_UNDO_TRAIL_ENABLED`. Se, depois de ligada em prod, a imagem for
  revertida para uma que não grava trilha, os novos `PAGAMENTO_FATURA_CARTAO`
  saem **sem carimbo** ⇒ caem no estado 1/4 ⇒ lote bloqueado (fail-closed, não
  corrupção). Reverter a IMAGEM é seguro. Reverter a MIGRATION (`DROP TABLE`)
  **destrói trilhas já gravadas** e só é aceitável se `SELECT count(*) FROM
  imported_invoice_liquidations = 0` — documentado no cabeçalho da migration como
  "só antes do primeiro uso".
- **Precisa de validação do `platform-sre` (E):**
  1. ordem **migrate antes de deploy** — a tabela/colunas têm de existir antes da
     nova imagem servir (entrypoint migrate-first já garante; confirmar).
  2. **sem quiesce** — migration puramente aditiva, sem backfill, sem lock longo.
  3. runbook de rollback = **flag off + redeploy da imagem anterior**, nunca
     `migrate resolve --rolled-back` + `DROP` com trilhas presentes.
  4. contenção de escrita nova em `undoImport` sob `busy_timeout`/WAL — confirmar
     config atual do `PrismaService`.
  5. gate de deploy stale-SHA + prova pós-deploy (regra da casa) inalterados.

---

## 4. Caminhos que modificam/assumem as parcelas liquidadas (B) — tratamento mínimo

Sem framework genérico de auditoria. Cada linha: caminho (arquivo:linha) →
tratamento → ponto concreto a mudar.

| # | caminho | o que faz às parcelas | tratamento mínimo | ponto concreto |
|---|---|---|---|---|
| B1 | `MonthlyOverviewService.undoInvoicePayment` `monthly-overview.service.ts:3423` (cockpit manual) | reverte `CashFlowEntry` PAGO→PLANEJADO por `dueMonth`/`settlesInvoiceKey` | **drift-check passo 5** pega `status !== 'PAGO'` ⇒ 409 `DRIFT`, zero escrita. Além disso: pagamento com `importId != null` já é 404 no cockpit (§16.4) — manter. | nenhuma mudança nova; teste trava a interação |
| B2 | `MonthlyOverviewService.payInvoice` `monthly-overview.service.ts:3283` (cockpit manual) | marcaria parcelas já PAGO de novo / criaria `settlesInvoiceKey` | ao tentar, as parcelas do `dueMonth` já estão PAGO ⇒ `payInvoice` legado já não as re-marca; se marcar a compra via `settledByExpenseId`, **drift-check** pega. | nenhuma mudança nova; teste trava |
| B3 | `ExpenseService.update` `expense.service.ts:1444` — PATCH da COMPRA (valor/quantidade/parcelas) | regenera `CashFlowEntry` ⇒ muda `valor`/`parcela` | **bloquear no `assertCanMutateLinkedRows`** (`expense.service.ts:1465`): se a compra tem item de ledger ATIVO e o DTO muda `valor`/`quantidade`/`quantidadeParcela`/datas ⇒ `ConflictException` "compra liquidada por pagamento importado; desfaça a importação primeiro". | +cheque em `assertCanMutateLinkedRows` |
| B4 | `ExpenseService.update` — PATCH do PAGAMENTO `{ creditCardId }` | escolhe CARTÃO, não fatura (F) | permitido, mas se `invoiceUndoState != NULL` e o `creditCardId` novo ≠ `invoiceUndoCardId` ⇒ `ConflictException` (o carimbo/itens apontam para o cartão antigo). | +cheque em `assertCanMutateLinkedRows` |
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
| **B** alterações posteriores / adoção | guard em `assertCanMutateLinkedRows` (`expense.service.ts:1465`) e `guardRateioParticipation` (`~:2014`) + drift-check de undo | B1 `monthly-overview.service.ts:3423`; B2 `:3283`; B3/B4 `expense.service.ts:1444`; B5 `:2190`; B6 `:2014`; B8 `bank-account.service.ts:1463` | `later-mutation.spec` (§6.4): um caso por caminho B1–B6/B8, cada um ⇒ bloqueio no write OU 409 no undo, zero escrita |
| **C** atomicidade / efeitos efetivos / autz / concorrência | `applyPreparedSettlement` devolve `flippedEntries`; `recordImportedLiquidations` NÃO capturado ⇒ rollback do lote (`$transaction` `:1151`); `getImportDetail` recebe `requester`; ambos revalidam na tx com ACL por participante cross-project; prova de "já desfeito" = import + itens na tx sob write-lock | `bank-account.service.ts:1151` (tx do lote), `:2497` (apply), `:1298/1416` (só `findAccount`), `card-invoice-settlement.service.ts:190` (`assertCanSettlePurchase`), `:613-628` (apply a mudar) | `atomicity.spec` (§6.3): falha forçada em `recordImportedLiquidations` ⇒ NADA persiste (import, despesas, caixa, itens); `authz.spec` (§6.5): requester sem ACL de projeto participante ⇒ 404, zero escrita; `concurrency.spec` (§6.6): 2 undos / re-undo / item removido no meio |
| **D** janelas e estados honestos | documentar 60d / ±10d / {m,m+1} / 75d / ranking individualmente; `prepareSettleInvoice` devolve `outcome`; UI reflete resultado comprovado (`ALREADY_PAID` ≠ `NO_MATCH` ≠ `PARTIAL`) | `bank-account.service.ts:2823` (60d), `:2894` (±10d); `card-invoice-settlement.service.ts:257` ({m,m+1}), `:682` (75d), `:295` (tolerância) | `windows.spec` (§6.2): cada janela pina o seu valor; `outcome` correto para: fatura já paga, nenhuma fatura, pagamento parcial |
| **E** migration / rollback | aditiva sem backfill; fixture legada + `db:check`; sem `DROP TABLE` operacional pós-uso; guarda de versão + feature-flag; lista SRE | padrão `prisma/migrations/20260904120000_add_dedupe_keys` (índice parcial à mão) | `migration-upgrade.spec` (§6.7): deploy sobre fixture legada ⇒ 0 linhas, colunas NULL, `db:check` ok, legado segue 409 |
| **F** UX sem promessas / operações implícitas | remover "fatura marcada paga quando compras entrarem"; `creditCardId` = cartão, não fatura; detalhe usa `cardId` estável + lista de pagamentos; "adicionar no contexto" mostra `dueMonth` DERIVADO por `caixaMonthForCardPurchase`; idempotência ≠ reversibilidade | texto atual do resumo `bank-account.service.ts:1240-1258`; `caixaMonthForCardPurchase` (domínio, usado em `card-invoice-settlement.service.ts:270`) | testes de contrato de resposta (§6.8): `getImportDetail.settlement` tem `cardId` (não `last4`) e `payments[]`; `canUndo`/`blockReason` corretos por estado |

---

## 6. Plano RED executável

Runner: **`PrismaService` real + banco descartável** (`scripts/test-db-env.cjs`),
NUNCA `prisma/dev.db`, NUNCA `new PrismaClient()` (Scar #616 — o `$use` tem de
rodar). Relógio fixo (`vi.setSystemTime` no domínio; no Nest, injeção de data via
param já existente) nos casos por mês. **Sem `it.todo`/`describe.skip`** — cada
`it` tem arrange/act/assert real e falha porque a produção ainda não existe.
Materialização e execução: `backend-expert`, como 1º passo do GREEN.

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
- `it('pagamento parcial na estratégia 1 (diff > invoiceMatchTolerance) → outcome PARTIAL_PAYMENT, 0 linhas, carimbo PROCESSED_NONE')`
- `it('fatura já toda paga → outcome ALREADY_PAID, 0 linhas, carimbo PROCESSED_NONE')`
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
- `it('zero parcelas alteradas com fatura JÁ paga → outcome ALREADY_PAID (não NO_MATCH)')` e
  `it('zero parcelas com nenhuma fatura compatível → outcome NO_MATCH')`.

### 6.3 `apps/api/src/bank-account/bank-account.undo-import-atomicity.spec.ts`
- `it('falha forçada em recordImportedLiquidations aborta o commit inteiro: 0 Expense, 0 CashFlowEntry, 0 BankStatementImport, 0 ImportedInvoiceLiquidation, entries seguem PLANEJADO')`
  arrange: forçar P2002 semeando uma liquidação ativa pré-existente na entry que o commit vai tocar; act: `commitImport`; assert: `rejects` + todas as contagens no baseline exato.
- `it('undoImport: falha forçada no update de uma entry no meio → rollback total, nenhuma outra entry/caixa/vínculo/import alterado')`
  (forçar erro via constraint/mocked failure no meio do laço do passo 6).
- `it('pagar-por-import → undoImport devolve getAccountView (caixaHoje, devoCartaoTotal, faturas[].pending, saidas[], comprasCartao[]) ao valor EXATO pré-import — deep-equal centavo a centavo')`.

### 6.4 `apps/api/src/bank-account/bank-account.undo-import-later-mutation.spec.ts`
Um `it` por caminho de B:
- `it('B1 undoInvoicePayment manual reverteu uma parcela do ledger antes do undo → undoImport 409 DRIFT, zero escrita')`.
- `it('B2 payInvoice manual na mesma fatura → undoImport 409 DRIFT, zero escrita')`.
- `it('B3 PATCH /expenses/:id muda valor da compra liquidada → 409 ConflictException no update; ledger intacto')`.
- `it('B4 PATCH creditCardId do pagamento carimbado para outro cartão → 409 ConflictException')`.
- `it('B5a DELETE da compra liquidada → 409 no remove; B5b DELETE do pagamento carimbado → 409')`.
- `it('B6 ratear a compra liquidada → 409 em guardRateioParticipation')`.
- `it('B8 PAGAMENTO_FATURA_CARTAO adotado na dedup (sem carimbo) → lote fica canUndo:false / undoImport 409 LEGACY_OR_MIXED')`.
- `it('drift por entry soft-deletada → 409, zero escrita')`, `it('drift por settledByExpenseId posterior → 409')`.

### 6.5 `apps/api/src/bank-account/bank-account.undo-import-authz.spec.ts`
- `it('getImportDetail agora exige requester (controller passa @CurrentUser); requester sem acesso à conta → 404')`.
- `it('undoImport: compra liquidada pertence a projeto REFORMA que o requester NÃO pode ver → 404 "Fatura não encontrada", zero escrita')`
  (cartão compartilhado entre PESSOAL e REFORMA; requester só PESSOAL).
- `it('getImportDetail: mesma revalidação — canUndo:false + blockReason quando requester não vê um participante')`.
- `it('ADMIN vê todos os participantes → canUndo:true')`.

### 6.6 `apps/api/src/bank-account/bank-account.undo-import-concurrency.spec.ts`
- `it('dois undoImport simultâneos do mesmo lote: exatamente um retorna revertedInvoiceParcelas>0, o outro alreadyUndone:true; contagem de CashFlowEntry PAGO idêntica ao baseline (nunca parcial)')`
  act: `Promise.allSettled([undoImport(), undoImport()])`.
- `it('re-undo serial → { ok:true, alreadyUndone:true }, zero parcelas revertidas de novo')`.
- `it('item do ledger soft-deletado por fora entre commit e undo → 409 INCOMPLETE_TRAIL (count != parcela_count), zero escrita')`.
- `it('prova de já-desfeito não depende de count:0 — com import.deletedAt=null mas zero itens ativos e carimbo PROCESSED_SETTLED → 409, não no-op')`.

### 6.7 `apps/api/src/prisma/migrations-invoice-undo-upgrade.spec.ts`
- `it('migrate deploy sobre fixture legada: cria imported_invoice_liquidations vazia e colunas invoice_undo_* NULL; PRAGMA foreign_key_check zero violações')`.
- `it('lote legado (PAGAMENTO_FATURA_CARTAO sem carimbo, parcelas PAGO) após migration: getImportDetail canUndo:false / undoImport 409, sem backfill')`.
- `it('carimbo com trail_version desconhecida → getImportDetail canUndo:false, undoImport 409 (guarda de versão)')`.

### 6.8 `apps/api/src/bank-account/bank-account.import-detail-contract.spec.ts`
- `it('getImportDetail.settlement identifica o cartão por cardId estável, nunca last4')`.
- `it('duas importações que pagam a MESMA fatura → settlement.payments tem 2 entradas com paymentExpenseId/importId distintos')`.
- `it('estado honesto: fatura só identificada (cartão) sem liquidação → state NO_INVOICE_MATCH, canUndo:true (undo normal), reopenedInvoices:[]')`.
- `it('idempotência ≠ reversibilidade: 2º undoImport é no-op (idempotente), mas lote com drift responde 409 (não reversível) — asserção explícita dos dois')`.

### 6.9 Frontend (materializa `frontend-expert`) — `apps/web`
- `InvoiceDetailPanel.test.tsx`: renderiza estados `SETTLED_BY_IMPORT` / `ALREADY_PAID` / `PARTIAL` / `NO_INVOICE_MATCH` / `LEGACY_NO_TRAIL` / `DRIFT` a partir do contrato tipado (não do texto renderizado); CTA vem de `actions[]` do servidor, nunca sintetizado (Scar #499).
- `ImportHistoryModal.test.tsx`: `canUndo:false` + `blockReason` ⇒ botão visível `disabled`+`aria-disabled`, ≥44px; texto de drift honesto, sem "ajuste manual" sem caminho.
- QA de jornada (desktop + 375/390) fica com `journey-qa` independente.

---

## 7. Fluxo UX atual → proposto (F)

### 7.1 Pipeline

| etapa | hoje | proposto |
|---|---|---|
| prévia identifica cartão / fatura | `prepareSettleInvoice` (`:2478`), `resolveTargetDueMonth`/`findImportByTotal` | inalterado (janelas idem) |
| commit liquida | `applyPreparedSettlement` incondicional, retorno contado do `prepared` | devolve `flippedEntries`; `+ recordImportedLiquidations` + carimbo, MESMA tx; P2002 ⇒ rollback do lote |
| commit — cartão id., fatura não fecha | grava pagamento com `cardLast4`, silencioso | grava pagamento + carimbo `PROCESSED_NONE`; resumo conta `cardPaymentsPendingSettlement`; **sem** promessa de liquidação futura |
| `getImportDetail` | sem requester, corte por data, `canUndo:false` se há pagamento de fatura | recebe requester, escopo por `importId`, revalida na tx, `canUndo` por estado real; expõe `settlement{ state, cardId, dueMonth, payments[] }` |
| `undoImport` | 409 se há `PAGAMENTO_FATURA_CARTAO` | reverte via ledger (estado 3), permite (estado 2), 409 (estados 1/4/drift/ACL), rollback total em falha |
| desfazer manual (cockpit) para pagamento importado | `undoInvoicePayment` 404 se `importId != null` | inalterado — importado só volta por `undoImport` |

### 7.2 Ações — existentes vs NÃO aprovadas

| ação | status | superfície | efeito no CAIXA | efeito na FATURA | texto |
|---|---|---|---|---|---|
| **Desfazer a importação (LOTE inteiro)** | EXISTENTE (ampliada) | `ImportHistoryModal` → `canUndo` | estorna todas as saídas do lote | reabre as faturas que o lote liquidou (via ledger) | "Remove tudo que esta importação criou e reabre as faturas que ela pagou." |
| **Desfazer pagamento manual** | EXISTENTE | `UndoInvoicePaymentDialog` (§14) | estorna o pagamento manual | reabre a fatura | inalterado |
| **Adicionar compra no contexto do cartão** | EXISTENTE (só pré-preenche) | launcher de despesa (`expense-options.ts`) com `creditCardId` + `dataCompra` sugeridos | nenhum até a fatura ser paga | entra na fatura **cujo vencimento o backend DERIVA** de `caixaMonthForCardPurchase(dataInicioParcela, closingDay, dueDay)` — preencher cartão+mês **não** basta | "Esta compra cai na fatura que vence em {mês derivado}. Não altera o caixa até a fatura ser paga." |
| **Corrigir o cartão do pagamento** (`PATCH {creditCardId}`) | EXISTENTE | detalhe do pagamento | nenhum | **escolhe o CARTÃO, não a fatura**; recálculo é só de leitura; bloqueado se conflita com carimbo (B4) | "Muda a qual cartão este pagamento pertence." (NÃO "confirma qual fatura foi quitada") |
| **Painel "Detalhe da fatura"** (leitura) | **NOVO — APROVADO** | drill da linha de fatura em `MovimentacoesSection`/`ContaAnoView` | nenhum | mostra compras da fatura + relação com pagamento(s)/importação(ões), `cardId` estável, estado honesto | — |
| **Desvincular pagamento reabrindo a fatura** | **NÃO APROVADO** — apresentar como indisponível, não desenhar | — | — | — | "Para reabrir uma fatura paga por importação, desfaça a importação inteira." |
| **Desfazer um pagamento individual** (dentro de um lote) | **NÃO APROVADO** — o corte financeiro é o LOTE | — | — | — | idem acima |

### 7.3 Pendências / próximos passos seguros

- `PAGAMENTO_FATURA_SEM_CARTAO` (M8, existente) — "Confirme qual cartão este pagamento quitou".
- `cardPaymentsPendingSettlement` (novo sinal, estado 2) — "Pagamento vinculado ao
  cartão, mas nenhuma fatura fechou. Confira a fatura do cartão." **Sem**
  "nenhuma ação necessária / a fatura será marcada paga quando as compras
  entrarem" (removido — não há mecanismo).
- `drift` num lote importado — `undoImport` 409 com `blockReason`; `ImportHistoryModal`
  mostra "Não foi possível desfazer: uma parcela desta fatura mudou depois do
  pagamento. Reveja a fatura do cartão." (sem recomendar ajuste manual cego).

### 7.4 Idempotência ≠ reversibilidade
`undoImport` é **idempotente** (2ª chamada = no-op `alreadyUndone`). Isso **não**
significa que o efeito é sempre **reversível**: se uma parcela sofreu drift, o
undo responde 409 e o efeito financeiro do lote permanece. A UI não promete
"desfazer sempre funciona".

---

## 8. Hand-off

| peça | competência |
|---|---|
| migration aditiva + `model ImportedInvoiceLiquidation` + 5 colunas em `Expense` + back-relations + fixture de upgrade legado + `db:check` | **backend-expert** |
| `applyPreparedSettlement` devolve `flippedEntries`; `prepareSettleInvoice` devolve `outcome`; `recordImportedLiquidations` / `prepareRevertImportedLiquidations` / `applyRevertImportedLiquidations` + `INVOICE_UNDO_TRAIL_VERSION` | **backend-expert** |
| carimbo no commit (`bank-account.service.ts` ramo `matchedCard`) + `cardPaymentsPendingSettlement` no resumo | **backend-expert** |
| `getImportDetail` recebe `requester` (controller `:71` + serviço) + revalidação na tx; `undoImport` reversão via ledger + ACL por participante + drift-check + concorrência | **backend-expert** |
| guards B3–B6 em `assertCanMutateLinkedRows` / `guardRateioParticipation` | **backend-expert** |
| materializar specs §6.1–6.8 e vê-los VERMELHOS antes do GREEN (PrismaService real) | **backend-expert** |
| `InvoiceDetailPanel` (novo, aprovado), `ImportHistoryModal` (texto drift/`blockReason`), consumo de `settlement{cardId,payments[]}` e `actions[]` em `MovimentacoesSection`/`ContaAnoView`; specs §6.9 | **frontend-expert** |
| ordem migrate/deploy, ausência de quiesce, runbook de rollback (flag off, nunca DROP com trilhas), `busy_timeout`/WAL para contenção de `undoImport`, gates de deploy | **platform-sre** |
| QA de jornada desktop + 375/390, login real + dados reais | **journey-qa** |

**STOP.** Sem produção, migration, testes materializados, PR ou merge nesta rodada.
