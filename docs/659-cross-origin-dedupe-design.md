# #659 — Dedupe de importação cross-origin (Tier A + Tier B)

> **Fase:** design + RED spec (este doc + specs `test:`).
> **Implementação:** `backend-expert` (server/data). Sem mudança de view.
> **Baseline:** `origin/main` `19633f12`.
> **Regras de negócio que NÃO mudam:** `docs/cockpit-caixa-real.md` §10,
> `docs/visao-conta-faturas.md` (§2 neutros, §11 Carteira, `matchPaidInvoices`,
> `settlesInvoiceKey`/`computePaidInvoiceKeys`). Dinheiro em **centavos**.
> Datas: `docs/politica-datas-timezone.md`.

---

## 1. O bug (inventário — fato verificado)

Os 3 canais de importação chamam o mesmo `makeExternalId(...)`
(`apps/api/src/credit-card/parsers/types.ts:116`):

```
bankRef ? sha256(`${seed}|${bankRef}`)
        : sha256(`${seed}|${isoDate}|${merchant.toLowerCase().trim()}|${amountCents}`[+`|${ordinal}`])
```

O **`seed`** difere por canal:

| Canal | Serviço | `seed` |
|---|---|---|
| Extrato de conta | `bank-account.service.ts` (`previewImport`/`commitImport`) | `BankAccount.id` |
| Fatura de cartão | `credit-card.service.ts` (`previewImport`/`commitImport`) | `CreditCard.id` |
| Carteira / "Foto (fatura/extrato)" | `receipt.service.ts` (`previewImport`/`commitImport`) | `` `receipts-import:${projectId}:${documentType}` `` (`documentType` ∈ `bank`,`card`) |

`ReceiptService` reusa **os mesmos parsers** (`parseBankStatementBuffers` /
`parseStatementBuffers`). Para o MESMO arquivo, `isoDate|merchant|amountCents|ordinal`
é byte-idêntico entre canais — só o `seed` muda. Logo o `external_id` exato do 2º
canal **não casa** com o do 1º → nova `Expense`/`Receipt`/`CashFlowEntry` → **dinheiro
contado 2× no Caixa consolidado**.

Dedupe hoje: 3 helpers quase idênticos `findExistingExternalIds`
(`receipt.service.ts:346`, `bank-account.service.ts:1983`, `credit-card.service.ts:1028`),
todos `$queryRaw` com `external_id IN (...)`, **tenant + project scoped** (não
account/card scoped), e enxergam soft-deletadas de propósito (`$queryRaw`, não
`findMany`).

`@@unique([tenantId, projectId, externalId])` existe em `Expense` (`schema.prisma:265`)
e `Receipt` (`:203`). `externalId` nullable, `@unique` global também em `Expense.externalId`
(`:34` — atenção: é o `@unique` de coluna solta; manter).

Único id durável de terceiro em qualquer canal: **FITID** do OFX
(`credit-card/parsers/ofx.ts:35`, `bank-account/parsers/.../ofx`). Hoje ele NÃO é
persistido — só entra no hash do `external_id` como `bankRef` e é descartado.
CSV/XLSX/PDF/foto **não têm id durável**.

`assignOrdinals` (`types.ts:146`): contador por bucket `date|merchant.lower|amount`
por arquivo, reinicia a cada import — 2 transações legítimas idênticas NO MESMO
arquivo recebem ordinal 0,1 e `external_id` distinto (correto, não colapsa).

---

## 2. Mapa do subsistema

