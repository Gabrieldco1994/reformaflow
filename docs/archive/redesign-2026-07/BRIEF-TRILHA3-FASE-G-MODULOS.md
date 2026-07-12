# BRIEF DE EXECUÇÃO — Trilha 3: Fase G (3 camadas nos módulos restantes + Simulação)

**Data:** 2026-07-11
**Base:** `main` APÓS merge do PR #75. Não iniciar antes.
**Branch sugerido:** `feat/fase-g-modulos` (worktree próprio)
**Escopo:** 1 PR, presentation-only
**Referência de padrão:** as telas já redesenhadas (Despesas Fase B, Cockpit Fase C,
Conta Fase D) — Fase G replica o MESMO padrão nos módulos que ficaram pra trás.

---

## 🎯 Objetivo

Levar o padrão de 3 camadas — **(1) relance/KPIs no topo · (2) conteúdo em cards ·
(3) detalhe sob demanda (sheet/modal)** — aos módulos que ainda têm o layout velho
(tabelas densas, KPIs ad-hoc, controles espalhados), e dar à Simulação uma página
digna. Consistência: usuário não deve sentir que muda de app ao trocar de módulo.

**Zero motor novo. Zero endpoint novo. Zero schema.** Só apresentação.

---

## 🧱 Regras invioláveis

1. **Presentation-only.** PROIBIDO tocar services da API, schema, `derive.ts`,
   motores de cálculo. Preparação de dado = funções puras novas em `_lib/` + testes.
2. **Componentes canônicos da Fase A são obrigatórios** nas telas tocadas:
   `KpiTile` (hero/support/state), `Delta`, `moneyGlance`/`moneyDetail`,
   cores semânticas (`--ck-pos`, `--ck-neg`, …), `CardActionsMenu` (menu "⋯" ≥44px).
   NÃO inventar variantes novas de KPI/card — se faltar variante, propor no PR, não criar.
3. **Antes de criar, grep se já existe** (cicatriz do FAB duplicado). Ex.: FilterSheet
   de Despesas, `CockpitFilterSheet`, `MobileAccordionSection` — reusar/generalizar,
   nunca copiar-colar uma segunda versão.
4. **Gate por feature, nunca por tipo hard-coded:** qualquer condicional de módulo usa
   `hasFeature(tipo, 'x')` de `@reformaflow/domain`.
5. **Piso tipográfico:** nada <11px; valores de lista ≥15px; alvos ≥44px; validar 360/390px.
6. **Páginas ≤400 linhas** — quebrar em `_components/` + `_hooks/` + `_lib/`.
7. **QA visual obrigatória:** login real (gabrieldco) + dados reais, cada módulo tocado,
   mobile (390px) e desktop (1280px). tsc verde NÃO basta.
8. Commit por módulo, mensagens `feat(<modulo>): três camadas mobile/desktop`.

---

## 🚀 Módulos-alvo (ordem de implementação)

> Escopo por módulo: aplicar as 3 camadas SEM redesenhar fluxo — mesmos dados,
> mesmas ações, nova apresentação. CASA e CARRO compartilham telas (recurringBills/
> maintenance/reminders) — implementar UMA vez, validar nos dois tipos.

### 1. `bills/` (recurringBills — CASA/CARRO)
- Topo: 2–3 KpiTiles (total mensal fixo, próximas a vencer, atrasadas — dado já na página).
- Lista: cards com `CardActionsMenu`, status por cor semântica + label (nunca cor sozinha).
- Filtros/período: consolidar em 1 linha + sheet no mobile (padrão da Fase C).

### 2. `maintenance/` (CASA/CARRO)
- Topo: KpiTiles (pendentes, feitas no ano, custo acumulado).
- Cards por manutenção com status; detalhe em sheet/modal existente.

### 3. `reminders/` (CASA/CARRO)
- Topo: próximo lembrete em destaque (KpiTile hero) + contagem.
- Lista em cards; vencidos em estado `state` do KpiTile/cor semântica.

### 4. `receipts/` (REFORMA/COMPRA/PESSOAL)
- Topo: KpiTiles (recebido no mês, previsto, YTD).
- Tabela → cards no mobile (`md:hidden` cards + tabela `hidden md:block`, padrão Fase D).

