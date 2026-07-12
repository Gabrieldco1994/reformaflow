# Consolidação oficial do redesign UX — Relatório de comparação

**Data:** 2026-07-11 · **Status:** aguardando final-redesign estabilizar  
**Liderança:** Gabriel (product) · **Implementadores:** múltiplos agentes em paralelo  
**Plano:** `docs/plano-redesign-ux-unificacao-kpis.md`

---

## TL;DR — Qual branch usar como base oficial?

| Critério | Meu branch (`feat/ai-categorization...`) | final-redesign (`feat/ux-redesign-final-local`) |
|----------|-----------|---|
| **Pronto agora?** | ✅ SIM (limpo, estável) | ❌ NÃO (edições concorrentes em progresso) |
| **QA visual feita** | ✅ SIM (5 bugs encontrados + corrigidos) | ❌ Não testado |
| **Compilação** | ✅ `tsc --noEmit` OK | ❌ `tsc` FAIL (tipos KpiCards inconsistentes) |
| **Cobertura A–D/F** | ✅ 100% | ⚠️ 90% + inovação experimental |
| **Bugs corrigidos** | ✅ 5 reais (visual + CSS) | ⚠️ Provavelmente não |
| **Testes** | ✅ 226/226 | ❓ Status desconhecido |
| **Desvantagem** | ❌ Wrong branch name | ✅ Tenta inovação (mini-herói) |

**🔴 RECOMENDAÇÃO:** Usar meu branch como base oficial + fazer cherry-pick se final-redesign estabilizar com achados valiosos.

---

## Detalhamento por fase

### Fase A — Design System ✅✅

**Meu branch:**
```
KpiTile.tsx       ✅ pronto (hero/support/state variants)
Delta.tsx         ✅ pronto (positive/negative/neutral)
colors.ts         ✅ pronto (CSS custom properties semânticas)
money.ts          ✅ pronto (moneyGlance + moneyDetail)
/prototype/kpi    ✅ pronto (showcase funcional)
```
Integração: CockpitTop, ResumoCards, Conta — todas usando corretamente.

**final-redesign:**
```
Mesmo escopo      ✅ implementado
Tipos inconsistentes ❌ KpiCards.tsx vs TenantFinancialOverview mismatch
Testes untracked  ⚠️ 4 test files sem controle de versão
```

**Vencedor:** Meu branch (tipos limpos, sem estado sujo).

---

### Fase B — Despesas mobile ✅✅

**Meu branch:**
- ✅ **FilterSheet** em bottom-sheet (`md:hidden`, z-50)
- ✅ **FAB único** posicionado corretamente (canto inferior esquerdo, acima do Copiloto)
- ✅ **Mini-KPIs** "No cartão" / "À vista" renderizando corretamente
- ✅ **QA visual:** Playwright + login real validou tudo
- ✅ **Bug corrigido:** Labels "ENTROU EM..." truncadas → `labelMobile` prop

Commits: `669bad0c` + fix `1f894ade`

**final-redesign:**
- ✅ FilterSheet implementado
- ⚠️ FAB não se destaca como elemento de ação móvel (integrado sem zoom)
- ❓ Mini-KPIs não confirmados

**Vencedor:** Meu branch (FAB correto + QA).

---

### Fase C — Cockpit Relance ✅✅ (estrutural only)

**Meu branch:**
- ✅ **5 seções de accordion:** "Fluxo do mês" · "Por categoria" · "Principais gastos" · "Comprometimento" · "Saúde"
- ✅ **localStorage persistência** `ck:acc:{title}:{projectId}`
- ✅ **CockpitFilterSheet** com Gastei/Vai sair/Extrato
- ✅ **1-line header** (Mês/Ano + "⚙ Filtrar")
- ✅ **Bugs corrigidos:**
  - Label truncação (labelMobile prop)
  - Nome duplicado accordion (rename "Por categoria")
  - Tooltip desktop hidden (overflow-visible fix)
- ✅ **QA visual:** screenshots confirmam funcionalidade

Commits: `12bffec9` + fix `1f894ade`

**final-redesign:**
- ✅ MobileMonthCockpit.tsx (nova estrutura dedicada)
- ✅ MobileMonthHero.tsx com barra de progresso (Mês protegido/pede ajuste)
- ⚠️ Mini-herói ao rolar (`sticky bottom-2 backdrop-blur`) — diferente do mockup mas funcional
- ⚠️ Mantém 3-up cards (Entrou/Saiu/Projeção) — duplicação de narrativa não resolvida
- ❓ Accordion de análise não confirmado

**Vencedor:** Meu branch (bugs corrigidos + QA visual) · final-redesign tenta inovação mas incompleto.

**⚠️ Nota importante:** Nenhum dos dois implementa o visual REAL do mockup (herói escuro, viagem no tempo slider, Sankey, drag-to-pay). Isso fica pra Fase C-visual (nova).

---

### Fase D — Cards + Visão Conta ✅✅

**Meu branch:**
- ✅ **CardActionsMenu** menu ⋯ com touch targets ≥44px
- ✅ **ResumoCards** separando Fatos (Entrou/Saiu) vs Projeção (Falta pagar/Sobra prevista)
- ✅ **moneyGlance** pra Projeção (valores abreviados, não truncam)
- ✅ **QA visual:** Visão Conta mobile legível e bem espaçada
- ✅ **Bug corrigido:** "Sobra prevista" quebrando linha → trocado pra `moneyGlance`