```
upload (N buffers)
  │
  ├─ ReceiptService.parseImport ─┐
  ├─ BankAccountService          ├─→ parse{Bank,}StatementBuffers(buffers, seed, hint, fileName, pw)
  └─ CreditCardService           ┘        │
                                          ├─ parseOfx / parseCsv / parsePdf / parseXlsx / OCR
                                          │      └─ makeExternalId({ cardId: seed, date, merchant, amountCents, bankRef=FITID, ordinal })
                                          └─ mergeParseResults  → ParseResult.transactions: NormalizedTx[]
  │
  ├─ previewImport: findExistingExternalIds(tenant, project, ids) → Set  → row.duplicate / row.willImport
  └─ commitImport:  findExistingExternalIds(...) → filtra toInsert
        └─ loop: expense.create / receipt.create  (+ cashFlowEntry.create)
               + credit-card: CardInvoiceSettlementService.settleByDueMonth (liquida compras)
               + cross-project: conciliacao (link / rateio) quando decision.action='link'
```

Consumidores a jusante que **não podem** ser tocados (contrato #6): `computeCaixaConta`
(§10), `getAccountView` / `getAccountViewYearly`, `buildCardInvoiceAggregates`,
`matchPaidInvoices` / `computePaidInvoiceKeys`, `settlesInvoiceKey`, motor de rateio
(`ratearSource`), espelho (`linkedExpenseId` / `isEspelho`), `CrossProjectSettlement`.
O dedupe **curto-circuita ANTES** de qualquer `create` — exatamente como o caminho
`externalId` já faz hoje.

---

## 3. Invariantes (sempre válidas)

1. **I-DEDUPE-1** Importar arquivo X na Carteira e depois a MESMA transação via
   bank/card (e o inverso) NÃO cria dinheiro novo: `Σ CashFlowEntry.valor` e
   `Σ (Expense.valorTotal ∪ Receipt.valor)` do projeto ficam idênticos após o 2º import.
2. **I-DEDUPE-2** Duas transações legitimamente idênticas continuam DUAS. Nunca
   colapsam automaticamente. Só um humano (`decisions[]`) pode forçar skip/import.
3. **I-DEDUPE-3** Nenhuma linha é movida, vinculada, soft-deletada ou re-scoped pelo
   dedupe. Skip = "não inserir", nada mais.
4. **I-DEDUPE-4** Ambiguidade (natural-key com ≥1 candidato) é **superfície explícita**:
   `willImport:false` + anotação `possibleDuplicate` com motivo. Nunca auto-escolhe linha.
5. **I-DEDUPE-5** Dedupe é `tenantId` **E** `projectId` scoped (a chave embute os dois).
   Cross-tenant e cross-project nunca deduplicam.
6. **I-DEDUPE-6** Zero mudança em Caixa/Carteira/fatura/rateio/espelho/settlement. O
   short-circuit acontece antes de `Expense`/`Receipt`/`CashFlowEntry`/settlement.
7. **I-DEDUPE-7** Re-import do MESMO arquivo pelo MESMO canal continua idempotente
   (comportamento `externalId` atual preservado; as chaves novas são aditivas).

### Auditoria de propagação da nova dimensão (as chaves são uma NOVA dimensão do
invariante de unicidade — toda barreira precisa aprender ambas):

| # | Ponto de enforcement | Muda? |
|---|---|---|
| E1 | `receipt.service.ts` `findExistingExternalIds` → `findDedupeMatches` | ✅ retorna strong-hits (auto) + natural-hits (anotar) |
| E2 | `bank-account.service.ts` `findExistingExternalIds` | ✅ idem |
| E3 | `credit-card.service.ts` `findExistingExternalIds` | ✅ idem |
| E4 | `receipt.service.ts` `previewImport` + `commitImport` + `createImportedWalletRow` (tx interna) | ✅ |
| E5 | `bank-account.service.ts` `previewImport` + `commitImport` | ✅ |
| E6 | `credit-card.service.ts` `previewImport` + `commitImport` + `createExpenseFromTransaction` (branch estorno também) | ✅ |
| E7 | Todo `expense.create` / `receipt.create` dos 3 canais persiste `dedupeKeyStrong` + `dedupeKeyNatural` | ✅ |
| E8 | Migration: 2 colunas nullable por modelo + índice natural + UNIQUE PARCIAL na strong | ✅ |
| E9 | Handler P2002 do índice strong nos 3 loops de commit → `duplicated++`, continue | ✅ |
| E10 | `NormalizedTx` ganha `fitId?: string` (real) + `ordinal` disponível no build da chave | ✅ |

