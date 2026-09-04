# Estado Atual — Cockpit/Visão Conta (PESSOAL)

Estado de runtime consolidado em: **2026-08-13**.

Nota de planejamento #436 adicionada em: **2026-08-17**.

**Atualizado em 2026-08-18:** B0 (#447) entregue via PR #476 (produção). B1a (#448) implementado nesta PR, pendente de merge.

**Atualizado em 2026-09-03:** loop de aprendizado da categorização na importação fechado ponta a ponta (extrato + fatura); banner de degradação + chip de fonte no preview; precedência do `classifyForImport` e confiança na resposta do Gemini corrigidas; **issue #582 FECHADA**. Ver §6.

Histórico detalhado: `docs/archive/estado-atual-historico-2026.md`.

## Programa Centro Financeiro #436 (planejamento, não estado entregue)

O [SDD do Centro Financeiro](plano-centro-financeiro-sdd.md) está **aprovado como planejamento**,
com implementação de produto/runtime não iniciada para a maioria das ondas. **B0**
([#447](https://github.com/Gabrieldco1994/reformaflow/issues/447)) foi **entregue via PR #476**
(produção). A primeira fatia de **B1**
([#448](https://github.com/Gabrieldco1994/reformaflow/issues/448), B1a) está implementada nesta
PR e **pendente de merge**; após o merge a sequência obrigatória é W1, B1b e depois B2. Somente
a baseline determinística test-only S0.3
[#446](https://github.com/Gabrieldco1994/reformaflow/issues/446) está também autorizada e pode
estar em andamento; ela não altera esta tela nem os contratos abaixo.

- Decisão PO de 2026-08-17: #446 pode construir, testar e fazer merge test-only sem aguardar
  [#445](https://github.com/Gabrieldco1994/reformaflow/issues/445).
- #445 segue **BLOQUEADA/DEFERIDA**: a admissão da Fly Machine falhou antes do acesso ao banco;
  agregados, cardinalidades e anomalias de produção estão `NOT_COLLECTED`, nunca zero.
- Código, histórico do GitHub e as 63 migrations commitadas até `20260810234344` descrevem estado
  esperado; não comprovam dados de runtime nem migrations aplicadas em produção.
- E0 permanece incompleta pelo seu próprio gate de inventário de produção (#445). Isso não
  desfaz a entrega de B0: **B0 foi entregue via PR #476 (produção)**. #446 não certifica
  segurança ou migração de produção. **B1a está implementado nesta PR, pendente de merge.**
- B0/B1/B2 precisam ficar verdes antes de qualquer UX.
- U6b continua bloqueada por U6a, lenses, architect e aprovação explícita do PO.
- Maria agent-first (E5/M0–M3) é FUTURO e exige novo PO gate.
- Hardening H1–H5 está bloqueado e separado; não foi entregue pelo programa.

Os apontamentos de branch/“este PR” no placar abaixo são snapshots do ciclo anterior e não servem
como ledger do programa #436. O estado de #436 vive nos issues #436–#468 e #405 e deve ser
refletido aqui pelo D0 somente quando uma mudança de runtime for entregue.

## 0) Placar das trilhas (snapshot anterior ao programa #436)

- ✅ UX v2 W1 estabilizado (`feat/ux-v2-w1-pendencias` / PR #220): fila "Precisa de você" com roteamento correto (vincular/quitar/pagar/editar), sem 404.
- ✅ UX v2 W2 estabilizado (`feat/ux-v2-w2-categorias` / PR #234): confirmar categoria com aprendizado de regra manual, proteção PIX PF, auto-aplicação no ingest para regra manual e gestão de regras atrás de engrenagem em Análises. **Loop fechado na importação (2026-09-03):** ver §6.
- ✅ UX v2 W3 estabilizado (`feat/ux-v2-w3-dieta-conta` / PR #235): dieta da Conta (carrossel compacto de cartões, ticket médio movido para Análises, piso tipográfico ≥11px corrigido).
- 🚧 UX v2 W4 em execução (`feat/ux-v2-w4-runway-prescritivo`): runway prescritivo — botão "Como fechar no azul?" no Cockpit quando tom negativo; sheet com candidatos (até 5 maiores planejados até o crossover) e ações adiar/reduzir/remover.
- ✅ Fases A–D + F/G (redesign UX + cockpit/mobile/web) concluídas em `main`.
- ✅ Fase E (motor único + caixa real §10) concluída e ativa; pendência operacional de validação em prod segue no issue #95.
- ✅ Skin Minimal mobile PESSOAL (PR #125) e Stage A cross-project (PR #136) em produção.
- ✅ Auditoria técnica abriu #94/#95/#96/#97/#98; continuam como trilhas de evolução (não regressão do entregue).
- ✅ PR #145 (spec review/arquivamento) mergeado em `main` em 2026-07-15.
- ✅ **PR-1 mobile row** (fix B1): layout legível em 375px, valor nowrap, status textual — mergeado via PR #202 em 2026-07-20.
- ✅ **PR-2 backend Carteira**: `getAccountView` emite `origem:{tipo:'carteira'}` para saídas sem cartão/conta; `saiuMes`/`faltaPagar` incluem carteira — mergeado via PR #202 em 2026-07-20.
- 🚀 **PR-2 frontend Carteira** (este PR, `feat/conta-pr2-carteira-fechamento`): chip "Sem conta", filtro, nota no card — pendente merge.
- 🔧 PR-3 (projeção unificada no Cockpit) e PR-4 (navegação/bottom nav) pendentes.
- 🚀 Deploy web (Vercel) e API (Fly) continuam automáticos pelo `main`.
- 🚧 PR-3 em execução (`feat/conta-pr3-projecao-unificada`): narrativa de projeção
  unificada entre Cockpit e Conta (Conta vira resumo com deep-link para Cockpit;
  Cockpit exibe o mesmo veredito de horizonte multi-mês).
- 🔧 PR #174 (draft, `feat/conta-unificada`): Visão Conta unificada (Lista + Por
  categoria/projeto, filtros com "Limpar filtros", expandir fatura inline) e
  lançamento mobile "+" em 3 modos (Escrito categoria-first / Voz / Foto).
  Backend read-only/aditivo (receipt persiste `descricao`; sem migration).
- ✅ PR-1 (linha mobile da Conta) e PR-2 (Carteira backend/frontend) entregues no
  ciclo Visão Conta Hub; fechamento frontend da Carteira consolidado no PR #204.
- ▶ PR-3 (`feat/conta-pr3-projecao-unificada`, PR #205) e PR-4 (`feat/conta-pr4-nav-actions`, PR #207)
  em revisão: narrativa única de projeção entre Conta/Cockpit e migração de navegação
  para Conta como hub.
- 🔄 Mudança de direção (PO, 2026-07-22): decisões de compra/financiamento passam a
  ancorar na projeção consolidada do PESSOAL (épico "Planejador de Compras",
  issue #271). PR #269 (cenários de COMPRA sobre o motor de Simulação) fechado sem
  merge; substituído por este épico.
- ✅ **Pré-requisito do épico — financing→caixa** (PR #276, mergeado):
  `FinancingInstallment` passa a materializar uma despesa PLANEJADA avulsa (janela
  rolling de 12 meses) no projeto dono (CASA/CARRO) — antes desta correção, a
  parcela real de um financiamento era **invisível** no caixa consolidado/Conta
  (violava a regra 14). Parcelas pagas ou vinculadas via rateio ao PESSOAL nunca
  são tocadas por uma edição posterior do contrato.
- ✅ **Épico Planejador de Compras — PR-A** (PR #280, mergeado): extração pura de
  `buildPriceSchedule`/`buildSacSchedule` de `financing.service.ts` para
  `packages/domain` (`calculations/loan-schedule.ts`) e nova função central
  `applyPurchasePlan` (`calculations/purchase-plan.ts`) — zero UI. Testes de
  paridade garantem que a parcela nº1 hipotética do domain é idêntica à do
  `financing.service` real (PRICE e SAC). `financing.service.spec.ts` não foi
  editado (gate do épico).
- ✅ **Épico Planejador de Compras — PR-B** (PR #281, mergeado): modelos
  `PurchaseScenario`/`PurchaseScenarioItem` (com `deletedAt` em ambos) +
  migration + API CRUD (`purchase-planner.service/controller/module`) sob
  `@RequireModule('monthlyOverview')` — que já é exclusivo de PESSOAL via
  `TYPE_MODULES`, satisfazendo sozinho o critério "rota só PESSOAL, 403 para os
  demais tipos". Cálculo (`applyPurchasePlan`) fica só no client (PR-C); a API
  é puro CRUD, sem backfill.
- 🚀 **Épico Planejador de Compras — PR-C** (`feat/ux-v2-planejador-pr-c`, este PR,
  fecha o épico #271): UI do Planejador (`/projects/:id/planejador`, PESSOAL-only
  via `hasFeature('monthlyOverview')`), reaproveitando o slug já criado em
  `module-navigator.ts` (single source of truth para sidebar desktop + sheet
  mobile "Mais"). Cenários com toggle por item, horizonte 3/6/12 recalculado
  100% no client (`useMemo` + `applyPurchasePlan`, sem novo fetch da baseline
  ao trocar horizonte), veredito + mini-barras no padrão visual do runway do
  Cockpit (mesmo `COCKPIT_THEME`). CTA **"Simular impacto"** adicionado à tela
  `/price-compare` (COMPRA) faz o deep-link cross-project para o Planejador do
  PESSOAL (`?priceItemId=&projectId=`), pré-carregando nome e melhor preço do
  item monitorado (fallback: preço de referência). Conversão só por navegação
  (CTAs já existentes "Comprar agora"/"Criar financiamento") — o Planejador
  nunca lança nada sozinho. e2e cobre criação de cenário + item financiamento +
  troca de horizonte sem novo fetch, e a pré-carga via deep-link.
- ✅ **Detalhe e manutenção segura do rateio** (issues #423 e #428): `GET
  :id/rateio` aceita como âncora a fonte ou um alvo, resolve o
  `sourceExpenseId` canônico e enumera o conjunto completo de
  `RateioAllocation` autorizado (não só a primeira, que é o que
  `linkedExpenseId` reflete). Na fonte PESSOAL, o `RatearCompraModal`
  pré-carrega as alocações existentes visíveis para edição, em vez de aparentar
  um rateio novo; alocações removidas impedem substituição silenciosa e o
  servidor reautoriza todos os participantes na gravação (fail-closed).
  No alvo REFORMA, **Edição completa** permanece alcançável nas visões Mês e
  Categoria também em mobile 375/390 px, mas exibe o rateio canônico
  estritamente somente-leitura: editar e desratear continuam exclusivos da
  fonte PESSOAL.
  Alvos fora da lente de acesso do requisitante **derrubam o detalhamento
  inteiro** (#448 B1b): a lista só é devolvida quando TODOS os participantes
  estão autorizados e a soma fecha exatamente. Caso contrário a resposta é a de
  uma compra **nunca rateada** — sem flag, contagem, soma ou metadado, com
  `rateadoCents: 0` e a sobra valendo o total. Lista filtrada não serviria: como
  a escrita exige que as alocações fechem o total, publicar parte dela ao lado
  do total entregaria a soma oculta por subtração. Alvo removido também colapsa
  a resposta, inclusive para quem enxerga o projeto dele. Na Visão Conta do PESSOAL, a fonte conta uma
  única vez e mantém sua origem Carteira/conta/cartão; todos os alvos pagos são
  excluídos de `saidas`/`saiuMes` pelo conjunto canônico de `RateioAllocation`,
  não apenas pelo primeiro `linkedExpenseId`. Exemplo verificado: fonte de R$
  1.000 com alvos de R$ 450/R$ 300/R$ 250 resulta em Carteira: −R$ 1.000 e
  `saiuMes`: R$ 1.000. O vínculo (`linkedExpenseId`) da fonte continua
  bloqueado enquanto ela estiver rateada.
- ✅ **Origem do pagamento na REFORMA** (`feat/reforma-paid-origins`, #424):
  endpoint read-only `GET .../expenses/paid-origins` deriva, por
  parcela, qual cartão/conta **do PESSOAL** (via `CrossProjectSettlement`/
  `RateioAllocation`/vínculo) pagou cada alvo cross-project; badge somente-
  leitura na REFORMA (`MonthlyExpenseView`/`CategoryExpenseView`). Sem
  mutação financeira, sem alteração de schema/quitação — não substitui o
  fluxo de conciliação do §2 de `quitacao-parcela-cross-project.md` (que
  segue como o único caminho que muda estado). Ver
  `docs/quitacao-parcela-cross-project.md` §10 para o contrato.

## 2) Fontes de verdade

Antes de iniciar qualquer trabalho nessa área, ler:

1. `docs/cockpit-caixa-real.md` (contrato do caixa real §10).
2. `docs/visao-conta-faturas.md` (faturas, neutros, matching e quitação explícita).
3. `AGENTS.md` (regras operacionais e convenções de execução).

## 3) Checklist rápido para nova sessão (evitar diagnóstico errado)

```bash
git --no-pager branch -vv
git --no-pager log --oneline -20
git --no-pager log --oneline --all | grep -E "feat\\(cockpit\\): Fase [1-6]|feat\\(cockpit\\): caixa real"
```

Se houver divergência entre handoff/plano antigo e git, **o git é a verdade**.

## 4) Escopo aberto (não confundir com regressão)

- robustez/observabilidade do motor financeiro em produção;
- melhorias de orçamento/insights e automações de conciliação/importação;
- refinamentos de UX não bloqueantes.

## 5) Regra operacional

Se uma próxima sessão alterar status/escopo desta área, atualizar este arquivo no mesmo PR.

## 6) Categorização na importação — learning loop (estado 2026-09-03)

**Histórico:** o diagnóstico anterior de "zero linhas categorizadas em produção / motor
emperrado" (ver `docs/archive/estado-atual-historico-2026.md`) está **RESOLVIDO** pelos PRs
abaixo — não é mais estado atual.

- ✅ **Loop de aprendizado ponta a ponta na importação de extrato + fatura** (#665, #582 AC7):
  sobrescrever a categoria de uma linha durante o preview de extrato/fatura cria uma regra
  `MerchantCategory` **MANUAL, tenant-scoped** ("corrija uma vez") — a mesma disciplina da
  regra 16.
- ✅ **Categorização em lote por IA no preview** (#660): `classifyForImport` classifica as
  linhas do preview de extrato/fatura em batch.
- ✅ **Sinalização no preview** (#661): banner de degradação (`classificationStatus`) quando a
  classificação falha/parcial + chip de fonte por linha (`categoriaFonte`).
- ✅ **Precedência e confiança corrigidas** (#669, reabertura de #582): `pickLearnedRow` com
  encoding de tier único — `MANUAL tenant > AI tenant ≥ 0.8 > MANUAL global`; **AI global
  nunca é aplicada**; `validateGeminiChunk` rejeita resposta do Gemini reordenada/incompleta/
  inválida (índice `i` 1-based + split gate).
- ✅ **#582 FECHADA.**

### Pendências (não confundir com regressão)

- 🚧 **#659 (UI do importador de recibo/Carteira sem vínculo) — AINDA ABERTA.** A **paridade
  de classificação na API** já entrou (`cf511f7d`: banner + chip + `<select>` de categoria +
  "corrija uma vez"), mas o QA de jornada achou que `ImportWithoutAccountModal` só monta via
  `ImportMassStep` quando o passo da jornada tem `experience:'SUMMARY'`; o onboarding padrão do
  PESSOAL usa `FULL`, então **o modal não é alcançável pelo usuário no build publicado**. PR
  #670 corrige o alvo de toque de 44px e esconde o `<select>` nas linhas que não estão sendo
  importadas, mas a **alcançabilidade (Gap 1) é decisão de produto em aberto**.
- ⏸️ **`AI_RULE_MIN_CONFIDENCE = 0.8` é hipótese operacional.** Recalibrar exige dados reais
  rotulados de correção do usuário — follow-up parado, bloqueado em coleta de dados, issue
  ainda não aberta. Não é opção C / U6b.
- ⏸️ **`expenseTypeOverride`** (aprendizado para os ~20 ExpenseTypes sem equivalente em
  `MerchantCategory`) — melhoria opcional parada. Não é opção C / U6b.
