# Quitação de parcela cross-project (PESSOAL)

Atualizado em: **2026-08-12**

Documento canônico da feature que permite **pagar/quitar, pela conta do projeto
PESSOAL, uma parcela de uma despesa que vive em OUTRO projeto** (REFORMA, CASA,
CARRO, COMPRA). Cobre o bug-raiz que motivou a feature, a arquitetura do fluxo,
os invariantes de backend (P1–P7 / E2 / E5 / E8), as entradas de UI, o modelo de
dados e como validar. Leia junto com `cockpit-caixa-real.md` (§10) e
`visao-conta-faturas.md` (neutros, faturas, matching).

Commits principais:
- `84bb6cdc` — Fase 6: conciliação cross-project por parcela (base).
- `ef5ea7bf` — lista PESSOAL passa a mostrar o alvo cross-project parcelado canônico.
- `62c09e4d` — quitação de parcela cross-project robusta (P1–P7, modal, wizard, badge).
- `2832a75b` — **status na lista da Visão Projeto PESSOAL roteia p/ quitação**
  (fecha o último caminho que reintroduzia o sumiço).
- `ba5090bc`/`4e46a6f0`/`febd9151` (#424) — origem read-only do pagamento
  cross-project por parcela na REFORMA (§10): `GET .../expenses/paid-origins`.
- `ba867600`/`e8b7903a`/`a029a6cf` (#448 B1a) — child ACL encadeada em
  `settleTargetParcela`; `roomId` e `sourcePriceItemId` validados por escopo;
  guard de duplicidade ativa em cartão/conta (§10b de `visao-conta-faturas.md`).

---

## CONTRATO (normativo — o que nunca pode quebrar)

1. Quitar parcela cross-project **nunca** pode ser "status puro"; sempre gera movimento real no PESSOAL.
2. Fluxo obrigatório em 2 etapas: criar espelho pago no PESSOAL + conciliar parcela alvo.
3. Conciliação por parcela persiste `CrossProjectSettlement(sourceExpenseId, targetExpenseId, parcelaIndex)`.
4. `getAccountView` deve suprimir apenas parcelas quitadas e manter pendentes do mesmo alvo.
5. IDs sintéticos por parcela (`<foreignId>#<idx>`) devem existir antes da 1ª quitação.
6. **P1/P2:** idempotência por `(targetExpenseId, parcelaIndex)`; re-quitar não duplica débito.
7. **P3:** origem (cartão/banco) classificada por parcela (`parcelaOriginByForeign`).
8. **P4:** `realValor` usa valor do espelho, não do alvo.
9. **P5:** alvo/source neutro não é quitável.
10. **P6:** desconciliação trata destino do espelho e soft-delete conjunto de `Expense` + `cashFlowEntry`.
11. **P7:** emissão por-parcela é a base da ação "Quitar".
12. **E2:** `parcelaIndex` sempre normalizado (clamp no range válido).
13. **E5:** mutex simétrico `rateio × settle` no mesmo `targetExpenseId`.
14. **E8:** mutations invalidam `monthly-overview` e `account-view` no front.
15. A data efetiva de uma ocorrência `PARCELADO` ou `QUINZENAL` pode ser alterada
    individualmente, inclusive quando há uma única parcela e independentemente de
    estar paga ou planejada; índice, valor, identidade e status não mudam.
16. Em par vinculado REFORMA↔PESSOAL sem conciliação, a data é sincronizada nos
    dois lados na mesma transação. Alvo de rateio não é editável: a compra-fonte é
    editada e propaga seu cronograma a todos os alvos.
17. Em conciliação por parcela, a planejada alvo pode mudar de data e regenera seu
    fluxo; a fonte real conciliada é bloqueada para não reescrever o movimento real.
18. **Origem exibida no alvo (read-only) — invariantes O1–O12** (ver §10):
    - **O1:** `GET .../expenses/paid-origins` NUNCA escreve — nem no alvo, nem na
      fonte; sem `$transaction`, sem mutação.
    - **O2:** fonte re-lida ATIVA (`deletedAt: null`) no momento da leitura; fonte
      soft-deletada é descartada silenciosamente (não derruba as demais parcelas
      do mesmo alvo).
    - **O3:** precedência **settlement > rateio > link** por alvo — mutuamente
      exclusivas; um alvo nunca aparece por duas vias.
    - **O4:** 1 fonte rateada em N alvos → N itens `via:'rateio'`, todos com a
      **mesma** origem e `parcelas: []`.
    - **O5:** origens deduplicadas por `kind:last4`; o mesmo cartão em 2 parcelas
      gera 2 entradas em `parcelas` mas 1 única entrada em `origins`.
    - **O6:** quando só 1 de 2 origens é visível ao viewer, a visível some junto
      (não vaza um "resto" parcial) e `multiple` reflete a contagem PÓS-redação.
    - **O7:** `origins` nunca é `[]` num item retornado; se todos os candidatos
      morrerem (fonte inativa/carteira/redação), o item inteiro some da resposta.
    - **O8:** fonte **Carteira** (sem cartão e sem conta) nunca emite origem.
    - **O9:** `parcelaIndex` é 0-based e a parcela de índice 0 é tratada
      normalmente (nunca cai no `falsy` trap).
    - **O10:** redação por acesso (role/módulo/`projectScope`/tipo de projeto da
      **fonte**) omite a entrada inteira — nunca um `last4`/apelido mascarado.
    - **O11:** sem N+1 — bounded (≤7) batch queries mesmo com muitos alvos
      compartilhando a mesma fonte.
    - **O12:** ordenação determinística — itens por `expenseId` asc; `parcelas`
      por `parcelaIndex` asc; `origins` na ordem de 1ª aparição.
19. **B1a — Child ACL em `settleTargetParcela`:** quando o chamador fornece um
    `RateioRequester`, o projeto-alvo (child) é relido DENTRO da `$transaction`
    existente e validado contra o tenant e o escopo autorizado do requisitante
    (TOCTOU-safe; sem redesign de transação). Projeto ausente, cross-tenant ou
    fora do escopo → mesma exceção que o caminho já lançava para "not found" —
    nenhuma mensagem nova vaza existência de recurso. Requester ausente (paths
    legados) → full-access, comportamento idêntico ao de antes do B1a.

## Referência de implementação

- Backend: `apps/api/src/conciliacao/conciliacao.service.ts`, `apps/api/src/expense/expense.service.ts`, `apps/api/src/monthly-overview/monthly-overview.service.ts`.
- Frontend: `apps/web/src/app/projects/[projectId]/conta/_components/QuitarParcelaModal.tsx`, `.../conta/_components/MovimentacoesSection.tsx`, `.../expenses/ExpensesView.tsx`, `.../expenses/_hooks/useExpenseMutations.ts`, `.../expenses/_lib/quitarParcelaCross.ts`.
- Modelo: `prisma/schema.prisma` (`CrossProjectSettlement`, `RateioAllocation`).
- Datas efetivas: `packages/domain/src/calculations/expense-installments.ts`,
  `apps/api/src/expense/expense.service.ts` (`updateInstallmentDate`) e
  `apps/web/src/app/projects/[projectId]/expenses/_components/MonthlyExpenseView.tsx`.
- Testes que blindam contrato: `apps/api/src/conciliacao/conciliacao.hardening.spec.ts`, `apps/api/src/expense/expense.conciliar-parcela.spec.ts`, `apps/api/src/expense/expense.installment-date.spec.ts`, `apps/api/src/monthly-overview/monthly-overview.foreign-parcela.spec.ts`, `apps/web/src/app/projects/[projectId]/expenses/_lib/quitarParcelaCross.test.ts`.
- **Origem exibida no alvo (§10, O1–O12):** backend
  `apps/api/src/expense/paid-origins.types.ts` (contrato de resposta),
  `paid-origins.builder.ts` (derivação pura settlement/rateio/link + redação),
  `paid-origins.service.ts` (orquestração read-only, bounded ≤7 queries),
  registrado em `ExpenseModule` e exposto por
  `expense.controller.ts` (`@Get('paid-origins')`, declarado ANTES de
  `@Get(':id')` — ver nota de roteamento no §10). Frontend:
  `apps/web/src/app/projects/[projectId]/expenses/_lib/paid-origin-label.ts`
  (`formatPaidOriginLabel`, `pickOriginForOccurrence`, `buildPaidOriginIndex`),
  consumido por `MonthlyExpenseView.tsx` (badge por ocorrência) e
  `CategoryExpenseView.tsx` (agregado, "Múltiplas origens" quando
  `multiple=true`) via `ExpensesView.tsx`. Testes:
  `apps/api/src/expense/paid-origins.builder.spec.ts`,
  `paid-origins.service.spec.ts`, `paid-origins.route-order.contract.spec.ts`,
  `apps/web/.../expenses/_lib/paid-origin-label.test.ts`,
  `MonthlyExpenseView.paid-origins.test.tsx`,
  `CategoryExpenseView.paid-origins.test.tsx`.

## Apêndice histórico

## 1) Bug-raiz — "a parcela some da Visão Conta"

O PESSOAL é o **controlador universal do caixa**: consolida despesas de todos os
projetos do tenant. Uma despesa de outro projeto (ex.: *Infra+Elétrica…* de
REFORMA, R$80.000 em 10 quinzenais de R$8.000) aparece no PESSOAL como **alvo
cross-project** (`foreign`).

O erro: marcar uma parcela desse alvo como **paga sem gerar movimento** — via
`setParcelaStatus` no projeto dono. Isso só grava `paidParcelas`/`status` no alvo
e regenera o cashflow **do próprio projeto dono**. No PESSOAL a parcela:

- deixa de ser **pendente** (não entra em "Ainda falta pagar"); e
- não vira **realizado** (não há espelho/movimento na conta pessoal).

Resultado: **desaparece da Visão Conta** — nem prevista, nem realizada. O caixa
fica visualmente "furado" (o dinheiro saiu, mas nenhuma linha mostra).

**Regra de ouro:** pagar/quitar uma parcela cross-project pela conta pessoal
**SEMPRE tem de gerar um movimento real** (um *espelho* conciliado). Nunca um
status puro.

---

## 2) Arquitetura do fluxo — espelho + conciliação (2 etapas)

Quitar a parcela `k` do alvo `foreign` (que vive no projeto `X`) faz:

1. **Cria um espelho pago no PESSOAL** — `POST /projects/:pessoal/expenses`
   com uma despesa real (conta/cartão + valor + data + tipo não-neutro),
   `linkedExpenseId = foreign.id`. Isso é um **pagamento real** que entra no
   caixa PESSOAL.
2. **Concilia o espelho com a parcela-alvo** —
   `POST /projects/:pessoal/expenses/:espelhoId/conciliar-parcela`
   `{ targetExpenseId: foreign.id, parcelaIndex: k }`. Grava um
   **`CrossProjectSettlement`** `(sourceExpenseId=espelho, targetExpenseId=foreign,
   parcelaIndex=k)` e marca a parcela `k` do alvo como paga.

O `CrossProjectSettlement` é o que permite ao `getAccountView` **suprimir a
parcela quitada** (a fatura do cartão / o espelho bank já a representam) **sem**
perder as demais parcelas do mesmo alvo, e **por parcela** (P3).

### Não-atomicidade (2 chamadas HTTP)
Se a etapa 2 falhar, o espelho fica órfão (`linkedExpenseId` gravado mas sem
settlement) e contaria como gasto real solto. Mitigação: o modal faz
`api.delete` **compensatório** do espelho em falha parcial (Issue 1 / RISCO-3).

---

## 3) Invariantes de backend (relatório da lente PESSOAL)

Implementados em `apps/api/src/conciliacao/conciliacao.service.ts`,
`expense.service.ts` e `monthly-overview.service.ts`.

| # | Regra | Onde |
|---|---|---|
| **P1/P2** | Espelho **idempotente** por `(target, parcelaIndex)` — não há duplo débito ao re-quitar. | `settleTargetParcela` |
| **P3** | Origem (cartão/banco) classificada **POR PARCELA** (`parcelaOriginByForeign`) — quitar uma parcela por cartão não some com as outras. | `getAccountView` |
| **P4** | `realValor = valorTotal` do espelho (não o do alvo). | `conciliarParcela` |
| **P5** | Alvo **neutro** não é quitável; neutros excluídos da lista; espelho é sempre não-neutro. | guards em settle + filtro no modal/wizard |
| **P6** | Desconciliar trata o destino do espelho (sem dupla contagem); soft-delete conjunto do `cashFlowEntry`. | `unsettleBySource` + `softDeleteMirror` |
| **P7** | Linha por-parcela emitida **antes da 1ª quitação** (id sintético `"<foreignId>#<idx>"`). | `foreignPendingItems` |
| **E2** | `parcelaIndex` normalizado (clamp ao range). | `conciliarParcela` / helpers |
| **E5** | **Mutex simétrico rateio × settle**: `settleTargetParcela` bloqueia alvo já rateado (`rateioAllocation.count`), pois `regenerateTargetCashflow` ignora `RateioAllocation`. | `settleTargetParcela` |
| **E8** | Mutations de despesa invalidam `['monthly-overview']` e `['account-view']`. | `useExpenseMutations` |
| **COMPAT** | Espelhos vinculados **manualmente sem** `CrossProjectSettlement` (PIX RMD legados) continuam funcionando via caminho agregado bank. | `foreignPendingItems` caminho legado |

### Helper `softDeleteMirror(tx, sourceId)`
`$transaction` **ignora** o `$use` de soft-delete do Prisma. Ao remover um espelho
dentro de uma tx é preciso soft-deletar **a despesa E o `cashFlowEntry` juntos** —
senão a entrada órfã vaza em `notifications.service.ts` (que consulta
`cashFlowEntry` sem filtrar `expense.deletedAt`). O helper faz os dois.

### `getAccountView` — 3 caminhos de `foreignPendingItems`
(`monthly-overview.service.ts`, ~L578)
1. **com settlement** (`hasSettlements`) → por-parcela: cada parcela quitada é
   suprimida; as pendentes emitem `"<foreignId>#<idx>"` + `parcelaIndex` +
   `foreignExpenseId` (o front abre a quitação).
2. **card lump** (origem cartão sem settlement) → `[]` (a fatura cobre).
3. **bank agregado / lump legado** → COMPAT para PIX RMD manuais sem settlement.

---

## 4) Entradas de UI (onde o usuário quita)

Todas convergem para o **mesmo** fluxo do §2 (`QuitarParcelaModal`), nunca um
status puro:

1. **Badge "Quitar" na Visão Conta** — `conta/_components/MovimentacoesSection.tsx`.
   Linhas pendentes com `foreignExpenseId` + `parcelaIndex != null` mostram o
   botão que abre o modal pré-preenchido.
2. **Wizard "Pagar planejada"** — `expenses/_components/NovaDespesaWizard.tsx`.
   Lista as planejadas cross-project (`GET …/expenses/cross-project?status=PLANEJADO`);
   ao escolher uma, roteia para o modal via `suggestParcelaQuitacao` (1ª parcela
   não paga, valor da PARCELA). As planejadas **locais** seguem por `onPay`.
3. **Toggle de status na lista da Visão Projeto PESSOAL** — `expenses/ExpensesView.tsx`
   (`handleToggleStatus` / `handleToggleParcela`). **Este era o furo** (commit
   `2832a75b`): o alvo cross-project (owner ≠ PESSOAL) exibido na lista disparava
   `setParcelaStatus` no projeto dono. Agora:
   - marcar **pago** → abre o `QuitarParcelaModal` (via `suggestParcelaQuitacao`
     para status inteiro, `suggestParcelaQuitacaoAt(exp, idx)` para uma parcela
     específica);
   - **desfazer** → orienta usar a Visão Conta (não faz status puro);
   - **marcar pago em massa** (`bulkPaidMutation`) → **pula** itens cross-project
     e avisa (a quitação exige meio de pagamento, é 1-a-1 no modal);
   - despesas **locais** do PESSOAL seguem o toggle normal.
4. **Editar rápido na visão por mês** — em uma ocorrência `PARCELADO` ou
   `QUINZENAL`, o lápis abre a edição da data daquela parcela. Funciona na
   REFORMA e na visão consolidada do PESSOAL, para paga ou planejada e também
   para parcelamento 1x. A mutação resolve o projeto dono sem trocar índice,
   valor ou status.

### Helpers puros (`expenses/_lib/quitarParcelaCross.ts`, testados)
- `parseForeignParcelaId("<id>#<idx>")` → `{ foreignExpenseId, parcelaIndex }`.
- `expandPendingForeignParcelas(saidas)` → parcelas pendentes com contexto.
- `buildEspelhoQuitacaoPayload(...)` → payload do POST /expenses.
- `parsePaidParcelaSet(paidParcelas)` → `Set<number>`.
- `suggestParcelaQuitacao(exp)` → 1ª parcela não paga; single → idx0/valorTotal;
  parcelada → valor da PARCELA (via `buildInstallments`), nunca o total.
- `suggestParcelaQuitacaoAt(exp, idx)` → parcela específica (clamp), valor/data
  dela; single → idx0/valorTotal.

> Bug histórico evitado: sugerir `parcelaIndex: 0` fixo (re-liquidava parcela já
> paga) e `valorSugerido: valorTotal` (R$80.000 em vez de R$8.000 da parcela).

---

## 5) Modelo de dados

`CrossProjectSettlement` (Prisma):
- `sourceExpenseId` — o espelho no PESSOAL (o pagamento real).
- `targetExpenseId` — a despesa-alvo no projeto de origem.
- `parcelaIndex` — parcela 0-based quitada.
- Espelho tem `linkedExpenseId = targetExpenseId`.

`RateioAllocation` tem `@@unique([targetExpenseId])` — daí o mutex E5: `settle` e
`ratear` são mutuamente exclusivos sobre o mesmo alvo.

Datas alteradas por ocorrência são persistidas em
`Expense.installmentDateOverrides`, JSON por índice 0-based
(`{"1":"2026-09-20"}`). O cronograma-base continua em
`dataInicioParcela`; voltar à data-base remove o override. O snapshot
`RateioAllocation.plannedInstallmentDateOverrides` restaura esse estado ao
desfazer um rateio. Ambos os campos foram adicionados pela migration
`20260810234344_add_installment_date_overrides`.

**Soft-delete:** modelos sem `deletedAt` estão em `modelsWithoutSoftDelete`
(`prisma.service.ts`). Dentro de `$transaction`, soft-delete manual + `findById`
fora da tx (o `$use` não roda em tx).

---

## 6) Endpoints

- `POST /projects/:projectId/expenses` — cria o espelho (com `linkedExpenseId`).
- `POST /projects/:projectId/expenses/:sourceId/conciliar-parcela`
  `{ targetExpenseId, parcelaIndex }` — grava o settlement + marca parcela paga.
- `PATCH /projects/:projectId/expenses/:id/parcela-data`
  `{ parcela, data }` — altera apenas a data efetiva do índice 0-based informado;
  `data` usa `YYYY-MM-DD`.
- `GET  /projects/:projectId/expenses/cross-project?status=PLANEJADO&limit=…` —
  planejadas de outros projetos (wizard).
- `GET  /projects/:projectId/monthly-overview/account-view?month=YYYY-MM` —
  emite as linhas com `parcelaIndex` / `foreignExpenseId` para a UI.
- `GET  /projects/:projectId/expenses/paid-origins` — read-only, deriva a
  origem (cartão/conta) que pagou cada parcela do alvo (§10, O1–O12); NUNCA
  muta o alvo nem a fonte. Declarado ANTES de `@Get(':id')` no controller
  (rota literal precede rota parametrizada — evitar o "id engole a rota").
- Desconciliar/desfazer → `unsettleBySource` (P6).

> Nota: o endpoint de expenses usa `page`/`pageSize` (cap 100 por padrão). Para
> snapshot completo em validação use `?pageSize=2000`.

---

## 7) Achados dos revisores (todos corrigidos)

- **RISCO-1 / E5** (bloqueante) — settle não bloqueava alvo já rateado →
  `regenerateTargetCashflow` ignora `RateioAllocation` → divergência de caixa +
  2 espelhos ativos. **Fix:** guard `rateioAllocation.count({targetExpenseId})`.
- **RISCO-2 / P5** — source neutra no dropdown. **Fix:** filtro de neutros no
  modal + guard de source-neutra no backend.
- **Issue 1 / RISCO-3** — espelho fantasma em falha parcial (create+conciliar).
  **Fix:** `try/catch` com `api.delete` compensatório no modal.
- **Issue 2** (regressão) — soft-delete manual do espelho não soft-deletava o
  `cashFlowEntry` → entrada órfã vazava em `notifications.service`. **Fix:**
  helper `softDeleteMirror`.

---

## 8) Como validar (dados reais de prod)

Invariantes conferidos com o alvo real **Infra** (`cmow625mr00fmb3i5uh8l1oc2`,
REFORMA), R$80.000, QUINZENAL 10x:
- 3 espelhos PIX (05/06, 23/06, 03/07), Σ = **R$24.000** = 3 parcelas pagas;
- `valorTotal` do alvo intacto (80k) — nada perdido;
- account-view de julho emite a parcela **23/07** com `parcelaIndex=3` +
  `foreignExpenseId` (ganha botão "Quitar"); a parcela paga vira movimento real;
- `caixaHoje` inalterado pela leitura.

Testes automatizados:
- API (jest): `conciliacao.hardening.spec.ts` (P1/P2/P5/P6/E5/E5-simétrico),
  `expense.conciliar-parcela.spec.ts`, `monthly-overview.foreign-parcela.spec.ts`
  (bloco **"PROD Infra"** com dados reais).
- Web (vitest): `expenses/_lib/quitarParcelaCross.test.ts` (inclui
  `suggestParcelaQuitacao` e `suggestParcelaQuitacaoAt`).

Comandos:
```bash
cd apps/api && ../../node_modules/.bin/jest src/conciliacao src/monthly-overview src/expense
cd apps/web && ../../node_modules/.bin/vitest run quitarParcelaCross
```

---

## 9) Arquivos-chave

Backend:
- `apps/api/src/conciliacao/conciliacao.service.ts` — settle/unsettle,
  `softDeleteMirror`, guards P5/E5.
- `apps/api/src/expense/expense.service.ts` — `conciliarParcela` (P4/E2),
  `setParcelaStatus` (só não-foreign), `findCrossProject`.
- `apps/api/src/monthly-overview/monthly-overview.service.ts` — `getAccountView`
  (`parcelaOriginByForeign`, `foreignPendingItems` 3 caminhos).

Frontend:
- `apps/web/.../conta/_components/QuitarParcelaModal.tsx` — o modal (fluxo §2).
- `apps/web/.../conta/_components/MovimentacoesSection.tsx` — badge "Quitar".
- `apps/web/.../expenses/ExpensesView.tsx` — `handleToggleStatus` /
  `handleToggleParcela` (intercepta cross-project).
- `apps/web/.../expenses/_hooks/useExpenseMutations.ts` — `bulkPaidMutation`
  pula cross-project; E8.
- `apps/web/.../expenses/_components/NovaDespesaWizard.tsx` — wizard planejadas.
- `apps/web/.../expenses/_lib/quitarParcelaCross.ts` — helpers puros.
- `apps/web/.../expenses/_lib/paid-origin-label.ts` — helpers puros de origem
  (rótulo, seleção por ocorrência, indexação da resposta) — ver §10.

---

## 10) Origem exibida no alvo (read-only) — `GET .../expenses/paid-origins` (#424)

Endpoint read-only que resolve, **por parcela** de uma despesa-alvo, **quem
pagou de fato** — a fonte cross-project (tipicamente PESSOAL, mas qualquer
projeto) que a liquidou. É uma leitura auxiliar de exibição; **não substitui,
não altera e não depende de** o alvo estar quitado pelo fluxo do §2. Aplica-se
a QUALQUER projeto que liste despesas cross-project (hoje consumido pela
REFORMA em `ExpensesView.tsx`; a query fica desabilitada dentro do PESSOAL,
que já tem sua própria visão de conta).

### Precedência das 3 vias (mutuamente exclusivas por alvo, O3)
1. **`settlement`** — `CrossProjectSettlement(targetExpenseId, parcelaIndex)`;
   emite uma origem **por parcela** (`parcelas: [{parcelaIndex, origin}]`),
   permitindo que parcelas diferentes do mesmo alvo tenham origens diferentes.
2. **`rateio`** — `RateioAllocation`; uma única origem agregada vale para
   **todas** as ocorrências do alvo (`parcelas: []`); se o alvo já tem
   settlement, o rateio é ignorado para ele.
3. **`link`** — vínculo reverso simples (`Expense.linkedExpenseId` de uma
   fonte apontando para o alvo), só quando há exatamente **1** fonte
   candidata; múltiplas fontes reversas ambíguas fazem o alvo ser
   **omitido por completo** (não escolhe "a primeira").

### Contrato de resposta (`paid-origins.types.ts`)
`PaidOriginsResponse.items: ExpensePaidOrigin[]`, cada item com `expenseId`,
`via`, `parcelas` (só preenchido em `via='settlement'`), `origins` (conjunto
distinto por `kind:last4`, nunca vazio) e `multiple` (`origins.length > 1`,
calculado **após** a redação).

### Invariantes O1–O12 (ver lista completa no item 18 do CONTRATO)
Resumo operacional: read-only absoluto (O1); fonte sempre re-lida ativa (O2);
precedência settlement>rateio>link (O3); rateio replica a mesma origem a N
alvos (O4); dedup por `kind:last4` sem colapsar parcelas (O5); redação some
com a entrada inteira, nunca um resto parcial (O6); alvo sem candidato
sobrevivente some da resposta (O7); Carteira nunca emite origem (O8);
`parcelaIndex` 0 tratado normalmente (O9); redação por role/módulo/escopo do
projeto da FONTE (O10); bounded ≤7 queries, sem N+1 (O11); ordenação
determinística (O12).

### Gate de módulo por FONTE, não pelo alvo
O controller aplica `@RequireModule('expenses')` na classe (gate da rota).
O gate de `creditCards`/`bankAccounts` é per-origin, resolvido pelo builder
contra o **tipo do projeto da fonte** (`projectTypeHasModule`) — a rota é
chamada a partir de projetos (ex.: REFORMA) que nunca têm `bankAccounts` em
`TYPE_MODULES`; usar o gate da rota para isso esconderia toda a feature.

### UI (frontend, read-only, "fail-closed")
- `paid-origin-label.ts`: `formatPaidOriginLabel` (apelido > fallback
  "Cartão"/"Conta ••last4"), `pickOriginForOccurrence` (casa `parcelaIndex`
  0-based com `occIndex` 1-based; rateio/link aplicam a mesma origem a
  qualquer ocorrência), `buildPaidOriginIndex` (tolera resposta ausente).
- Badge somente-leitura (`<span>`, sem `role="button"`, sem modal); ausência
  de entrada, loading ou erro **não renderizam nada** — nunca quebram a lista
  principal de despesas.
- `MonthlyExpenseView` mostra a origem por ocorrência; `CategoryExpenseView`
  agrega e mostra **"Múltiplas origens"** quando `multiple=true`.
- Nunca lê `cardLast4`/`bankLast4` do próprio alvo para montar o rótulo — o
  rótulo vem sempre da origem resolvida pelo backend (reforça O1).

### Roteamento (hazard evitado)
`@Get('paid-origins')` é declarado **antes** de `@Get(':id')` em
`expense.controller.ts` — rota literal antes de rota parametrizada, senão
`:id` capturaria `paid-origins` como um id de despesa.
`paid-origins.route-order.contract.spec.ts` blinda essa ordem.
