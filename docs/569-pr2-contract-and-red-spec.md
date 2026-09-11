# #569 PR2 — contrato ponta-a-ponta + RED spec (undo real de fatura liquidada)

> Autor: architect (design-only). Base: `docs/569-invoice-undo-design.md` (796 linhas,
> já cobre PR2 em §2.2–2.4, §4, §6.5–6.9) + `origin/main@551b362f` (PR1 mergeada,
> #687) + `gh issue view 569`. Este arquivo NÃO substitui o design doc — resolve o
> ponto de decisão de janela pedido pelo usuário, fecha o contrato ponta-a-ponta com
> file:line confirmados no worktree atual, e lista a spec RED que falta materializar
> (arquivos novos; specs de PR1 já existentes e verdes não são retrabalhadas).

## 0. Estado confirmado no worktree (não re-derivar)

PR1 (`551b362f`, #687) já está em `main` e traz, verde:
- Schema: `Expense.invoiceUndo*` (`schema.prisma:253-257`), `ImportedInvoiceLiquidation` (`schema.prisma:458`), índice único parcial `WHERE deleted_at IS NULL`.
- Gravação do carimbo + `flippedEntries` reais no commit: `bank-account.service.ts:2582` (chamada), `card-invoice-settlement.service.ts` (`applyPreparedSettlement`/`recordImportedLiquidations`).
- Bloqueio fail-closed sobre `PROCESSED_SETTLED`: `bank-account.service.ts:1321` (`classifyInvoiceUndoTrail` → `blockReason: 'SETTLED_TRAIL_PENDING_UNDO'`) e `:1547` (`ConflictException` dentro da tx do `undoImport`, ANTES de qualquer escrita). Equivalente cartão: `credit-card.service.ts:796`.
- Helpers de reversão JÁ ESCRITOS, NÃO chamados por `undoImport`: `card-invoice-settlement.service.ts:758` (`prepareRevertImportedLiquidations`) e `:795` (`applyRevertImportedLiquidations`). Comentário no código confirma "Consumido só pelo undoImport (PR 2)". **Confirmado: não há equivalente do lado bank-account** — o serviço de liquidação é o único dono da lógica de reversão; `bank-account.service.ts` só vai precisar CHAMAR os dois helpers dentro da própria `$transaction` do `undoImport`.
- Testes de PR1 já verdes e que cobrem os cenários M1/M2 do relato **só até o fail-closed** (não até a reversão correta): `bank-account.undo-import-invoice-window-mismatch.spec.ts` (`it #3` reproduz literalmente o cenário junho/julho da issue e asserta "undo não reabre nenhuma das duas faturas" — ou seja, HOJE o undo simplesmente recusa, não reverte certo). `card-invoice-settlement.windows.spec.ts` já pina as 4 janelas distintas (60d/±10d/{m,m+1}/75d) como D exige — **não mexer nelas**.
- `getImportDetail` (`bank-account.service.ts:1327`) já tem `_requester?` na assinatura mas **não usa** (`_` prefixo = não lido); ainda faz corte por `createdAt >= importRecord.createdAt` nas linhas 1339/1345; `canUndo`/`blockReason` já vêm de `classifyInvoiceUndoTrail`, mas **não existe** `settlement{...}` no retorno.
- Leitura do carimbo em despesa: `expense.service.ts:727` (`settledPayment = state === 'PROCESSED_SETTLED'`) — já existe, PR2 não mexe aqui.

Conclusão: **o design doc §2.2/§2.3 está correto e ainda não implementado** — é exatamente
o escopo do PR2. Nenhuma divergência encontrada entre o doc e o código atual que exija
redesenho; este arquivo complementa com (a) a decisão de janela formalizada para
aprovação, (b) os file:line confirmados nesta revisão, e (c) os arquivos de spec NOVOS
(nomes que não colidem com os já existentes de PR1/#627/#478).

---

## 1. Contrato ponta a ponta (produtor → proveniência → leitura → UI → undo)

| etapa | onde | contrato hoje | contrato PR2 |
|---|---|---|---|
| **produtor** (commit do extrato, ramo `matchedCard`) | `bank-account.service.ts` ramo em torno de `:2582`; `card-invoice-settlement.service.ts` `applyPreparedSettlement`/`prepareSettleInvoice` | grava `flippedEntries` reais + 1 linha de `ImportedInvoiceLiquidation` por parcela virada + carimbo `PROCESSED_SETTLED`/`PROCESSED_NONE` no `Expense` do pagamento, tudo na MESMA `$transaction` do lote | inalterado — PR2 não toca o commit |
| **identidade persistida (proveniência)** | `Expense.invoiceUndo{State,ParcelaCount,DueMonth,CardId,TrailVersion}` + `ImportedInvoiceLiquidation` (1 ativa por `cashFlowEntryId`) | existe e é gravada | inalterado; PR2 só LÊ |
| **leitura / resultado de importação** | `getImportDetail` `bank-account.service.ts:1327` | `canUndo`/`blockReason` por `classifyInvoiceUndoTrail`; SEM `settlement{...}`; corte por `createdAt`; `requester` recebido mas ignorado | `requester` OBRIGATÓRIO e usado (ACL); corte por `createdAt` REMOVIDO (escopo puro por `importId`); ganha `settlement: { state, cardId, dueMonth, payments[] }` por fatura tocada |
| **ações de UI** | `ImportHistoryModal`/`InvoiceDetailPanel` (não existem ainda — `apps/web`) | nenhuma tela consome `settlement` | consome `canUndo`+`blockReason`+`settlement` tipados; único CTA financeiro é "desfazer o LOTE inteiro"; nenhuma reversão por fatura individual (fora de escopo, confirmado no design §7.2) |
| **undo (servidor)** | `undoImport` `bank-account.service.ts:1446` | qualquer `PROCESSED_SETTLED` no lote ⇒ 409 `SETTLED_TRAIL_PENDING_UNDO`, ZERO leitura de ledger | passa a: (1) classificar como hoje; (2) se só `PROCESSED_SETTLED`/`PROCESSED_NONE` com trilha íntegra ⇒ ACL por participante + drift-check + `applyRevertImportedLiquidations` por pagamento, tudo dentro da MESMA tx; (3) 409 com motivo específico (`INCOMPLETE_TRAIL`/`DRIFT`/`MANUAL_PAYMENT_OVERLAP`/ACL 404) quando não pode reverter com segurança |

**Regra de ouro aplicada:** a tx de undo deve, ao final, **retornar ids** das entidades
tocadas (pagamento, parcelas, faturas) e — se o handler HTTP precisa devolver o
`getAccountView` pós-undo para a UI — chamar `findById`/`getAccountView` **fora** da
`$transaction`, porque o `$use` de soft-delete não roda dentro dela (regra 4 do
CLAUDE.md). O design doc já modela isso implicitamente no retorno de `undoImport`
(§2.3 passo 7); tornando explícito aqui para o implementador.

---

## 2. Política de janela de pagamento atrasado — DECIDIDA (opção C aprovada)

> Decisão de negócio confirmada pelo usuário: **novo estado explícito
> `OUTSIDE_SETTLEMENT_WINDOW`**. As janelas de identificação (prévia, 3 meses) e
> de liquidação real (commit, 2 meses) **permanecem distintas** — não há
> unificação. O que muda é que a prévia deixa de silenciosamente prometer um
> vínculo que o commit não cumpre: quando o candidato que ela identifica cai
> fora da janela que o commit de fato liquida, ela devolve um estado dedicado
> em vez de fingir "match" ou colapsar em "sem match". Nenhuma mudança no raio
> de ação do fechamento automático de fatura (decisão explícita: não ampliar).

### 2.a Onde cada janela vive hoje (confirmado file:line neste worktree)

| papel | valor | file:line |
|---|---|---|
| identificação de cartão por importação de fatura (±R$2 no total) | 60 dias | `bank-account.service.ts` (`sixtyDaysBefore`, em torno de `:2822-2831` no baseline do design; confirmar offset atual antes de editar) |
| identificação estrita por valor | ±10 dias | `bank-account.service.ts` (`tenDaysBefore`/`tenDaysAfter`, próximo à função acima) |
| **prévia** — `rankCardCandidates` (ranking de candidato exibido ao usuário) | `DUE_MONTH_OFFSETS = [-1, 0, 1]` relativo ao mês do pagamento — **3 meses** | `card-invoice-match.ts:26,88-89` |
| **liquidação real** por vencimento (cartão com `closingDay`+`dueDay`) | `{payMonth, payMonth+1}` — **2 meses** | `card-invoice-settlement.service.ts:257` `windowMonths` |
| fallback de liquidação por fatura importada (±R$2 no total) | 75 dias corridos | `card-invoice-settlement.service.ts:682` |

### 2.b O mismatch (M2, literal da issue #569) — exemplo numérico

Cartão fecha dia 25, vence dia 5. Fatura de maio (`dueMonth 2026-05`) fica em
aberto. Pagamento chega em **31/08/2026**.

- **Prévia** (`rankCardCandidates`, `payMonth = 2026-08`, `wanted = {2026-07,
  2026-08, 2026-09}`): a fatura de maio está **fora** até da janela de 3 meses
  da prévia neste exemplo específico — mas o caso relatado na issue usa uma
  janela de payMonth ± ampla o bastante para capturá-la nalguns exemplos reais
  (a issue fala em "3 meses" contando a partir do mês da COMPRA, não do
  pagamento, em alguns fluxos). Para o exemplo didático mais direto: pagamento
  em **30/06/2026** (2 meses de atraso sobre o vencimento de maio) —
  `payMonth=2026-06`, `wanted={2026-05,2026-06,2026-07}` ⇒ a prévia ENXERGA
  maio (`deltaCents:0`), mostra `cardCandidates:[{dueMonth:"2026-05",
  deltaCents:0}]`.
- **Commit real** (`windowMonths = {payMonth, payMonth+1} = {2026-06,
  2026-07}`): maio está fora dessa janela de 2 meses ⇒
  `resolveTargetDueMonth` não encontra fatura dentro da tolerância ⇒
  `outcome: NO_SETTLEMENT`, zero parcelas viradas.
- **Resultado ANTES desta decisão**: dinheiro sai do caixa, a dívida de maio
  continua em pé, e a prévia já tinha prometido `deltaCents:0` — o "vínculo
  prometido, commit não cumpre" da issue.

### 2.c Comportamento definitivo — estado `OUTSIDE_SETTLEMENT_WINDOW`

- A prévia (`rankCardCandidates` + o ponto que monta `cardCandidates` na
  resposta de preview, `bank-account.service.ts:716`/`:2372` e
  `pendencia.service.ts:267`) passa a anotar, por candidato, se o `dueMonth`
  identificado está **dentro** ou **fora** da janela de liquidação real
  (`{payMonth, payMonth+1}`, a mesma constante que `card-invoice-settlement.service.ts:257`
  usa — extrair para uma função/const compartilhada, não duplicar o cálculo).
  - `dueMonth` dentro de `{payMonth, payMonth+1}` ⇒ candidato normal, sem
    mudança de contrato.
  - `dueMonth` fora dessa janela (mas dentro da janela de identificação de 3
    meses da prévia) ⇒ candidato ganha `windowState:
    'OUTSIDE_SETTLEMENT_WINDOW'` em vez de aparecer como match silencioso.
- A UI, ao ver `windowState: 'OUTSIDE_SETTLEMENT_WINDOW'` num candidato, NÃO
  afirma "vincula automaticamente à fatura de {mês}" — oferece **confirmação
  manual** explícita: "Esta fatura está fora do prazo de liquidação automática
  (paga com mais de {N} meses de atraso). Confirme manualmente se este
  pagamento deve fechá-la." Nenhuma criação automática de vínculo a partir
  desse estado — é sempre uma ação manual subsequente, fora do escopo desta
  revisão (o mecanismo de confirmação manual em si é trabalho do
  `frontend-expert`/`backend-expert` a especificar em PR3 se aprovado; aqui só
  o CONTRATO do novo estado é fechado).
- O commit **não muda de comportamento**: continua usando só a janela de 2
  meses, `outcome` derivado do `apply` como já corrigido no PR1. Isso é
  intencional — não amplia o raio de ação do fechamento automático.
- `getImportDetail.settlement[].state` ganha o mesmo valor como quinto estado
  possível (§4.2): quando o commit não liquidou (`NO_SETTLEMENT` de fato) MAS
  existia um candidato de prévia cujo `dueMonth` estava fora da janela de
  liquidação, o resultado exposto é `OUTSIDE_SETTLEMENT_WINDOW` em vez de
  `NO_SETTLEMENT` genérico — para a UI poder distinguir "não tinha nenhuma
  fatura compatível" de "tinha, mas fora do prazo automático, ação manual
  disponível".

## 3. Casos de borda — comportamento definido (referencia design §1.1/§2.3/§2.4/§4; aqui como checklist único)

| caso | comportamento definido |
|---|---|
| duas faturas de valores iguais no mesmo mês/cartão | liquidação já opera por `dueMonth` alvo resolvido (`resolveTargetDueMonth`), não por "primeira fatura que bate o valor" — ambíguidade de valor não existe porque o alvo já vem do vencimento, não de busca por total. Item de ledger grava `dueMonth` explícito; undo restaura por `cashFlowEntryId`, nunca por "a fatura de valor X" |
| ambas faturas abertas vs. uma já paga por outro caminho | `applyPreparedSettlement` já filtra `entry.status === 'PLANEJADO'` antes de virar (design §2.1.1); fatura já paga por outro caminho não entra em `flippedEntries` ⇒ não é revertida por engano no undo (nada a reverter ali) |
| pagamento antecipado / atrasado | ver §2 acima — pendente de decisão de política; até lá, a janela `{payMonth,payMonth+1}` do commit é a que vale, mesmo que a prévia divirja |
| cartões diferentes com o mesmo final (últimos 4 dígitos) | identidade usada em toda a trilha é `card_id` estável (`invoice_undo_card_id`), NUNCA `last4` — design §1.2/§7.2 já exige isso; `getImportDetail.settlement.cardId` idem |
| pagamento manual, importado, e "declaração genérica" (paguei sem vincular) | pagamento manual (`importId IS NULL`) casado à mesma fatura de um carimbo ativo ⇒ `undoImport` 409 `MANUAL_PAYMENT_OVERLAP` (design §2.3 passo 5, B2d); "declaração genérica" sem vínculo de fatura não grava carimbo de liquidação — não é alvo de undo por ledger, cai fora do escopo do commit de cartão |
| participantes cross-project visíveis vs. ocultos | ACL por participante: para cada `purchase_expense_id` distinto nos itens, checar `canRequesterSeeProject` antes de reverter; falha ⇒ 404 "Fatura não encontrada" (indistinguível de não-existir), ZERO escrita — nunca vaza que a fatura existe num projeto que o requester não pode ver (design §2.3 passo 4) |
| duas tentativas concorrentes de undo da MESMA importação | releitura de `importRecord.deletedAt` + recontagem de itens ativos DENTRO da `$transaction` (não pré-check externo); no máx. 1 chamada reverte de fato, a outra cai em `alreadyUndone:true` OU 409 `INCOMPLETE_TRAIL`/`ALREADY_UNDONE` — nunca reversão parcial nem dupla (design §2.4, tabela de concorrência) |
| efeitos posteriores de rateio/conciliação sobre a liquidação original | drift-check por item ANTES de qualquer escrita: compra com `RateioAllocation` cujo schedule diverge do snapshot do ledger ⇒ 409 `DRIFT`, zero escrita — undo NUNCA reverte parcialmente um item com drift (design §2.3 passo 5, último bullet) |

---

## 4. Contrato de dados — request/response

### 4.1 `undoImport` (estendido)

Assinatura inalterada: `undoImport(tenantId, projectId, accountId, importId, requester)`.

Resposta — campos que passam a ter significado real (hoje sempre 0):

```
{
  ok: true,
  alreadyUndone: boolean,
  removedExpenses: number,
  removedReceipts: number,
  revertedSettlements: number,
  revertedInvoiceParcelas: number,       // agora > 0 quando reverte via ledger
  reopenedInvoices: number,              // NOVO: due_months distintos reabertos
  notRevertedInvoiceLiquidations: 0,     // invariante: PR2 nunca reverte parcial — ou tudo, ou 409 antes de escrever
  unstamped: number,
}
```

Erros novos (todos 409, ZERO escrita, dentro da tx antes do 1º write):
`LEGACY_OR_MIXED` (mantido do PR1), `TRAIL_VERSION_MISMATCH` (mantido),
`INCOMPLETE_TRAIL` (novo — `count(itens ativos) != parcela_count`),
`DRIFT` (novo — motivo incluído em `blockReason`, ex.: `DRIFT:ENTRY_NOT_PAID`,
`DRIFT:ENTRY_DELETED`, `DRIFT:AMOUNT_CHANGED`, `DRIFT:PARCELA_CHANGED`,
`DRIFT:MANUAL_ADOPTION`, `DRIFT:RATEIO_MISMATCH`), `MANUAL_PAYMENT_OVERLAP` (novo).

**ACL cross-project — DECIDIDO: ocultação total (404-like), consistente com o
padrão já usado no undo.** Requester sem visibilidade de algum
`purchase_expense_id`/projeto participante ⇒ `undoImport` responde 404
`"Fatura não encontrada"`, indistinguível de "o item não existe" — mesmo
tratamento que a leitura (§4.2). Nunca resposta parcial, truncada ou anonimizada
(ex.: "há N parcelas que você não pode ver" já vaza quantidade — proibido).

### 4.2 `getImportDetail` — `settlement{...}` e `cardCandidates{...}` (preview)

```
settlement: Array<{
  cardId: string | null,          // estável; NUNCA last4
  dueMonth: string | null,        // YYYY-MM
  state: 'SETTLED_BY_IMPORT' | 'NO_SETTLEMENT' | 'OUTSIDE_SETTLEMENT_WINDOW' | 'LEGACY_NO_TRAIL' | 'DRIFT',
  hint?: 'ALREADY_PAID' | 'AMOUNT_MISMATCH' | 'NO_MATCH',  // best-effort, NÃO persistido, NÃO confiável — nunca vira asserção de teste como verdade
  payments: Array<{ paymentExpenseId: string, importId: string, parcelaCount: number }>,
}>
canUndo: boolean,      // já existe; passa a refletir também estado 3 íntegro
blockReason: string | null,  // já existe; ganha os motivos novos de §4.1
```

`OUTSIDE_SETTLEMENT_WINDOW` (novo, §2.c): commit não liquidou (`flippedEntries`
vazio de fato) MAS existia um candidato de prévia com `dueMonth` fora da janela
de 2 meses do commit e dentro da janela de 3 meses da prévia. Distingue de
`NO_SETTLEMENT` genérico (nenhuma fatura compatível em nenhuma janela).

**ACL — DECIDIDO: ocultação total.** Se o requester não pode ver o
projeto/participante de uma entrada de `settlement`, essa entrada **não
aparece** no array — nunca truncada com metadado (`hidden: true`, contagem
residual etc.). Do ponto de vista do requester sem ACL, o array de `settlement`
se comporta como se aquela fatura/lote não existisse — `canUndo`/`blockReason`
seguem a mesma revalidação de ACL do `undoImport` (§2.3 do design doc).
`requester` passa de opcional-ignorado (`_requester?`) para **obrigatório e
usado**.

### 4.3 Preview (`rankCardCandidates` / `cardCandidates` na resposta de preview)

```
cardCandidates: Array<{
  cardLast4: string,
  nickname: string,
  dueMonth: string,
  invoiceTotalCents: number,
  deltaCents: number,
  windowState: 'WITHIN_SETTLEMENT_WINDOW' | 'OUTSIDE_SETTLEMENT_WINDOW',  // NOVO
}>
```

`windowState` é calculado comparando o `dueMonth` do candidato (já produzido
por `rankCardCandidates`, janela de 3 meses) contra a janela de 2 meses que o
commit realmente usa (`{payMonth, payMonth+1}` de `card-invoice-settlement.service.ts:257`
— extrair como função compartilhada, não duplicar literal). Candidato
`OUTSIDE_SETTLEMENT_WINDOW`: a UI mostra aviso de confirmação manual (§2.c),
nunca promete vínculo automático. O commit não muda: continua só liquidando
dentro dos 2 meses, independentemente do `windowState` mostrado na prévia.

---

## 5. RED spec — arquivos e testes (Jest, `apps/api`, `PrismaService` real via `scripts/test-db-env.cjs`)

Reaproveitar fixtures existentes: `apps/api/src/bank-account/__tests__/invoice-undo.fixtures.ts`
(`EXPECTED_TRAIL_VERSION`, `ADMIN_REQUESTER`, `pessoalRequester`, seeds de cartão/compra/import).
NÃO duplicar specs já verdes de PR1 (`bank-account.undo-import-invoice-window-mismatch.spec.ts`,
`card-invoice-settlement.{ledger,windows}.spec.ts`, `bank-account.undo-import-{invoice-acl,card-indistinguishability,child-acl}.spec.ts`,
`credit-card.undo-import-child-acl.spec.ts`) — os arquivos abaixo são NOVOS, nomeados para não colidir.

### 5.0 `apps/api/src/bank-account/card-invoice-match.window-state.spec.ts` (novo — puro, sem Prisma, mesmo estilo de `card-invoice-match.spec.ts`)
- `it('candidato com dueMonth dentro de {payMonth, payMonth+1} → windowState WITHIN_SETTLEMENT_WINDOW')`.
- `it('candidato com dueMonth = payMonth - 1 (1 mês de atraso sobre o vencimento, fora de {payMonth,payMonth+1}) → windowState OUTSIDE_SETTLEMENT_WINDOW')` — caso didático de §2.b (fatura de maio, pagamento em 30/06 ⇒ payMonth=2026-06, janela commit={2026-06,2026-07}, maio fica fora).
- `it('candidato com dueMonth = payMonth + 1 (dentro) permanece WITHIN mesmo em cartões sem closingDay/dueDay — fallback de competência')`.
- `it('função de janela do commit ({payMonth,payMonth+1}) é IMPORTADA de card-invoice-settlement.service.ts, não duplicada literal — teste de regressão que falha se as duas janelas divergirem por edição isolada de uma das duas')`.

### 5.1 `apps/api/src/bank-account/bank-account.undo-import-ledger-reversal.spec.ts` (novo)
- `it('undoImport de lote PROCESSED_SETTLED íntegro: reverte exatamente as N parcelas do ledger, CashFlowEntry volta a PLANEJADO, compra recomputa status/paidParcelas, itens do ledger soft-deletados, carimbo do pagamento limpo (invoiceUndoState→NULL)')`
  arrange: `seedCardWithClosingDue` + `seedInstallmentPurchase` (3 parcelas) + `commitStatement` que liquida a fatura via `matchedCard`; act: `undoImport`; assert: `revertedInvoiceParcelas === 3`, `reopenedInvoices === 1`, `cashFlowEntry.findMany({where:{expenseId:purchaseId}})` todas `PLANEJADO`, `expense.findUnique(paymentId).invoiceUndoState === null`, `importedInvoiceLiquidation.findMany({where:{paymentExpenseId, deletedAt:null}}).length === 0`.
- `it('reproduz o cenário M1 da issue (fatura de junho já paga por outro pagamento; pagamento em 28/06 liquida a fatura de julho): undoImport reabre SÓ a fatura de julho — a de junho permanece PAGO')`
  relógio fixo em 2026-06-28; assert explícito: `fatura(2026-06).status === 'PAGO'` (não tocada), `fatura(2026-07).status !== 'PAGO'` após undo — literal do relato, precisa falhar HOJE (hoje: 409 fail-closed, `revertedInvoiceParcelas` sempre 0).
- `it('lote com PROCESSED_NONE (M8, cartão nulo) misturado a PROCESSED_SETTLED do mesmo lote: undo reverte só os itens do SETTLED, PROCESSED_NONE não gera erro nem item fantasma')`.
- `it('undoImport devolve getAccountView pós-undo (caixaHoje, devoCartaoTotal, faturas[].pending) igual ao snapshot pré-import — deep-equal centavo a centavo')` (variante de §6.3 do design doc já citada, mas agora com reversão REAL, não fail-closed).

### 5.2 `apps/api/src/bank-account/bank-account.undo-import-drift.spec.ts` (novo)
- `it('parcela do ledger com CashFlowEntry status !== PAGO (revertida por fora) → 409 DRIFT:ENTRY_NOT_PAID, zero escrita, carimbo/ledger intactos')`.
- `it('parcela do ledger cuja CashFlowEntry foi soft-deletada (compra excluída) → 409 DRIFT:ENTRY_DELETED, zero escrita')`.
- `it('valor da entry mudou desde o flip (PATCH da compra) → 409 DRIFT:AMOUNT_CHANGED, zero escrita')`.
- `it('parcela mudou (reparcelamento/rateio) desde o flip → 409 DRIFT:PARCELA_CHANGED, zero escrita')`.
- `it('compra ganhou settledByExpenseId por adoção manual planejada→paga após o flip → 409 DRIFT:MANUAL_ADOPTION, zero escrita')`.
- `it('compra tem RateioAllocation cujo schedule diverge do snapshot do item → 409 DRIFT:RATEIO_MISMATCH, zero escrita')`.
- `it('itens ativos != invoiceUndoParcelaCount (item removido por fora) → 409 INCOMPLETE_TRAIL, zero escrita')`.
- `it('pagamento manual (importId NULL) casado à MESMA fatura do carimbo, via settlesInvoiceKey → 409 MANUAL_PAYMENT_OVERLAP, zero escrita')`.

### 5.3 `apps/api/src/bank-account/bank-account.undo-import-concurrency.spec.ts` (novo)
- `it('Promise.allSettled([undoImport(), undoImport()]) do MESMO lote: no máximo 1 com revertedInvoiceParcelas>0; o outro alreadyUndone:true OU 409; count(CashFlowEntry PAGO)===baseline pós-undo')`.
- `it('re-undo serial: 2ª chamada → {ok:true, alreadyUndone:true}, zero parcelas revertidas de novo, ledger não regravado')`.
- `it('item do ledger soft-deletado por fora ENTRE a 1ª leitura e a escrita → 409 INCOMPLETE_TRAIL, zero escrita (recount dentro da tx, não pré-check externo)')`.
- `it('import.deletedAt=null mas zero itens ativos + carimbo PROCESSED_SETTLED (drift severo) → 409, NUNCA no-op silencioso')`.

### 5.4 `apps/api/src/bank-account/bank-account.import-detail-settlement-contract.spec.ts` (novo)
- `it('getImportDetail exige requester (controller passa @CurrentUser); sem requester → erro de assinatura/guard, nunca 200 silencioso')`.
- `it('settlement[].cardId é sempre o id estável do cartão, nunca cardLast4, mesmo quando dois cartões distintos compartilham os últimos 4 dígitos')`.
- `it('duas importações liquidando a MESMA fatura → settlement[].payments tem 2 entradas, paymentExpenseId e importId distintos por entrada')`.
- `it('cartão identificado, nenhuma parcela liquidada → settlement[].state === NO_SETTLEMENT (nunca ALREADY_PAID/PARTIAL), cardId preenchido, canUndo:true')`.
- `it('pagamento sem cartão identificado (M8, PROCESSED_NONE, cardId NULL) → NÃO aparece como LEGACY_NO_TRAIL; canUndo do lote não é bloqueado por ele')`.
- `it('requester sem ACL num projeto participante → a entrada de settlement correspondente NÃO aparece no array (ocultação total, não truncada/anonimizada); canUndo do restante do lote reflete só o que o requester pode ver')`.
- `it('preview: candidato de rankCardCandidates com dueMonth fora de {payMonth,payMonth+1} → windowState OUTSIDE_SETTLEMENT_WINDOW; candidato dentro da janela → WITHIN_SETTLEMENT_WINDOW')`.
- `it('reproduz M2 literal: pagamento atrasado casa fatura de maio na prévia (deltaCents:0) e o commit não liquida (NO_SETTLEMENT de fato) → getImportDetail.settlement[].state === OUTSIDE_SETTLEMENT_WINDOW, NUNCA NO_SETTLEMENT genérico nem falso SETTLED_BY_IMPORT')`.
- `it('corte por createdAt removido: despesa adotada na dedup (createdAt anterior ao import) aparece no impact/settlement igual a uma criada pelo import')`.

### 5.5 `apps/api/src/bank-account/bank-account.undo-import-authz-reversal.spec.ts` (novo — ACL na escrita, distinto do ACL de leitura do PR1)
- `it('compra liquidada pertence a projeto REFORMA que o requester só vê PESSOAL → undoImport 404 "Fatura não encontrada", zero escrita, mesmo com trilha íntegra')` (cartão compartilhado PESSOAL/REFORMA).
- `it('ADMIN vê todos os participantes → undoImport reverte normalmente (baseline positivo do guard ACL, não só o caminho negativo)')`.

### 5.6 Frontend (materializa `frontend-expert`, só depois do contrato acima existir) — `apps/web`
- `InvoiceDetailPanel.test.tsx`: 5 estados de `settlement.state` (incl. `OUTSIDE_SETTLEMENT_WINDOW`, com CTA de confirmação manual distinto do CTA de undo do lote) renderizados a partir do contrato tipado (não de string), CTA de "desfazer a importação" quando `canUndo`, motivo textual honesto por `blockReason` (`INCOMPLETE_TRAIL`/`DRIFT:*`/`MANUAL_PAYMENT_OVERLAP`/`LEGACY_OR_MIXED`) quando bloqueado — nunca renderiza uma entrada de settlement oculta por ACL.
- `ImportHistoryModal.test.tsx`: botão desabilitado com `aria-disabled` quando `canUndo:false`, ≥44px, texto sem "ajuste manual" sem caminho concreto.

---

## 6. Decisões de negócio — status final

Todas as decisões de negócio pendentes desta revisão foram **confirmadas pelo
usuário** e incorporadas ao contrato acima:

1. ~~Política de janela de pagamento atrasado~~ — **decidido: opção C**, novo
   estado `OUTSIDE_SETTLEMENT_WINDOW` (§2.c, §4.2, §4.3). Janelas de prévia (3
   meses) e commit (2 meses) permanecem distintas; o commit não amplia o raio
   de ação automático.
2. ~~Amplitude da ACL cross-project em `settlement{}`~~ — **decidido:
   ocultação total (comportamento 404-like)**, consistente com o padrão já
   usado no undo (`Fatura não encontrada`, indistinguível de inexistência).
   Nenhuma entrada truncada, anonimizada ou com contagem residual do que está
   oculto (§4.1, §4.2).
3. **Copy final de `DRIFT:*`** — decidido: fica com o `frontend-expert`,
   seguindo o tom já estabelecido no app, **sem necessidade de revisão prévia
   do usuário**. O contrato só exige que o motivo técnico
   (`DRIFT:ENTRY_NOT_PAID` etc., §4.1) chegue tipado ao frontend — a redação
   final é responsabilidade de implementação, não uma decisão de produto em
   aberto.

Nenhuma decisão de negócio permanece pendente para este PR2.
