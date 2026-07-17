# Quitação de parcela cross-project (PESSOAL)

Atualizado em: **2026-07-03**

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

## Referência de implementação

- Backend: `apps/api/src/conciliacao/conciliacao.service.ts`, `apps/api/src/expense/expense.service.ts`, `apps/api/src/monthly-overview/monthly-overview.service.ts`.
- Frontend: `apps/web/src/app/projects/[projectId]/conta/_components/QuitarParcelaModal.tsx`, `.../conta/_components/MovimentacoesSection.tsx`, `.../expenses/ExpensesView.tsx`, `.../expenses/_hooks/useExpenseMutations.ts`, `.../expenses/_lib/quitarParcelaCross.ts`.
- Modelo: `prisma/schema.prisma` (`CrossProjectSettlement`, `RateioAllocation`).
- Testes que blindam contrato: `apps/api/src/conciliacao/conciliacao.hardening.spec.ts`, `apps/api/src/expense/expense.conciliar-parcela.spec.ts`, `apps/api/src/monthly-overview/monthly-overview.foreign-parcela.spec.ts`, `apps/web/src/app/projects/[projectId]/expenses/_lib/quitarParcelaCross.test.ts`.

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

**Soft-delete:** modelos sem `deletedAt` estão em `modelsWithoutSoftDelete`
(`prisma.service.ts`). Dentro de `$transaction`, soft-delete manual + `findById`
fora da tx (o `$use` não roda em tx).

---

## 6) Endpoints

- `POST /projects/:projectId/expenses` — cria o espelho (com `linkedExpenseId`).
- `POST /projects/:projectId/expenses/:sourceId/conciliar-parcela`
  `{ targetExpenseId, parcelaIndex }` — grava o settlement + marca parcela paga.
- `GET  /projects/:projectId/expenses/cross-project?status=PLANEJADO&limit=…` —
  planejadas de outros projetos (wizard).
- `GET  /projects/:projectId/monthly-overview/account-view?month=YYYY-MM` —
  emite as linhas com `parcelaIndex` / `foreignExpenseId` para a UI.
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