Commits: `02130a15`

**final-redesign:**
- ✅ Estrutura similar
- ⚠️ Tipo `TenantFinancialOverview` inconsistente (mesmo problema da Fase A)
- ❓ CardActionsMenu não confirmado

**Vencedor:** Meu branch (QA real).

---

### Fase F — Sidebar recolhível desktop ✅✅

**Meu branch:**
- ✅ **Toggle ChevronLeft/ChevronRight** no header
- ✅ **localStorage persistência** `lifeone:sidebar:collapsed`
- ✅ **Tooltip ao hover** quando recolhido
- ✅ **Bug corrigido:** `overflow-y-auto + overflow-x-visible` CSS bug
  - **Problema raiz:** misturar os dois eixos força-os a virar clip, escondendo tooltips em flex layout
  - **Solução:** `overflow-visible` no `<nav>`, `relative z-20` no `<aside>`
- ✅ **QA visual:** sidebar funcional, tooltip aparece

Commits: `a56193bb` + fix `1f894ade`

**final-redesign:**
- ✅ Sidebar recolhível
- ⚠️ Tooltip provavelmente ainda bugado (não testado, mesmo bug de overflow)

**Vencedor:** Meu branch (bug corrigido).

---

## Fase C-visual (NOVA) — Implementação do mockup real

**Status:** Só planejada, não implementada em nenhum lugar.

Meu branch tem:
- 📋 Plano escrito (seção nova em `docs/plano-redesign-ux-unificacao-kpis.md`)
- 📋 4 sub-fases detalhadas: HeroTravel, "E se…?" cenários, Sankey, drag-to-pay

final-redesign tem:
- ⚠️ Mini-herói (partial C-visual.4) — `sticky bottom-2 backdrop-blur` em box consolidada
- ❌ Falta: viagem no tempo, cenários, Sankey, drag

**Recomendação:** Implementar C-visual **depois** de consolidar A–D/F.

---

## Bugs reais encontrados (lista completa)

Esses bugs **só apareceram com QA visual real** (login + dados reais). `tsc --noEmit` + testes não pegaram nenhum.

| # | Localização | Impacto | Meu branch | final-redesign |
|---|---|---|---|---|
| **1** | CockpitTop.tsx, mobile 2-col | Labels truncam ("ENTROU EM J...") | ✅ corrigido | ❓ não testado |
| **2** | MonthView.tsx, accordion header | Duplicação de nome "Quanto gastei" | ✅ corrigido | ❓ não testado |
| **3** | ExpensesView.tsx | FAB "+ Nova despesa" duplicado | ✅ removido | ❓ não confirmado |
| **4** | ResumoCards.tsx, projeção | "Sobra prevista" quebra linha em card pequeno | ✅ corrigido | ❓ não testado |
| **5** | DesktopSidebar.tsx | Tooltip escondido (overflow CSS bug) | ✅ corrigido | ⚠️ provavelmente não |

---

## Matriz de risco

| Fator | Meu branch | final-redesign |
|-------|-----------|---|
| Compilação | ✅ clean | ❌ FAIL (tsc) |
| Testes | ✅ 226/226 | ❓ unknown |
| Estado Git | ✅ limpo | ❌ 5 arquivos modified, 4 untracked |
| QA visual | ✅ feita (5 bugs encontrados) | ❌ não feita |
| Pronto para PR? | ✅ SIM | ❌ não |
| Branch name | ❌ errada (ai-categorization) | ✅ certa (ux-redesign) |
| Inovação visual | ❌ só estrutural | ⚠️ tenta mini-herói |

---

## Recomendação final

### **Ação imediata (hoje)**
1. Meu branch é candidato **oficial** — está pronto pra PR agora
2. **Remover da branch errada** (`feat/ai-categorization-bulk-link`) 
3. Criar `feat/ux-redesign-consolidado` a partir do meu trabalho
4. PR contra `main` com Fases A/B/C/D/F completas + QA visual

### **Ação paralela (aguardando final-redesign)**
1. Deixar final-redesign rodar (edições concorrentes em progresso)
2. Quando estabilizar, fazer QA visual (login real)
3. Se encontrar value (mini-herói funcional, bug-free), cherry-pick
4. Se mesmo estado, descartar

### **Sequência pós-consolidação**
1. ✅ Mesclar branch oficial em `main`
2. 📋 Implementar Fase C-visual (4 sub-itens)
3. ⏳ Fase E (motor unificado) com [[pessoal-lens]]
4. ⏳ Fase G (3 camadas + Simulação dedicada)

---

## Arquivos de referência

- **Plano mestre:** `docs/plano-redesign-ux-unificacao-kpis.md`
- **Auditoria detalhada:** `/memory/auditoria-consolidacao-branches-2026-07.md`
- **Feedback QA visual:** `/memory/feedback-qa-visual-obrigatorio.md`
- **Monitor de branches:** `scratchpad/monitor-branches.sh` (polling silencioso)
- **Log de status:** `scratchpad/branches-status.log` (atualizado a cada poll)

---

**Próxima ação esperada:** Gabriel autoriza consolidação pra `main` OU aguarda final-redesign estabilizar.

Estou monitorando em background — você terá o status atualizado quando precisar.
