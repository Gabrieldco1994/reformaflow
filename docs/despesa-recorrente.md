# Despesa recorrente

Atualizado em: **2026-07-06**

Documento canônico da feature que permite **lançar despesas recorrentes** — que
se repetem no tempo entre um início e um fim, na frequência mensal ou quinzenal.
Cobre a arquitetura (por que gera despesas planejadas reais em vez de uma flag
virtual), o modo cross-project (obra paga pelo pessoal), os canais (UI, Copilot,
voz), o contrato de API e como validar. Leia junto com
`quitacao-parcela-cross-project.md` (padrão canônica+espelho) e
`cockpit-caixa-real.md` (§10, como as despesas entram no caixa/KPIs).

Commits principais:
- `de9f420d` — jornada de despesa recorrente (UI + Copilot + voz), single-project.
- `94551610` — recorrência cross-project (obra paga pelo pessoal).

---

## 1) Princípio central — materializa despesas reais, não uma flag

Existia (e foi **removida** da UI de criação) uma checkbox `recorrente` no form de
despesa: era uma flag **virtual** (`Expense.recorrente` / `recorrenciaFim`) que
marcava a despesa como "fixa mensal" mas **não gerava linhas** — e era
praticamente inerte (nenhum KPI/projeção a consumia). Os campos permanecem no
schema por compatibilidade, mas a jornada de criação não os usa mais.

A feature nova faz o oposto: **gera N despesas planejadas independentes** — uma
por ocorrência. Cada ocorrência é uma despesa `A_VISTA` / `PLANEJADO` normal
(mesma data em ambos os eixos: `dataPagamento` = `dataCompra` = a data da
ocorrência). Por reusar `ExpenseService.create`, ela herda tudo — links de
cartão/conta, geração de cashflow, competência — e **entra automaticamente em
todos os consumidores** (cockpit, Visão Conta, DRE, planning, extrato, KPIs) sem
lógica nova em nenhum deles.

Consequências desse desenho:
- **Editar o valor de uma ocorrência** é um `PATCH /expenses/:id` normal — cada
  ocorrência é independente.
- **Editar várias de uma vez ("em lote")** NÃO está implementado: as ocorrências
  não compartilham um `recurrenceGroupId` (decisão de produto: evitar migration
  agora). Fica como follow-up — exigiria um campo de grupo no schema.

---

## 2) Gerador de datas (domain)

`packages/domain/src/calculations/expense-recurrence.ts`

- `buildRecurrenceDates({ inicio, fim, frequencia, maxOcorrencias? }): Date[]`
  - **MENSAL**: mesmo dia do mês, do início ao fim (inclusive). Clamp para o
    último dia do mês quando o dia não existe (ex.: 31 → 28/fev). Espelha a regra
    de `buildInstallments`.
  - **QUINZENAL**: a cada 15 dias corridos.
  - Limites **inclusivos**; `fim < inicio` → `[]`. Teto de segurança
    `maxOcorrencias` (default 120). Datas geradas em **UTC** (sem deslocar fuso).
- `isRecurrenceFrequency(v)` — type guard (`'MENSAL' | 'QUINZENAL'`).

O frontend usa o MESMO `buildRecurrenceDates` para o **preview** (nº de
ocorrências + total), garantindo que a prévia bate com o que o backend cria.

Cobertura: `packages/domain/__tests__/expense-recurrence.test.ts` (9 testes).

---

## 3) Backend

**Endpoint:** `POST /projects/:projectId/expenses/recorrente`
**DTO:** `apps/api/src/expense/dto/create-recorrente.dto.ts`
**Service:** `ExpenseService.createRecorrente` (`expense.service.ts`)

Campos do DTO:
- `tipoDespesa`, `valor` (de CADA ocorrência, em reais), `quantidade?`,
  `titulo?`, `fornecedor?`, `link?`, `imageUrl?`, `categoriaMaoDeObra?`, `roomId?`.
- `frequencia` (`MENSAL`|`QUINZENAL`), `dataInicio`, `dataFim` (YYYY-MM-DD).
- `creditCardId?`, `bankAccountId?` — vínculo de pagamento (todas as ocorrências).
- `obraProjectId?` — **modo cross-project** (ver §4).

Fluxo:
1. Valida projeto, frequência e datas; gera as datas via `buildRecurrenceDates`.
2. Para cada data, chama `this.create(...)` com `formaPagamento: 'A_VISTA'`,
   `status: 'PLANEJADO'`, `dataPagamento = dataCompra = ocorrência`.
3. Retorna `{ count, crossProject, frequencia, dataInicio, dataFim, ids }`.