Uma barreira que aprenda a chave e outra que não → divergem e bloqueiam falso.
Todas as 10 acima entram no MESMO PR.

---

## 4. O fork central — resolução

**Decidido (Tier A/B):**

- **Tier A = auto-skip determinístico** (`duplicated++`, sem insert, sem decision):
  só para prova de "é a MESMA transação". Dois sinais, qualquer um basta:
  - **A1 — FITID** (id durável do banco). `fitId` vira campo real de `NormalizedTx`
    (plumbado de `ofx.ts`; continua alimentando `bankRef` p/ compat do `external_id`).
  - **A2 — mesmos bytes**: hash de conteúdo do(s) arquivo(s) do upload dobrado na
    assinatura da linha. Casa "Carteira-como-extrato do arquivo X" contra
    "importação de extrato do arquivo X idêntico"; **não** casa dois extratos
    diferentes. FITID-only não bastaria: CSV/PDF/XLSX (a maioria) não têm FITID, e o
    cenário do dono (mesmo PDF importado por 2 telas) é exatamente A2. **Vale o
    hash de conteúdo.**
  - Ambos gravam **uma** `dedupeKeyStrong` por linha: FITID quando presente, senão
    file-hash. Fresh import sempre tem `dedupeKeyStrong ≠ null` (file-hash sempre
    computável). `null` só em linha histórica (backfill).

- **Tier B = superfície explícita** (`willImport:false`, opt-in via `decisions[]`):
  natural-key (seed-free) que casa uma linha existente **sem** respaldo de FITID nem
  de mesmo-arquivo. É o caso "dois cafés de R$12 no mesmo dia, de dois extratos
  reais diferentes" — que **não pode** auto-skip (I-DEDUPE-2). Preview anexa
  `possibleDuplicate: { existingId, existingOrigin, existingDate, existingAmountCents, reason }`
  na linha, com `willImport:false`. Commit sem decision → `skipped++` e a linha entra
  em `possibleDuplicates[]` (auditável); commit com `decisions:[{externalId, action:'import'}]`
  → cria a linha (força); `action:'skip'` → confirma o skip. Espelha o padrão
  `warning` / `detectCardInvoiceWarning` / `decisions[]` já existente.
  - Linha Tier A **não** é forçável: `action:'import'` numa linha strong-dup é
    ignorado (auto-skip vence) — I-DEDUPE-6, o short-circuit é antes do write.

**Resumo (4-5 frases):** Tier A cobre só o que é provadamente a mesma transação —
FITID (A1) ou hash de bytes do arquivo (A2) — e faz auto-skip silencioso contado como
`duplicated`. Tier B cobre a chave natural seed-free, que também casa entre arquivos
diferentes, então nunca auto-skipa: vira anotação `possibleDuplicate` não-bloqueante
com `willImport:false`, e só um `decisions[]` explícito do usuário força import ou
confirma skip. O hash de conteúdo de arquivo vale a pena porque a maioria dos
formatos (CSV/PDF/XLSX) não tem FITID e o cenário real do dono é reimportar o mesmo
arquivo por outra tela. `dedupeKeyNatural` **não** ganha unique (linhas Tier B
legitimamente compartilham); `dedupeKeyStrong` ganha **unique parcial** como
rede da corrida.

---

## 5. Fórmulas exatas das chaves

Helper novo: `apps/api/src/credit-card/parsers/dedupe-key.ts` (barrel via
`parsers/types.ts` / `parsers/index.ts`), reusado pelos 3 canais.

