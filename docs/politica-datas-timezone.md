# Política de datas financeiras (TZ)

## Regra única

- **Dia-calendário financeiro = America/Sao_Paulo (BRT/BRT+DST histórico)**.
- **Persistência = meia-noite UTC** (`YYYY-MM-DDT00:00:00.000Z`).
- Datas digitadas pelo usuário (`YYYY-MM-DD`) já seguem essa regra.
- Fallback de "agora" em caminhos financeiros deve usar `todayLocalDateUtc('America/Sao_Paulo')` (domain).

## Inventário (escrita e fronteiras)

| Arquivo:linha | Como a data nasce | Formato | TZ efetiva | Risco |
|---|---|---|---|---|
| `packages/domain/src/calculations/expense-installments.ts:76,84` | Fallback sem data explícita em parcelas | `Date` | **BRT→UTC midnight (corrigido)** | Antes podia cair no dia/mês/fatura seguinte |
| `packages/domain/src/calculations/local-date-utc.ts:1-34` | Helper canônico (`localDateUtc`/`todayLocalDateUtc`) | `Date` | BRT normalizado para UTC | Base única |
| `apps/api/src/monthly-overview/monthly-overview.service.ts:2910-2920` | `purchaseDate`/`accountExpenseDate` fallback de `createdAt` | `Date` | **BRT→UTC midnight (corrigido)** | Evita cruzar `closingDay` por horário |
| `apps/api/src/monthly-overview/monthly-overview.service.ts:2862-2879` | `normalizeMonthKey`/`normalizeYear` sem parâmetro | `YYYY-MM`/`YYYY` | **BRT (corrigido)** | Evita mês corrente UTC divergir do mês financeiro |
| `apps/web/src/app/projects/[projectId]/monthly/_cockpit/derive.ts:266-314,793-798` | `nowKey`/dia corrente para percentuais e mês atual | `YYYY-MM` + dia | **BRT (corrigido)** | Front e API passam a concordar na fronteira do mês |
| `apps/web/src/app/projects/[projectId]/expenses/ExpensesView.tsx:725` | Fallback inline de data de pagamento | `YYYY-MM-DD` | **BRT (corrigido)** | Evita enviar dia UTC+1 no fim do dia local |
| `apps/api/src/expense/expense.service.ts:113-116,739-752,901-903` | Create/update/payPlanned parseiam datas do DTO | `new Date('YYYY-MM-DD')` | UTC midnight (seguro) | Baixo |
| `apps/api/src/receipt/receipt.service.ts:25,79` | Parse de data de recebimento | `new Date('YYYY-MM-DD')` | UTC midnight (seguro) | Baixo |
| `apps/api/src/agent/tools/agent-tools.service.ts:394,796` | Default de data em tools da Maria | `YYYY-MM-DD` | UTC (`toISOString`) | **Médio** (ainda não corrigido nesta fase) |
| `apps/api/src/agent/tools/agent-tools.service.ts:1111-1116` | `optDate` valida string | `YYYY-MM-DD` | parse UTC | Baixo |
| `apps/api/src/bank-account/bank-account.service.ts:1039-1206` | Importador cria despesas/receitas com `tx.date` | `Date` | Vem do parser (majoritariamente UTC midnight) | Baixo |
| `apps/api/src/bank-account/bank-account.service.ts:422` | `periodLabel` fallback | `YYYY-MM` | UTC (`toISOString`) | **Médio** (rotulagem de período) |
| `apps/api/src/bank-account/bank-account.service.ts:631` | `payDate` fallback de recorrência | `Date` | relógio local do servidor | **Médio** |
| `apps/api/src/credit-card/credit-card.service.ts:124-126` | Fallback compra usa `createdAt` | `Date` | UTC instantâneo | **Médio** (não alterado nesta fase) |
| `apps/api/src/credit-card/credit-card.service.ts:158` | `currentOpenInvoiceMonth(today = new Date())` | `YYYY-MM` | UTC | **Médio** (janela de fronteira) |
| `apps/api/src/credit-card/credit-card.service.ts:352` | `periodLabel` fallback import | `YYYY-MM` | UTC (`toISOString`) | **Médio** |
| `apps/api/src/credit-card/parsers/ofx.ts:91` | OFX → `Date.UTC` | `Date` | UTC midnight | Baixo |
| `apps/api/src/credit-card/parsers/csv.ts:162,169` | CSV ISO/BR → `Date.UTC` | `Date` | UTC midnight | Baixo |
| `apps/api/src/credit-card/parsers/pdf.ts:49-57,255` | PDF/fatura → `Date.UTC` (com inferência de ano) | `Date` | UTC midnight | Baixo |
| `apps/api/src/bank-account/parsers/pdf.ts:94` | PDF/extrato → `Date.UTC` | `Date` | UTC midnight | Baixo |
| `apps/api/src/simulation/simulation.service.ts:250` | Agrupa mês por `toISOString().slice(0,7)` | `YYYY-MM` | UTC | **Médio** (competência em UTC) |
| `apps/api/src/tenant-financial/tenant-financial.service.ts:88-105` | `monthKey` + janelas 30/90 dias com `new Date()` | `YYYY-MM` | UTC/local misto | **Médio** |
| `apps/api/src/recurring-bill/recurring-bill.service.ts:64-74` | Próximo vencimento por `new Date(y,m,d)` | `Date` | local do servidor | **Médio** |
| `packages/domain/src/calculations/expense-recurrence.ts:41-64` | Recorrência mensal em UTC | `Date` | UTC | Baixo |
| `prisma/seed.ts:57-164` | Seeds com datas literais `new Date('YYYY-MM-DD')` | `Date` | UTC midnight | Baixo (somente seed) |
| `packages/domain/src/calculations/card-cash-month.ts:45` | Fronteira de fatura `day < closingDay` | dia do `Date` | UTC day | **Sensível** (não alterar regra de produto) |
| `apps/api/src/monthly-overview/monthly-overview.service.ts:2375,2888,2903` | `monthKeyOf`, `monthRange`, `isInRange` | `YYYY-MM` + intervalo | UTC | Sensível a input com hora |
| `apps/web/src/app/projects/[projectId]/monthly/_cockpit/derive.ts:164,299,544...` | Filtros por `(e.data ?? '').slice(0,7)` | `YYYY-MM` string | depende da origem da string | Sensível a payload com hora |

