# Plano Mestre v2 — UX de Redução de Trabalho (Cockpit PESSOAL)

**Data:** 2026-07-20 · **Status:** aprovado pelo PO (Gabriel) · **Antecessor:** `docs/plano-visao-conta-hub-2026-07.md` (v1 — Conta hub, concluído nos PRs #204/#205/#207)
**Escopo aprovado:** itens 1, 2, 4, 5 e 6 da análise de UX pós-v1. **Fora de escopo:** canal WhatsApp (item 3 — plano próprio em `whatsapp-channel-plano`), gamificação, dark mode, push/PWA.

---

## 0. Tese e pré-requisitos

O v1 resolveu a **arquitetura de informação** (Conta = linha do tempo única; Cockpit = saúde/projeção; Despesas/Recebimentos = drill-downs). O v2 ataca o próximo gargalo: **o trabalho manual do usuário** — conciliar, categorizar, decidir o que fazer com um alerta, e a rampa do usuário novo.

**Pré-requisito duro:** PRs #205 e #207 mergeados (rebases sobre o main pós-#204). Nenhum PR deste plano abre antes disso.

**Regras de processo (herdadas do v1, não negociáveis):**
- 1 workstream = 1 PR = 1 branch própria de `origin/main`, worktree próprio (regra 12), `--base main` (regra 11).
- Zero bundling entre workstreams; zero migrations fora das explicitamente previstas (com backup — regra 1).
- QA visual real (375/390/1280px, login real, dados reais, screenshots no PR) é **gate de merge**; merge é humano (PO), nunca do agente. Incidentes #202/#203 no §10 do plano v1 são o precedente.
- Docs no mesmo PR: `manual-do-aplicativo.md` + `estado-atual-cockpit-pessoal.md` + este plano (marcar entrega).

**Ordem de execução:** W1 → W2 → W3 → W4 → W5 (W3 é rápido e pode rodar em paralelo com W2 se houver capacidade, pois não compartilham arquivos).

---

## W1 — Fila de Pendências ("Precisa de você") — PR-A

**Tracking:** issue #214 (sub-issue do épico #213).

**Problema:** hoje a conciliação é garimpo — o usuário precisa *encontrar* o item sem conta/sem categoria na lista. **Solução:** uma caixa de entrada única de pendências financeiras, resolvível item a item com 1 toque.

### Backend
- **Reusar** o módulo existente `apps/api/src/pendencia/` (controller já tem GET/POST) como agregador; NÃO criar módulo paralelo. O architect decide se a agregação entra nele ou em endpoint novo `GET /projects/:id/pendencias/financeiras`.
- Fontes da fila (cada uma com `tipo`, `count` e itens ordenados por impacto R$):
  1. **Sem conta** (Carteira): saídas do mês sem cartão/conta — mesma definição estrutural do `getAccountView` (`origem: carteira`).
  2. **Sem categoria**: movimentos com tipo `OUTROS`/vazio cuja descrição tem sugestão do merchant-classifier (ver W2 — no W1 basta listar).
  3. **Fatura a vencer/vencida não paga** (invoice do mês com `realizado=false` e vencimento ≤ 7 dias).
  4. **Parcela foreign pendente de quitação** (`isPendingForeignParcela`).
  5. **Recebimento previsto atrasado** (PREVISTO com data < hoje).
- Contrato: `{ total: number, grupos: [{ tipo, label, count, valorTotal, itens: [...] }] }`. Sem migration — é agregação de dados existentes.

### Frontend
- **Card "Precisa de você (N)"** no topo do Cockpit (mobile e desktop), abaixo do card de caixa; badge com contagem; colapsado quando N=0 (não renderiza).
- Tocar → sheet/painel com os grupos; cada item abre **a ação existente** (chip→vincular/quitar, fatura→PagarFaturaDialog, categoria→confirmar sugestão W2, recebimento→marcar em caixa/reagendar). NENHUM fluxo novo de mutação — só roteamento para modais que já existem.
- Resolver um item remove da fila sem fechar o painel (fluxo "esteira").

### Critérios de aceite
1. Dataset com ≥1 pendência de cada tipo → card mostra N correto e cada item abre o modal certo.
2. Resolver item atualiza fila e telas afetadas (invalidação de queries account-view/expenses).
3. N=0 → card ausente. 4. Testes API do agregador (5 fontes + ordenação) e de componente do painel. 5. Nenhuma mutação nova no backend.

**Agentes:** `architect` (contrato + spec RED, decide reuso do módulo pendencia) → `pessoal-lens` Phase 1 → `backend-expert` + `frontend-expert` → `qa-engineer` → `pessoal-lens` Phase 2 → `doc-librarian`.

---

## W2 — Auto-categorização com aprendizado — PR-B

**Problema:** dezenas de "PIX TRANSF FULANO" caem em **Outros** (visto nos dados reais de produção), degradando categorias, DRE e ticket médio. **Solução:** loop sugerir→confirmar→aprender.

### Backend
- **Reusar** `apps/api/src/merchant-classifier/` (já tem endpoint suggest + specs) e o modelo `MerchantCategory` (prisma/schema.prisma:876; já está em `modelsWithoutSoftDelete` — regra 3).
- Novo comportamento: ao confirmar uma sugestão, persistir a regra (merchant normalizado → tipo de despesa) em `MerchantCategory`; aplicações futuras da regra são automáticas no ingest (extrato/fatura/OCR) e marcadas `fonte: 'regra'`.
- Endpoint de aplicação retroativa opcional (architect decide): "aplicar a N lançamentos semelhantes deste mês" — em transação, respeitando regra 4 ($transaction × $use).
- Normalização do merchant: reusar a que o classifier já usa (não inventar segunda). PIX para pessoa física: a regra aprende por favorecido ("GERALDO" → Mão de Obra) — exigir confirmação explícita do usuário para PF.

### Frontend
- Nos itens "Sem categoria" (lista da Conta e fila W1): chip de sugestão "Alimentação?" com ✓ (confirma, aprende) e ✕ (abre select). Confirmar com 1 toque.
- Ao confirmar, toast "Regra criada: PADARIA X → Alimentação · desfazer" (desfazer remove a regra e reverte o lançamento).
- Tela simples de gestão de regras (lista + excluir) atrás de engrenagem em Análises ou na tela de categorias — **não** na navegação primária.

### Critérios de aceite
1. Confirmar sugestão categoriza o lançamento E cria a regra; próximo ingest com mesmo merchant já vem categorizado (`fonte:'regra'`).
2. Desfazer no toast reverte lançamento + regra. 3. PF (PIX) nunca auto-aplica sem confirmação prévia da regra. 4. Retroativo (se implementado) soma correta e é transacional. 5. Specs do classifier existentes continuam verdes; novos specs do loop confirmar/aprender/aplicar.

**Agentes:** `architect` (spec RED; decisão do retroativo; revisar normalização) → `pessoal-lens` Phase 1 → `backend-expert` + `frontend-expert` → `qa-engineer` (mutation mindset na aplicação de regras — dinheiro não muda, só categoria) → `pessoal-lens` Phase 2 → `doc-librarian`.

**Status desta execução (2026-07-20):**
- [x] Confirmar sugestão na fila (`Sem categoria`) categoriza + cria regra manual; toast com desfazer.
- [x] Chip de sugestão também na Lista da Conta (`MovimentacaoRow`) com confirmação em 1 toque.
- [x] Proteção PIX PF: sem regra manual prévia, permanece `OUTROS` (não auto-aplica).
- [x] Ingest (extrato/fatura/OCR) reaplica regra manual e marca `categoriaFonte: 'regra'` no preview.
- [x] Gestão de regras (listar/excluir) atrás de engrenagem em Análises (não na navegação primária).
- [ ] Retroativo em lote ("aplicar a N semelhantes deste mês") — opcional, não implementado nesta rodada.

---

## W3 — Dieta da tela da Conta — PR-C

**Problema:** a Conta empilha cards → cartões → contas → lista → ticket médio; rolagem longa no mobile. **Solução:** a Conta vira "saldo + o que precisa de você + linha do tempo".

### Mudanças
- `CartoesSection`: colapsar em **carrossel horizontal compacto** (1 linha, scroll-snap; cada tile: apelido, fatura, status, vencimento) com "ver todos" → `/credit-cards`. Desktop mantém grid se couber sem rolagem extra.
- `TicketMedioSection` sai da Conta e passa a viver em **Análises** (rota `dre` ou nova aba na tela de análises — architect decide o menor movimento; a seção é client-side pura, mover sem fork).
- Ordem final da Conta: header/mês → ações → Tenho na conta → cards resumo → linha-resumo de projeção (do #205) → **card Precisa de você (W1, quando existir)** → carrossel cartões/contas → Movimentações. Nada abaixo da lista.
- Piso tipográfico e regra do valor-nowrap valem no carrossel (regra 13; `MovimentacaoRow` é o layout canônico de linha).

### Critérios de aceite
1. Em 375px, da dobra até a lista de movimentações em ≤2 rolagens de tela com dados reais.
2. Carrossel navegável por toque e teclado; nenhum dado de fatura perdido (valor, status, vencimento visíveis por tile).
3. Ticket médio acessível em Análises com os mesmos números de antes. 4. Testes de componentes movidos/alterados; deep-link antigo da Conta continua funcionando.

**Agentes:** `frontend-expert` → `qa-engineer` → `pessoal-lens` Phase 2 → `doc-librarian`. (`architect` só para a decisão de destino do Ticket Médio, pode ser consulta rápida.)

**Status desta execução (2026-07-20):**
- [x] `CartoesSection` em carrossel horizontal compacto no mobile (scroll-snap) + link "Ver todos" para `/credit-cards`; desktop mantém grid.
- [x] `TicketMedioSection` removida da Conta e exibida em Análises (`/dre`) com os mesmos dados do mês.
- [x] Ordem da Conta ajustada: resumo → **Precisa de você** (quando houver) → cartões/contas → movimentações (nada abaixo da lista).
- [x] Teste de componente atualizado para `CartoesSection` (link + filtro).

---

## W4 — Do alerta à ação (runway prescritivo) — PR-D

**Problema:** "Vai dar até dez?" diagnostica ("setembro fica negativo") mas não prescreve. **Solução:** o alerta ganha um degrau de ação.

### Mudanças
- Backend (leve): no cálculo da projeção já existente (**não criar segundo motor** — mesma série `saldoAcumuladoSerie`/`getAccountView` do #205), expor os **maiores planejados restantes** até o mês do crossover: `{ candidatos: [{expenseId, descricao, valor, data, projeto}] }` (top 5 por valor).
- Frontend: no card do runway (Cockpit, mobile+desktop), quando `tone=negative`, botão "**Como fechar no azul?**" → sheet com: quanto falta (valor do pior ponto), os 5 maiores planejados candidatos, e por item as ações **existentes**: adiar (editar data), reduzir (editar valor), remover. Cada ação recalcula a projeção ao fechar (invalidação de query).
- Nenhuma sugestão automática de corte específico tipo aconselhamento — o app mostra os maiores itens e o usuário decide (linguagem: "os 5 maiores gastos planejados até lá", nunca "corte X").

### Critérios de aceite
1. `tone=negative` → botão presente; `positive` → ausente.
2. Sheet lista até 5 planejados corretos (maiores, dentro da janela até o crossover, excluindo neutros e faturas agregadas).
3. Editar/adiar um item pelo sheet atualiza a projeção na volta. 4. Testes do seletor de candidatos (janela, exclusões, ordenação) e do gate por tom.

**Agentes:** `architect` (spec do seletor de candidatos — janela/exclusões são o risco) → `pessoal-lens` Phase 1 e 2 → `backend-expert` + `frontend-expert` → `qa-engineer` → `doc-librarian`.

---

## W5 — Primeira experiência (rampa do usuário novo) — PR-E

**Problema:** usuário novo no PESSOAL vê zeros e uma tela densa; o "aha" (gastos aparecendo sozinhos) está escondido. **Solução:** onboarding aponta para a jornada por foto, e empty states ensinam.

### Mudanças
- **Onboarding**: estender o wizard existente (`feat(onboarding)` #198/#200 e guia de apoio #209 — reusar, não refazer) com o passo "**Traga seus gastos em 1 minuto**": CTA que abre a jornada oficial de lançamento no modo **Foto** (fatura/extrato — `MobileLaunchModeSheet`, zero fork). Pular é permitido e discreto.
- **Empty states** (PESSOAL sem dados):
  - Conta sem movimentos → ilustração leve + "Traga seus gastos por foto" (mesma jornada) + link "ou lance manualmente".
  - Cartões sem cartão → CTA "adicionar cartão" (cadastro rebaixado do v1, o empty state é a porta).
  - Cockpit sem dados → estado "seu mês aparece aqui" com o CTA da jornada, no lugar de zeros e barras vazias.
- Cada empty state é um componente reutilizável (`EmptyState` com ícone/título/CTA) — criar 1 componente base, não N variantes soltas.

### Critérios de aceite
1. Fluxo novo-usuário completo (criar PESSOAL → onboarding → foto → primeiro extrato importado) em QA real, com screenshots de cada passo.
2. Todos os empty states levam a uma ação (nenhum beco sem saída); pular onboarding nunca bloqueia.
3. Usuário com dados NUNCA vê empty state (gate por contagem real, não por flag). 4. Testes dos gates de exibição.

**Agentes:** `architect` (mapa do fluxo novo-usuário) → **todas as lenses Phase 1** (empty states tocam superfícies compartilhadas — CASA/CARRO/REFORMA/COMPRA não podem regredir) → `frontend-expert` (+`backend-expert` só se faltar endpoint de contagem) → `qa-engineer` → lenses Phase 2 → `doc-librarian`.

---

## 6. Documentação (todo PR, mesmo PR)

| Doc | O que muda | PR |
|---|---|---|
| `manual-do-aplicativo.md` | Fila de pendências; loop de categoria/regras; Conta enxuta + ticket em Análises; botão "Como fechar no azul?"; onboarding/empty states | A–E |
| `estado-atual-cockpit-pessoal.md` | Status por entrega | A–E |
| `visao-conta-faturas.md` | Nota: pendências derivam do account-view (mesma fonte, sem motor novo) | A |
| `AGENTS.md` (regras de ouro) | Após W2: "Regra de categoria (`MerchantCategory`) só muda CATEGORIA, nunca valor/caixa; aplicação retroativa sempre transacional." Após W1: "Fila de pendências agrega fontes existentes — nova pendência = nova fonte no agregador, nunca fluxo de mutação novo." | A, B |
| Este plano | Marcar entregas + registrar desvios (se houver) | A–E |

## 7. Issues e tracking

`issue-maintainer`: épico "UX v2 — redução de trabalho" + 5 sub-issues (W1–W5) com os critérios de aceite como checkboxes; fechar via ledger no merge. Referenciar o épico do v1 como concluído.

## 8. Gate de merge por PR (checklist)

- [ ] `cd apps/web && npx vitest run` e `npx tsc --noEmit` verdes; `cd apps/api && npx jest` verde quando tocar API (W1/W2/W4: incluir `monthly-overview.*.spec.ts` + `motor-unico-parity.spec.ts` — invariantes §10 intocados).
- [ ] QA visual 375/390/1280 com screenshots no PR; piso tipográfico; valor nunca divide linha com elemento variável.
- [ ] Docs do §6 no diff. — [ ] PR `MERGEABLE`, base `main` confirmada. — [ ] **PARAR: merge é do PO.**
