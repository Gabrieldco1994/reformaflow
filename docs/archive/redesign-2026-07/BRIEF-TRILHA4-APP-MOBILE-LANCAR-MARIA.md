# BRIEF DE EXECUÇÃO — Trilha 4: App Mobile "direto" (Lançar + Maria)

**Data:** 2026-07-12
**Base:** `main` APÓS merge da Trilha 1 (Fase C-visual / cockpit inovador mobile). Não iniciar antes.
**Branch sugerido:** `feat/app-mobile-lancar-maria` (worktree próprio)
**Escopo:** 1–2 PRs (PR-A: Lançar + casca; PR-B: Maria), presentation-first
**Protótipos aprovados (fonte de verdade visual):**
- `docs/prototipo-mobile/app-lancar.html` (Lançar, valor-primeiro em 3 toques)
- `docs/prototipo-mobile/app-maria.html` (Maria, copiloto de primeira classe)
- `docs/prototipo-mobile/app-despesas.html` (Despesas v2 — carteira de cartões + lista moderna)
- `docs/prototipo-mobile/cockpit-inovador-c3.html` (Hoje — JÁ implementado pela Trilha 1; só referência de linguagem visual)

---

## 🎯 Objetivo

Completar o app "direto" de 3 superfícies no mobile: **Hoje** (Trilha 1) · **Lançar** · **Maria**.
Princípio de produto do Gabriel: **APP = direto (relance, lançar rápido, perguntar) · WEB = analítico**.
Tudo dentro de `apps/web` (a separação é de EXPERIÊNCIA, não de repositório): navegação mobile
reduzida a 3 destinos + PWA instalável. Detalhe analítico NÃO entra — link "abrir no painel completo".

---

## 🧠 O QUE JÁ EXISTE — APONTAR, NÃO RECRIAR (a regra mais importante desta trilha)

O pipeline de voz/copilot está construído e testado dos dois lados. O trabalho desta trilha é
**dar uma superfície mobile nova a esse pipeline**, não reconstruí-lo. Antes de escrever qualquer
linha da Maria, ler estes arquivos:

### Backend (NÃO tocar, exceto se um item de escopo mandar explicitamente)
| O quê | Onde | Nota |
|---|---|---|
| Endpoint do copiloto | `apps/api/src/agent/agent.controller.ts` → `POST /agent/chat` | recebe `messages[]` + `projectId?`; devolve `{reply, toolsUsed, provider}`; ACL por tenant/projeto via `accessibleProjectScope` |
| Loop LLM + tools | `apps/api/src/agent/agent.service.ts` + `agent/llm/` | tool-calling; NÃO criar outro loop |
| 17 tools | `apps/api/src/agent/tools/agent-tools.service.ts` | `create_expense`, `find_expenses`, `update_expense`, `get_upcoming`, `get_financial_overview`, `get_account_balances`, `get_expenses_by_category`, `list_payment_methods`, etc. |
| **Parse de dinheiro falado** | `apps/api/src/agent/tools/money-parse.ts` (`parseSpokenMoney`) | **`valor` nas tools é STRING** (vírgula = decimal); conversão ×100 acontece SÓ no `expense.create`. Isso mata o bug 100x — NÃO "melhorar" mandando número |
| Dedup de criação | `create-expense-dedup.spec.ts` | criação repetida é protegida; specs existentes devem continuar verdes |
| TTS (voz da Maria) | `apps/api/src/tts/tts.controller.ts` → `POST /tts/synthesize` e `POST /tts/stream` | VibeVoice no Modal (`deploy/modal/`); formatação de fala em `speech-format.ts` |

### Frontend (REUSAR os hooks; as superfícies novas são só camada visual)
| O quê | Onde | Nota |
|---|---|---|
| Conversa + invalidação | `apps/web/src/components/agent/useFinancialAgent.ts` | mantém o histórico, chama `/agent/chat`, e ao detectar `WRITE_TOOLS` (`create_expense` etc.) **invalida as queries certas** (`monthly-overview`, `expenses`, `credit-cards`…) → o herói do Hoje atualiza sozinho após lançar. NÃO duplicar essa lista |
| STT (fala → texto) | `apps/web/src/components/agent/useSpeechRecognition.ts` | reusar como está |
| Voz 100% (overlay) | `apps/web/src/components/agent/VoiceAssistantOverlay.tsx` | fluxo fala→agente→TTS já funciona; a tela Maria nova pode absorvê-lo ou embuti-lo |
| Chat widget atual | `apps/web/src/components/agent/FinancialAgentWidget.tsx`, montado em `projects/[projectId]/_components/AppShell.tsx` | a tela Maria SUBSTITUI este widget no mobile (ele some do viewport `<lg`); no desktop ele fica |