## Exposição (read-only)

Consulta executada em `prisma/dev.db` (ambiente local desta sessão):

- `cash_flow_entries` ativos: **1013**
- Horário `!= 00:00:00Z`: **0**
- Candidatos com possível `dia UTC != dia BRT` (`hora UTC < 03:00`): **0**
- Candidatos com mudança de mês UTC→BRT: **0**

Também em `expenses` sem data explícita (`data_pagamento` e `data_inicio_parcela` nulos):

- Total: **3**
- `created_at` não meia-noite UTC: **0**

> Observação: este relatório foi possível apenas no banco local. Para produção, executar as mesmas queries em modo read-only e anexar no PR.

### Exposição na Vercel (`https://reformaflow.vercel.app`) — tenant de teste autenticado

Coleta feita via API autenticada (`/api/projects/*/cash-flow`), sem mutação, consolidando IDs únicos de lançamentos.

- Projetos auditados: **5**
- `cash_flow_entries` únicos: **1708**
- Horário `!= 00:00:00Z`: **2**
- Desses, com `dia UTC != dia BRT`: **1**
- Desses, com `hora UTC < 03:00`: **1**
- Casos com troca de mês UTC→BRT: **0**

Casos detectados (não meia-noite UTC):

| id | projeto | título | data | UTC day | BRT day | formaPagamento | impacto mês | impacto fatura |
|---|---|---|---|---|---|---|---|---|
| `cmqu8f3ut000deb20tyswvqin` | PESSOAL | Pix regiane | `2026-06-26T01:07:57.892Z` | `2026-06-26` | `2026-06-25` | `A_VISTA` | Não | Não (não é cartão) |
| `cmp1tfw5m002aoc1il93sxn4u` | REFORMA | Quartzo Tiffany Gold | `2026-05-11T23:11:25.066Z` | `2026-05-11` | `2026-05-11` | `A_VISTA` | Não | Não (não é cartão) |

> Não houve caso que alterasse fatura (`closingDay`) nem competência mensal neste tenant de teste. Se aparecer caso com `formaPagamento=CARTAO_CREDITO` e `dia UTC != dia BRT`, listar no PR com `fatura antes/depois` para correção manual com backup.