```ts
const norm = (m: string) => m.toLowerCase().trim();            // idêntico ao de makeExternalId/assignOrdinals
const iso  = (d: Date)   => d.toISOString().slice(0, 10);
const h    = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

// hash dos bytes do upload — ordem-independente (merge de N buffers)
fileContentHash(buffers: Buffer[]) =
  h(buffers.map(b => createHash('sha256').update(b).digest('hex')).sort().join('|'));

dedupeKeyStrong(p) =
  p.fitId
    ? h(`dk-strong-fit-v1|${p.tenantId}|${p.projectId}|${p.fitId}`)
    : h(`dk-strong-file-v1|${p.tenantId}|${p.projectId}|${p.fileContentHash}|${iso(p.date)}|${p.amountCents}|${norm(p.merchant)}|${p.ordinal}`);
// null só quando nem fitId nem fileContentHash (linha de backfill)

dedupeKeyNatural(p) =
  h(`dk-nat-v1|${p.tenantId}|${p.projectId}|${iso(p.date)}|${p.amountCents}|${norm(p.merchant)}|${p.ordinal}`);
```

- `ordinal`: computado sobre `parsed.transactions` no tempo do import, MESMA lógica
  de `assignOrdinals` (bucket `iso(date)|norm(merchant)|amountCents`, ordem do
  arquivo). Se `assignOrdinals` ainda não estiver plugado no pipeline, o helper
  computa o próprio — a regra de bucket tem que ser **idêntica** à de `makeExternalId`
  (senão ordinal e chave divergem).
- `amountCents`: sinal preservado (o parser de extrato inverte crédito; o par
  cross-origin usa o MESMO parser, então o sinal casa nos dois lados). Casos de
  borda 0 / 1 / -1 geram chaves distintas.
- Chaves **independem** de `seed`/canal — é o ponto todo. Dado
  `(tenant, project, date, merchant, amount, ordinal[, fitId | fileContentHash])`
  idênticos, `bank`, `card` e `receipts-import` produzem a MESMA chave.

---

## 6. Shape da migration

`prisma/migrations/<ts>_add_dedupe_keys/migration.sql` (criar com
`prisma migrate dev --create-only` e editar à mão o índice parcial — Prisma não
expressa `WHERE`):

```sql
ALTER TABLE "expenses" ADD COLUMN "dedupe_key_strong"  TEXT;
ALTER TABLE "expenses" ADD COLUMN "dedupe_key_natural" TEXT;
ALTER TABLE "receipts" ADD COLUMN "dedupe_key_strong"  TEXT;
ALTER TABLE "receipts" ADD COLUMN "dedupe_key_natural" TEXT;

CREATE UNIQUE INDEX "expenses_dedupe_key_strong_key"
  ON "expenses" ("dedupe_key_strong") WHERE "dedupe_key_strong" IS NOT NULL;
CREATE UNIQUE INDEX "receipts_dedupe_key_strong_key"
  ON "receipts" ("dedupe_key_strong") WHERE "dedupe_key_strong" IS NOT NULL;

CREATE INDEX "expenses_dedupe_key_natural_idx" ON "expenses" ("dedupe_key_natural");
CREATE INDEX "receipts_dedupe_key_natural_idx" ON "receipts" ("dedupe_key_natural");
```

`schema.prisma` (ambos os modelos):

```prisma
  dedupeKeyStrong  String? @map("dedupe_key_strong")   /// #659 — unique PARCIAL definido em SQL puro na migration (Prisma não expressa WHERE); NÃO adicionar @@unique aqui (geraria unique total)
  dedupeKeyNatural String? @map("dedupe_key_natural")
  // ...
  @@index([dedupeKeyNatural])
```