### 5. `cash-flow/` (REFORMA/COMPRA/PESSOAL)
- Topo: KpiTiles de entrada/saída/saldo do período usando `moneyGlance`.
- Mobile: linhas → cards. NÃO mexer no cálculo de `rollingBalance` (divergência com o
  Cockpit é bug CONHECIDO da Fase E — não "consertar" aqui, não piorar, só reapresentar).

### 6. `dashboard/` (REFORMA/COMPRA/CASA/CARRO)
- Substituir KPIs ad-hoc pelos KpiTiles canônicos; grid responsivo.
- CASA/CARRO: dashboard deve dar relance de bills+maintenance+reminders (dado que as
  páginas já têm — reusar via componentes compartilhados, não duplicar fetch).

### 7. `simulation/` — página dedicada digna (REFORMA)
- Hoje: `simulation/page.tsx` + `_components` funcionais mas fora do padrão.
- Aplicar 3 camadas: topo com resultado da simulação em KpiTile hero (+ `Delta` vs
  orçamento), cenários em cards, edição em sheet/modal.
- NÃO mudar a lógica de simulação nem os endpoints (`SimulationValue`/`Simulation`
  não têm soft-delete — nem tocar).

---

## 📁 Onde mexer

```
apps/web/src/app/projects/[projectId]/
  bills/            maintenance/       reminders/
  receipts/         cash-flow/         dashboard/        simulation/
  (cada um: page.tsx + _components/ + _lib/ próprios)
apps/web/src/components/               ← só GENERALIZAR existentes (ex.: FilterSheet
                                          genérico), com aprovação de reuso nas telas atuais
```

**NÃO tocar:** `monthly/` (Trilhas 1), Cockpit desktop (Trilha 2), `financeiro/`,
`expenses/` e `conta/` (já redesenhados), `apps/api/**`, `packages/domain` (exceto LER).

---

## ⚠️ Riscos conhecidos (não repetir cicatrizes)

- **Tailwind frágil:** não fazer swap em massa de classes; migrar componente a componente.
- **Sticky/overflow clipa tooltips** (`overflow-y-auto` + `overflow-x-visible`) — bug já
  corrigido 2×; testar todo tooltip/menu novo.
- **Nomes duplicados:** antes de nomear seção/accordion, conferir que o nome não existe
  na mesma tela (cicatriz "Quanto gastei" duplicado).
- **`useProject` é hook** — nunca no topo do módulo.
- Labels de despesa vêm de `expense-options.ts` / `getExpenseOptions(projectType)` —
  não hard-codear.

---

## ✅ Definition of Done

- [ ] 7 módulos com 3 camadas aplicadas (checklist por módulo no corpo do PR)
- [ ] 100% dos KPIs das telas tocadas usando KpiTile/Delta/moneyGlance canônicos
- [ ] Nenhum gate por tipo hard-coded (só `hasFeature`)
- [ ] CASA e CARRO validados AMBOS nas telas compartilhadas
- [ ] Piso tipográfico validado em 360/390px em cada módulo
- [ ] `cd apps/web && npx tsc --noEmit` limpo nos arquivos tocados
- [ ] Testes existentes verdes
- [ ] QA visual real: cada módulo em 390px e 1280px, com screenshots no PR
- [ ] PR único: `feat(web): Fase G — três camadas nos módulos restantes + Simulação`

## 🚫 Fora de escopo (NÃO fazer)

- Qualquer mudança de cálculo (rollingBalance, simulação, motores) — Fase E cuida
- Cockpit mobile (Trilha 1) e desktop (Trilha 2)
- `floor-plans/` (página legada >400 linhas é dívida SEPARADA — não entrar nela)
- Novos endpoints, novas features, PWA

## 📚 Leitura obrigatória antes de codar

1. Telas já redesenhadas como referência de padrão: `expenses/` (Fase B),
   `monthly/_cockpit/` (Fase C), `conta/_components/ResumoCards.tsx` (Fase D)
2. Componentes canônicos: `components/KpiTile.tsx`, `components/Delta.tsx`,
   `lib/money.ts`, `lib/colors.ts`, `components/CardActionsMenu.tsx`
3. `packages/domain/src/config/project-features.ts` + `module-navigator.ts`
4. `CLAUDE.md` (convenções + cicatrizes)