> Anti-padrões proibidos: segundo endpoint de chat; segundo parser de valor; enviar `valor` numérico;
> lista própria de invalidação; STT/TTS novos; "confirmação" client-side que edita o texto antes de
> mandar pro agente.

---

## 🧱 Regras invioláveis (mesmas das trilhas 1–3)

1. **Presentation-first.** Motor canônico = `monthly-overview`. PROIBIDO tocar `derive.ts` (lógica),
   services da API e schema Prisma — exceto os 2 pontos explícitos do escopo (§Item 2 fatura e §Item 3
   confirmação), que são cirúrgicos e descritos abaixo. Funções puras novas só em `_lib/*.ts` + testes.
2. **Piso tipográfico v3.1:** nada <11px; valores de lista ≥15px; alvos ≥44px; validar em 360px E 390px.
   (Cicatriz recente: chips com valor em 10px dentro do chip = "espremido"; o protótipo atual já corrige.)
3. **Antes de criar componente, grep** (cicatriz do FAB duplicado). Candidatos a reuso listados por item.
4. **QA visual obrigatória no final:** login real (gabrieldco) + dados reais, mobile 390px e desktop.
   tsc/testes verdes NÃO bastam. Dado real relevante: cartões **Mastercard •5876 (fecha 5, vence 12)** e
   **Personnalité •7777 (SEM closingDay cadastrado — o estado de alerta do protótipo é real)**.
5. Páginas ≤400 linhas — `_components/` + `_hooks/` + `_lib/`.
6. Commit por entrega, mensagens `feat(app-mobile): ...`.
7. Cicatriz sticky/overflow: `overflow-y-auto` + `overflow-x-visible` clipa tooltips — não reintroduzir.

---

## 🚀 Entregas (ordem)

### 1. Casca do app: tab bar 3 itens + PWA (PR-A)
- No viewport `<lg`, navegação = tab bar fixa **Hoje · Lançar (FAB central) · Maria** como no protótipo.
  Hoje → `/projects/[id]/monthly`; Lançar → abre o sheet (item 2); Maria → rota nova (item 3).
- As demais rotas continuam existindo (deep-links, "abrir no painel completo"), só saem da navegação mobile.
- PWA: `manifest.json` (nome, ícone, `display: standalone`), meta theme-color. **Sem service worker de
  cache nesta trilha** (offline é trilha futura — não abrir essa caixa).
- Reuso: verificar a tab bar/mobile-nav que a Fase B/C do redesign já criou antes de fazer outra.

### 2. Sheet "Lançar" valor-primeiro (PR-A) — protótipo `app-lancar.html`
- Bottom-sheet full-height: teclado numérico próprio, valor gigante, chips de origem (contas e cartões
  REAIS do projeto PESSOAL via API `bank-accounts`/`credit-cards`), parcelas condicionais (só cartão),
  descrição com categoria sugerida, confirmação otimista com desfazer.