Ambos os modelos JÁ têm `deletedAt` → **não** entram em `modelsWithoutSoftDelete`
(regra de ouro #3). Backup obrigatório antes de rodar
(`cp prisma/dev.db prisma/dev.db.bak-...`).

---

## 7. Backfill — contrato transacional + idempotente

Script: `apps/api/scripts/backfill-dedupe-keys.mjs` (mesmo PR).

- **Escopo:** só linhas importadas — `WHERE import_id IS NOT NULL AND external_id IS NOT NULL AND dedupe_key_natural IS NULL`, em `expenses` e `receipts`.
- **Só `dedupeKeyNatural`.** FITID e bytes de arquivo não foram persistidos →
  `dedupeKeyStrong` fica NULL na história (o índice é parcial, sem violação). Linha
  histórica ainda casa via Tier B natural na próxima importação — aceitável e
  documentado.
- **Idempotente:** recompute é determinístico; o `WHERE ... IS NULL` faz re-run /
  Ctrl-C-e-retomar serem no-op. Rodar 2× = mesmo resultado.
- **Transacional:** lotes de 500 linhas, cada lote num `$transaction` atômico.
- **Ordinal histórico:** recomputado por bucket `(tenant_id, project_id, iso(data),
  norm(merchant), amount)` ordenado por `(created_at, id)` — `merchant` vem de
  `titulo`/`fornecedor` (expense) ou `descricao` (receipt); `amount` de `valor_total`
  (expense) / `valor` (receipt).
- **CI:** um spec (`apps/api/src/import-dedupe/backfill-dedupe-keys.spec.ts`, ou
  reidratado no jest) roda o script contra `prisma/test.db` (via `test-db-env.cjs`)
  com ~6 linhas semeadas e assere: (a) popula `dedupe_key_natural` em todas; (b)
  2ª execução não altera nada e não lança P2002; (c) duas linhas de mesmo bucket
  recebem ordinais 0 e 1 (natural keys distintas).
- **Produção:** passo humano documentado — backup `cp prisma/dev.db ...` → rodar →
  conferir contagem `dedupe_key_natural IS NULL AND import_id IS NOT NULL` == 0.

---

## 8. Análise de concorrência / TOCTOU

**TOCTOU existente:** `commitImport` lê `findExistingExternalIds` no início (fora da
tx de escrita) e usa dentro do loop. Dois commits concorrentes do mesmo arquivo pelo
mesmo canal: hoje o `@@unique([tenantId, projectId, externalId])` pega o 2º INSERT
(P2002). Esse caminho **continua** funcionando.

**TOCTOU novo (cross-origin):** dois commits concorrentes do MESMO arquivo por
canais diferentes (Carteira + extrato). `external_id` difere (seed diferente) → o
`@@unique` existente **não** pega. Ambos passam o pré-check `findDedupeMatches`
(nenhum vê a linha do outro ainda) e ambos inserem.
→ **Rede:** o `UNIQUE` **parcial** em `dedupe_key_strong` (FITID ou file-hash —
idêntico entre canais). O 2º INSERT bate P2002 nesse índice.
→ **Implementação obrigatória (E9):** cada `expense.create` / `receipt.create` de
import é envolvido em try/catch; `P2002` cujo `meta.target` inclui
`dedupe_key_strong` (ou `external_id`) ⇒ `duplicated++`, `continue`. **Não** confiar
só no pré-check. O `receipt.createImportedWalletRow` já relê `findExisting` dentro de
um `$transaction` — estender para reler `dedupeKeyStrong` também, e ainda assim o
catch de P2002 é o guard real.

**Tier B e corrida:** SEM constraint por design. Dois arquivos diferentes com um
café idêntico, importados concorrentemente: ambos podem inserir. Aceitável — elas
PODEM ser duas transações reais; e o próximo preview de qualquer um dos canais vai
anexar `possibleDuplicate` nas (agora) duas linhas. Não serializamos Tier B.

**Multi-processo:** o `UNIQUE` parcial é de banco (SQLite, arquivo único) → vale
entre processos/workers, ao contrário do guard 409 de cartão/conta (§15.4 do
visao-conta) que é intra-processo. Aqui a rede é robusta.

---

## 9. Lista de mudanças de produção (para `backend-expert`)

**Domínio / parsers**
1. `apps/api/src/credit-card/parsers/types.ts` — `NormalizedTx.fitId?: string`;
   re-export do helper.
2. `apps/api/src/credit-card/parsers/dedupe-key.ts` **(novo)** — `fileContentHash`,
   `dedupeKeyStrong`, `dedupeKeyNatural`, `computeImportOrdinals` (se necessário).
3. `apps/api/src/credit-card/parsers/ofx.ts` e `apps/api/src/bank-account/parsers/*ofx*`
   — setar `fitId` no `NormalizedTx` (mantendo `bankRef`).
4. `apps/api/src/credit-card/parsers/index.ts` + `bank-account/parsers/index.ts` —
   propagar `fileContentHash` (dos `buffers`) para o `ParseResult` ou devolver junto.

**Schema / migration / backfill**
5. `prisma/schema.prisma` — 4 colunas + 2 `@@index([dedupeKeyNatural])`.
6. `prisma/migrations/<ts>_add_dedupe_keys/migration.sql` — DDL do §6 (índice parcial à mão).
7. `apps/api/scripts/backfill-dedupe-keys.mjs` **(novo)** — §7.

**Serviços (E1–E9)**
8. `apps/api/src/receipt/receipt.service.ts` — `findDedupeMatches` (substitui/entende
   `findExistingExternalIds`); `previewImport` anexa `possibleDuplicate` + `willImport`;
   `commitImport` conta `duplicated` (strong) vs `possibleDuplicates[]`/`skipped`
   (natural sem decision `import`); persiste as 2 chaves em `createImportedWalletRow`
   e `createImportedWalletReceipt`; catch P2002.
9. `apps/api/src/bank-account/bank-account.service.ts` — idem em `previewImport` /
   `commitImport` / inserts de `preparedRows` / branch de estorno/recebimento.
10. `apps/api/src/credit-card/credit-card.service.ts` — idem em `previewImport` /
    `commitImport` / `createExpenseFromTransaction` (inclui branch `amountCents < 0`).
11. DTOs de decision: `receipt/dto/import-receipt.dto.ts`,
    `bank-account/dto/*`, `credit-card/dto/*` — aceitar `action: 'import'` (força
    linha Tier B). Constante `RECEIPT_IMPORT_ACTION_IMPORT` etc.
12. Tipos de retorno de preview/commit dos 3 canais — campo
    `possibleDuplicates: { externalId, existingId, existingOrigin, existingDate, existingAmountCents, reason }[]`
    e, na linha de preview, `possibleDuplicate?: {...}`.

**Fora de escopo (não tocar):** qualquer coisa em `monthly-overview.service.ts`,
`conciliacao.service.ts` (motor), `card-invoice-settlement.service.ts`, motor de
rateio, `derive.ts`.

---

## 10. Hand-off

- **`backend-expert`** — tudo da §9 (parsers, schema/migration/backfill, os 3
  serviços de importação, DTOs). RED specs em §11.
- **`frontend-expert`** — **fora deste PR.** Consumo do `possibleDuplicate` /
  `possibleDuplicates[]` na UI de preview de importação (chip "possível duplicata"
  + toggle forçar import) é um follow-up separado; hoje o back só precisa emitir o
  contrato tipado. Nenhuma mudança de view neste PR.

## 11. RED specs (materializadas pelo implementer)

- `apps/api/src/import-dedupe/cross-origin-dedupe.spec.ts` — integração, `PrismaService`
  real + `test-db-env.cjs`. Cobre contrato #1–#9.
- `apps/api/src/credit-card/parsers/dedupe-key.spec.ts` — unidade dos helpers de chave.
- (implementer) `apps/api/src/import-dedupe/backfill-dedupe-keys.spec.ts` — idempotência do backfill (§7).

Rodar sempre com `TZ=UTC` (regra de ouro #22): `cd apps/api && TZ=UTC npx jest import-dedupe dedupe-key`.