Validações que rejeitam (`BadRequestException`): frequência inválida, datas
inválidas, período com fim antes do início. Projeto fora do tenant →
`NotFoundException` (nada é criado).

Cobertura: `apps/api/src/expense/expense.service.spec.ts` (bloco `createRecorrente`).

---

## 4) Modo cross-project (obra paga pelo pessoal)

Quando `obraProjectId` aponta para um projeto **não-PESSOAL** com módulo de
despesas, cada ocorrência gera um **PAR vinculado** — exatamente o padrão de
`create_obra_expense`, repetido por ocorrência:

1. **Canônica** na obra: despesa `PLANEJADO`, sem meio de pagamento (é o registro
   do projeto de obra e o alvo do vínculo).
2. **Espelho** no PESSOAL: despesa `PLANEJADO` com `creditCardId`/`bankAccountId`
   e `linkedExpenseId = canônica.id` (registra a saída do caixa pessoal).

Assim a recorrência **não duplica**: o consolidado do PESSOAL deduplica espelhos
(o registro do projeto-alvo é o canônico), e o caixa (§10) conta o débito uma vez.

Garantias:
- **Rollback total**: as criações são rastreadas (`{projectId, id}`); se qualquer
  uma falhar, TODAS as já criadas são removidas (`remove`, na ordem inversa).
- **Guardas**: a obra deve existir, ser do tenant e **não** ser PESSOAL.
- Excluir o espelho no PESSOAL limpa a canônica vinculada (cleanup cross-project
  já existente) — verificado em produção.

Cobertura: `expense.service.spec.ts` — "par canônica+espelho por ocorrência" e
"rejeita obra do tipo PESSOAL".

---

## 5) Canais (UI, Copilot, voz)

- **UI**: `apps/web/.../expenses/_components/RecorrenteWizard.tsx`, aberto pelo
  botão **"Despesa recorrente"** no `PayOptionsModal` (só PESSOAL). Reúne os dados
  base + frequência + início/fim + (opcional) projeto de obra + cartão/conta.
  Mostra um **preview** client-side (nº de ocorrências e total; em cross-project
  indica "N × 2 lançamentos"). Invalida `expenses`/`cash-flow`/`account-view`/
  `monthly-overview`/`dashboard` no sucesso.
- **Copilot + voz**: ambos usam o mesmo `POST /agent/chat` → `AgentToolsService`,
  então um único tool cobre os dois: **`create_recurring_expense`**
  (`apps/api/src/agent/tools/agent-tools.service.ts`). Aceita `frequencia`,
  `dataInicio`, `dataFim`, `obraProjectId?` e os mesmos vínculos. O system prompt
  (`agent.service.ts`) orienta a usá-lo para falas recorrentes (ex.: "todo mês
  500 de aluguel de jan a dez", "quinzenalmente 300 da diarista", "todo mês 2000
  de mão de obra da reforma pelo meu cartão").

---

## 6) Como validar

```bash
# Domain
cd packages/domain && npx vitest run __tests__/expense-recurrence.test.ts
# Backend
cd apps/api && npx jest src/expense/expense.service.spec.ts src/agent
```

Validação **live** em prod (sempre limpar depois):
```bash
# single-project — cria 4 planejadas jan→abr
curl -sX POST "$API/projects/$PESSOAL/expenses/recorrente" -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"tipoDespesa":"OUTROS","valor":123.45,"frequencia":"MENSAL","dataInicio":"2027-01-10","dataFim":"2027-04-10"}'

# cross-project — 3 ocorrências → 3 canônicas (obra) + 3 espelhos (pessoal)
curl -sX POST "$API/projects/$PESSOAL/expenses/recorrente" -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"tipoDespesa":"MAO_DE_OBRA","valor":2000,"frequencia":"MENSAL","dataInicio":"2027-01-15","dataFim":"2027-03-15","obraProjectId":"<obra>"}'
```
Confira: nº de ocorrências, `status=PLANEJADO`, `formaPagamento=A_VISTA`, datas
corretas e (cross) espelhos com `linkedExpenseId` apontando para a canônica.
**Sempre apagar os lançamentos de teste ao final** (deletar o espelho já limpa a
canônica vinculada).

---

## 7) Follow-ups conhecidos

- **Edição/exclusão em lote** das ocorrências de uma mesma recorrência — exige um
  `recurrenceGroupId` no schema (migration + backup). Hoje cada ocorrência é
  editada individualmente.
- **Fim "sem data"** (recorrência aberta) — hoje `dataFim` é obrigatória; um
  horizonte rolante (ex.: +12 meses) seria uma evolução.