- **Categoria sugerida**: reusar o classificador existente (módulo `merchant-classifier` — grep pelo
  endpoint; a Fase de categorização por IA do PR #66 já expõe esse fluxo). Sem chamada ao Gemini nova.
- **Criação**: usar o MESMO caminho de criação de despesa do modal atual (mutation existente de
  `expenses`) — o sheet é uma pele nova sobre a mutation velha. Invalidação de queries idem.
- **Fatura de destino ("cai na fatura que fecha X e vence Y")**: função pura NOVA
  `_lib/fatura-destino.ts` com testes: `(dataCompra, closingDay, dueDay) → {fecha, vence}` usando a
  regra já decidida **`dia >= closingDay` → mês seguinte**. `closingDay` null → estado âmbar
  "configure o cartão" (como no protótipo). NÃO inventar derivação de fatura no backend aqui (isso é a
  visão #2 / Fase E — fora de escopo); esta função é presentation-only.
- Desfazer = deletar a despesa recém-criada (soft-delete padrão) dentro da janela do toast.

### 3. Tela "Maria" (PR-B) — protótipo `app-maria.html`
- Rota mobile de chat em tela cheia sobre `useFinancialAgent` + `useSpeechRecognition` (REUSO, ver tabela).
- **Abertura proativa**: os cards do "Maria percebeu" (Trilha 1) viram a 1ª mensagem. Se o componente de
  insights da Trilha 1 expõe os dados, reusar; senão, derivar de `get_upcoming`/`monthly-overview` já
  carregados — sem endpoint novo.
- **Respostas com cartão**: renderizar respostas do agente com as peças visuais do protótipo (veredito
  verde/vermelho, mini-barras). Implementação pragmática: detectar `toolsUsed` e montar o cartão com os
  dados da resposta — NÃO pedir JSON estruturado novo ao LLM nesta trilha.
- **Lançar falando com conferência (o único ajuste de backend permitido no PR-B):** hoje o agente cria
  direto via `create_expense` (com instrução de "confirmar quando ambíguo" no prompt). O protótipo exige
  conferência SEMPRE antes de criar. Caminho recomendado (decidir com o Gabriel se divergir): ajustar a
  instrução do system prompt/tool description em `agent-tools.service.ts` para que o agente SEMPRE
  descreva a despesa e aguarde confirmação antes de chamar `create_expense`, e o front renderiza essa
  resposta como o cartão Confirmar/Editar (Confirmar = mandar "confirmo" na conversa; Editar = abrir o
  sheet Lançar pré-preenchido). Zero mudança de contrato HTTP; specs de dedup continuam verdes.
- **Voz**: mic → `useSpeechRecognition`; resposta falada opcional via `/tts/stream` (toggle). O
  `VoiceAssistantOverlay` pode ser absorvido pela tela ou permanecer como modo "mãos livres".

---

### 4. Tela "Despesas" mobile (PR-A ou PR-C) — protótipo `app-despesas.html`
- Reachable pelo Hoje ("ver despesas") e por deep-link; volta com ‹. NÃO entra na tab bar (3 itens fixos).
- **Herói claro** "Gastei de verdade" = gasto real do mês (consumo — `isConsumptionNeutralExpenseType`
  fora) com as 3 linhas: no cartão / saiu da conta (caixa §10, inclui neutros) / neutros (não somam).
  Regra de layout: valor monetário SEMPRE em linha própria (rótulo esq., valor dir. `nowrap`) — nunca
  dividindo largura com badge/chip/outro valor (erro corrigido 3× no protótipo).
- **Carteira**: carrossel de cartões "físicos" (gradiente, chip, •••• last4, bandeira) com a fatura
  aberta NO cartão + badge sólido de status (aberta=âmbar/paga=verde/configurar=vermelho). Status "paga"
  vem de `matchPaidInvoices`/`computePaidInvoiceKeys` via `getAccountView` — NÃO reimplementar matching.
  Cartão sem `closingDay` (Personnalité •7777 real) = badge "configurar", nunca fatura inventada.
- **Filtros**: chips de origem (Todos/conta/cartões = `origin-items-yearly?kind=all`), chips de categoria,
  toggle "mostrar neutros" (neutros aparecem esmaecidos/tracejados com etiqueta do porquê, nunca somam).
- **Lista**: cards flutuantes por dia com subtotal de consumo; tile pastel por categoria; selos parcela
  `4/10`, `espelho · <projeto>`, estorno em verde (+).
- Fonte de dados: `getAccountView` + `getOriginItemsYearly` (endpoints existentes) — zero motor novo.
  A view "Despesas" atual do projeto (`expenses/page.tsx` com views category|month|project) fica
  intocada no desktop; esta tela é a cara mobile.

## ✅ Critérios de aceite

1. Fluxo mínimo do Lançar: teclar valor → tocar recente → Lançar = despesa criada, herói do Hoje
   atualizado sem reload (invalidação via lista existente), desfazer funciona.
2. Cartão sem `closingDay` (Personnalité •7777 real) mostra o alerta âmbar, nunca uma fatura inventada.
3. Falar "quarenta e cinco no mercado no mastercard" na Maria → cartão de conferência com R$ 45,00 /
   Supermercado / Mastercard •5876 → Confirmar cria a despesa (uma vez só — dedup) → resposta cita a
   fatura de destino.
4. `valor` trafega como string até `parseSpokenMoney` (conferir no payload real — critério anti-bug-100x).
5. Piso tipográfico v3.1 em 360px e 390px nas duas telas; screenshots lado a lado com os protótipos.
6. Desktop (`lg+`) visualmente intacto: cockpit web analítico e FinancialAgentWidget como estão hoje.
7. `tsc --noEmit` verde nos 3 pacotes; specs existentes do agent/tts intactos; testes novos para
   `fatura-destino.ts`.
8. Despesas: gasto real do herói EXCLUI neutros e aporte; toggle neutros nunca altera o total; status
   "paga ✓" bate com a Visão Conta desktop para o mesmo mês (mesmo motor, mesmo número).

## 🔍 QA visual final (obrigatória)

Login real + dados reais. Roteiro: instalar o PWA na tela inicial (iOS Safari + Android Chrome se
possível), percorrer Hoje → Lançar → Maria pela tab bar, executar os critérios 1–4 com o banco real,
comparar cada tela com seu protótipo aprovado. Divergiu do protótipo = bug.
